/**
 * 在线媒体库静态图片（海报、背景、封面等）本地磁盘缓存服务。
 * 将远程 Emby / Jellyfin 图片缓存到 <userData>/image-cache 目录下，
 * 避免每次打开都重新拉取远程网络资源，并在离线或网络断开时仍能正常显示。
 */
import { existsSync, mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import axios from 'axios';

export interface ImageCacheServiceOptions {
  cacheDir: string;
  timeoutMs?: number;
}

export class ImageCacheService {
  private readonly cacheDir: string;
  private readonly timeoutMs: number;
  private readonly inFlight = new Map<string, Promise<string | null>>();

  constructor(options: ImageCacheServiceOptions) {
    this.cacheDir = options.cacheDir;
    this.timeoutMs = options.timeoutMs ?? 8000;
    if (!existsSync(this.cacheDir)) {
      mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  getCachePath(key: string): string {
    // 强制限制 key 为纯安全文件名，杜绝任何目录穿越
    const base = key.split(/[\/\\]/).pop() || 'image';
    const safeKey = base.replace(/\.\./g, '_').replace(/[^a-zA-Z0-9._-]/g, '_');
    return join(this.cacheDir, safeKey || 'image');
  }

  isCached(key: string): boolean {
    return existsSync(this.getCachePath(key));
  }

  /**
   * 确保图片已落盘。若已存在直接返回绝对路径；
   * 若不存在则从 remoteUrl 异步下载并保存，并发请求自动合并。
   */
  async ensureImage(key: string, remoteUrl: string): Promise<string | null> {
    const targetPath = this.getCachePath(key);
    if (existsSync(targetPath)) {
      return targetPath;
    }
    if (!remoteUrl) return null;

    // 同一个图片的下载请求合并
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const promise = this.download(remoteUrl, targetPath).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, promise);
    return promise;
  }

  private async download(remoteUrl: string, targetPath: string): Promise<string | null> {
    try {
      const response = await axios.get(remoteUrl, {
        responseType: 'arraybuffer',
        timeout: this.timeoutMs,
        headers: {
          Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        },
      });
      if (response.status === 200 && response.data) {
        await writeFile(targetPath, Buffer.from(response.data));
        return targetPath;
      }
      return null;
    } catch {
      // 远端下线、404 或超时等情况静默返回 null，由上层触发占位图
      return null;
    }
  }
}
