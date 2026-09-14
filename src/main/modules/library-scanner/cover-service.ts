/**
 * 封面提取管线（QYP3-005，计划 §5）。
 *
 * 优先级：内嵌 picture（ID3v2 APIC / FLAC PICTURE / m4a covr）→
 * mpv 单帧导出兜底（0.29/0.32 一致性留实机 spike 验证）→ 无图占位。
 *
 * 磁盘布局：<coversDir>/<trackId>.<ext>；covers 属派生缓存（可再生成），
 * 注册为 sweepable 分区（mtime-LRU），被清扫后由按需再生成兜底。
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CacheManager } from '../cache/cache-manager';

export interface ExtractedCover {
  /** 相对 coversDir 的文件名（不含目录），如 "12.jpg"。 */
  file: string;
  bytes: number;
}

/** MIME/格式 → 扩展名（只认常见三种；其余统一按 img 存字节）。 */
function extOf(mimeOrFlags: string | number | undefined): string {
  if (typeof mimeOrFlags === 'string') {
    if (mimeOrFlags.includes('jpeg') || mimeOrFlags.includes('jpg')) return 'jpg';
    if (mimeOrFlags.includes('png')) return 'png';
  }
  if (mimeOrFlags === 13) return 'png';
  if (mimeOrFlags === 14) return 'jpg';
  return 'jpg';
}

function be32(buf: Uint8Array, offset: number): number {
  return ((buf[offset] << 24) | (buf[offset + 1] << 16) | (buf[offset + 2] << 8) | buf[offset + 3]) >>> 0;
}

function synchsafe(buf: Uint8Array, offset: number): number {
  return (
    ((buf[offset] & 0x7f) << 21) |
    ((buf[offset + 1] & 0x7f) << 14) |
    ((buf[offset + 2] & 0x7f) << 7) |
    (buf[offset + 3] & 0x7f)
  );
}

/** 从头部缓冲区提取第一个内嵌封面字节；无图返回 null。 */
export function extractCoverBytes(buf: Buffer): { ext: string; data: Buffer } | null {
  try {
    // ID3v2 APIC
    if (buf.length > 10 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
      const major = buf[3];
      const tagSize = synchsafe(buf, 6);
      const limit = Math.min(10 + tagSize, buf.length);
      let pos = 10;
      while (pos + (major === 2 ? 6 : 10) <= limit) {
        let id: string;
        let size: number;
        if (major === 2) {
          id = String.fromCharCode(buf[pos], buf[pos + 1], buf[pos + 2]);
          size = (buf[pos + 3] << 16) | (buf[pos + 4] << 8) | buf[pos + 5];
          pos += 6;
        } else {
          id = String.fromCharCode(buf[pos], buf[pos + 1], buf[pos + 2], buf[pos + 3]);
          size = major === 4 ? synchsafe(buf, pos + 4) : be32(buf, pos + 4);
          pos += 10;
        }
        if (!/^[A-Z0-9]+$/.test(id) || size <= 0 || pos + size > limit) break;
        if ((id === 'APIC' || id === 'PIC') && pos + size <= buf.length) {
          const frame = buf.subarray(pos, pos + size);
          const enc = frame[0];
          // v2.2 PIC: enc(1) + 3字节 image format；v2.3+: enc + mime
          let p: number;
          let mime: string;
          if (id === 'PIC' || major === 2) {
            mime = String.fromCharCode(frame[1], frame[2], frame[3]);
            p = 5;
          } else {
            let q = 1;
            while (q < frame.length && frame[q] !== 0) q++;
            mime = new TextDecoder('latin1').decode(frame.subarray(1, q));
            p = q + 1;
          }
          p++; // picture type
          const descTerm = enc === 1 || enc === 2 ? 2 : 1;
          while (p + descTerm <= frame.length && !(frame[p] === 0 && frame[p + descTerm - 1] === 0)) p += descTerm;
          p += descTerm;
          const data = frame.subarray(p);
          if (data.length > 8) {
            return { ext: extOf(mime), data: Buffer.from(data) };
          }
        }
        pos += size;
      }
    }
    // FLAC PICTURE（遍历块；kind=6）
    if (buf.length > 4 && buf[0] === 0x66 && buf[1] === 0x4c && buf[2] === 0x61 && buf[3] === 0x43) {
      let pos = 4;
      while (pos + 4 <= buf.length) {
        const header = buf[pos];
        const last = (header & 0x80) !== 0;
        const kind = header & 0x7f;
        const size = (buf[pos + 1] << 16) | (buf[pos + 2] << 8) | buf[pos + 3];
        pos += 4;
        if (pos + size > buf.length) break;
        if (kind === 6 && size > 32) {
          const body = buf.subarray(pos, pos + size);
          let p = 8; // type(4) + mimeLen(4)
          const mimeLen = be32(body, 4);
          p = 8 + mimeLen;
          const mime = new TextDecoder('latin1').decode(body.subarray(8, 8 + mimeLen));
          const descLen = be32(body, p);
          p += 4 + descLen;
          p += 16; // w/h/depth/colors
          const dataLen = be32(body, p);
          p += 4;
          const data = body.subarray(p, p + dataLen);
          if (data.length > 8) {
            return { ext: extOf(mime), data: Buffer.from(data) };
          }
        }
        pos += size;
        if (last) break;
      }
    }
    // m4a covr（顶层 atom 树 → moov.udta.meta.ilst）
    {
      let found: { ext: string; data: Buffer } | null = null;
      const readAtoms = (start: number, end: number, wantIlst: boolean): void => {
        let p = start;
        while (p + 8 <= end) {
          const size = be32(buf, p);
          if (size < 8 || p + size > end) break;
          const type = String.fromCharCode(buf[p + 4], buf[p + 5], buf[p + 6], buf[p + 7]);
          if (type === 'moov') readAtoms(p + 8, p + size, wantIlst);
          else if (type === 'udta') readAtoms(p + 8, p + size, wantIlst);
          else if (type === 'meta') readAtoms(p + 12, p + size, wantIlst); // version/flags 4B
          else if (type === 'ilst') {
            let q = p + 8;
            const ilstEnd = p + size;
            while (q + 8 <= ilstEnd) {
              const isz = be32(buf, q);
              if (isz < 8 || q + isz > ilstEnd) break;
              const itype = String.fromCharCode(buf[q + 4], buf[q + 5], buf[q + 6], buf[q + 7]);
              if (itype === 'covr') {
                const dsize = be32(buf, q + 8);
                const flags = be32(buf, q + 16) & 0xffffff;
                const data = buf.subarray(q + 24, q + 8 + dsize);
                if (data.length > 8) found = { ext: extOf(flags), data: Buffer.from(data) };
              }
              q += isz;
            }
          }
          p += size;
        }
      };
      readAtoms(0, buf.length, false);
      if (found) return found;
    }
  } catch {
    return null; // 容错：任何解析异常都当无封面
  }
  return null;
}

/**
 * 扫描期封面落盘：有内嵌封面时写 <coversDir>/<trackId>.<ext> 并返回
 * 相对文件名；无内嵌封面（或写入失败）返回 null（占位图由渲染层处理）。
 */
export async function saveCoverFromTags(
  trackId: number,
  headBuf: Buffer,
  coversDir: string
): Promise<ExtractedCover | null> {
  const cover = extractCoverBytes(headBuf);
  if (!cover) return null;
  const file = `${trackId}.${cover.ext}`;
  try {
    await writeFile(join(coversDir, file), cover.data);
    return { file, bytes: cover.data.length };
  } catch {
    return null;
  }
}

/** 注册 covers 缓存分区（QYP3-005；可清扫——派生数据可再生成）。 */
export function registerCoversPartition(cacheManager: CacheManager, coversDir: string): void {
  cacheManager.register({
    id: 'covers',
    description: '音乐内嵌封面提取结果（可再生成）',
    rootDir: coversDir,
    quota: { maxBytes: 64 * 1024 * 1024 },
    sweepable: true,
  });
}

/**
 * mpv 单帧导出兜底（计划 §5 spike 项）：对无内嵌封面的音频用 mpv
 * `--vo=image` 导出第一帧（部分格式如 WMA 的 art 帧可被 mpv 解出）。
 * 失败（旧版 mpv 无 image vo/无法解码）返回 false，调用方用占位图。
 * 0.29/0.32 行为一致性属实机验证项（TARGET-VERIFY），失败不阻塞。
 */
export async function exportCoverWithMpv(
  mpvPath: string,
  audioPath: string,
  destPath: string,
  signal?: AbortSignal
): Promise<boolean> {
  const { spawn } = await import('node:child_process');
  return new Promise<boolean>((resolve) => {
    const child = spawn(
      mpvPath,
      [
        '--no-terminal',
        '--vo=image',
        '--vo-image-format=jpg',
        '--frames=1',
        '--start=0.1',
        `--vo-image-outdir=${destPath}`,
        '--ao=null',
        audioPath,
      ],
      { stdio: ['ignore', 'ignore', 'ignore'], signal }
    );
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
    // 兜底超时：15s（probe 预算外的独立硬顶）
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(false);
    }, 15000);
    child.on('close', () => clearTimeout(timer));
  });
}
