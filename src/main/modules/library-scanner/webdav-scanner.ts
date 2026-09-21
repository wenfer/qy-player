import type { SourceAdapter, SourceEntry } from '../library-sources/types';
import type { WebDavSourceAdapter } from '../library-sources/webdav-source';
import { createLocalScanDriver, type LocalScanDriver } from './local-scanner';
import type { CatalogRepository } from '../catalog/repository';

/**
 * WebDAV scan driver (plan §6.1/§8, QYP2-014).
 *
 * Reuses the entire local pipeline (classifier, grouping, NFO enrichment,
 * availability finalization) with WebDAV-specific wiring:
 * - fingerprint prefers the ETag and degrades to size:mtime explicitly;
 * - NFO contents are read through the adapter's bounded GET (never local fs);
 * - traversal/concurrency/cancel bounds come from the shared controller
 *   (Depth 0/1 only in the adapter, concurrency 4 for webdav, plan §16.4).
 */

/** WebDAV fingerprint: ETag first, size+mtime as the explicit fallback. */
export function webdavFingerprint(entry: SourceEntry): string | undefined {
  if (entry.etag) return `etag:${entry.etag}`;
  if (entry.size !== undefined && entry.mtime !== undefined) {
    // Downgrade is intentional and visible: servers without ETags still get
    // incremental scans via Last-Modified + Content-Length (plan §6.1).
    return `nofetag:${entry.size}:${Math.floor(entry.mtime)}`;
  }
  return undefined;
}

/** Bounded body collector for the NFO reader (2 MiB cap matches NFO limit). */
async function collectBounded(
  resource: NodeJS.ReadableStream | AsyncIterable<Uint8Array>,
  maxBytes: number,
  signal?: AbortSignal,
  /** 超限报错里的资源名（NFO / 音频头部 / CUE），只为报错可读。 */
  label = 'NFO'
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  if (Symbol.asyncIterator in resource) {
    for await (const chunk of resource) {
      if (signal?.aborted) {
        const err = new Error('操作已取消');
        err.name = 'AbortError';
        throw err;
      }
      bytes += chunk.length;
      if (bytes > maxBytes) throw new Error(`${label} 响应超过 ${maxBytes} 字节上限`);
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  const stream = resource as NodeJS.ReadableStream & { destroy?: (e?: Error) => void };
  await new Promise<void>((resolve, reject) => {
    const oversized = new Error(`${label} 响应超过 ${maxBytes} 字节上限`);
    const onData = (chunk: Buffer): void => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        // Tear down first: destroy() re-emits 'error', which must not
        // double-settle the promise, so listeners are removed before.
        cleanup();
        stream.destroy?.(oversized);
        reject(oversized);
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      cleanup();
      resolve();
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    const onAbort = (): void => {
      cleanup();
      const err = new Error('操作已取消');
      err.name = 'AbortError';
      stream.destroy?.(err);
      reject(err);
    };
    function cleanup(): void {
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('error', onError);
      signal?.removeEventListener('abort', onAbort);
      clearInterval(keepalive);
    }
    // Deadline-free phase: the scan's overall bounds come from the request
    // layer; this keeps the collector interruptible instead of silent.
    const keepalive = setInterval(() => undefined, 30_000);
    keepalive.unref?.();
    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', onError);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  return Buffer.concat(chunks);
}

export function createWebDavScanDriver(deps: {
  repo: CatalogRepository;
  sourceId: number;
  /** The stored webdav adapter (credentials resolved at construction). */
  adapter: SourceAdapter;
  /** 来源用途标记（QYP3-039/041），透传给底层 driver。 */
  purpose?: 'music' | 'video';
  /** QYP3-060：封面/歌词落盘目录（与本地驱动共用同一份缓存分区）。 */
  coversDir?: string;
  lyricsDir?: string;
  /** QYP3-060：时长解析能力版本闸门（QYP3-052），语义同本地驱动。 */
  durationScanVersion?: number;
  onDurationScanVersion?: (version: number) => void;
}): LocalScanDriver {
  if (deps.adapter.kind !== 'webdav') {
    throw new Error('createWebDavScanDriver 需要 WebDAV adapter');
  }
  const adapter = deps.adapter as WebDavSourceAdapter;
  return createLocalScanDriver({
    repo: deps.repo,
    sourceId: deps.sourceId,
    purpose: deps.purpose,
    fingerprintOf: webdavFingerprint,
    coversDir: deps.coversDir,
    lyricsDir: deps.lyricsDir,
    durationScanVersion: deps.durationScanVersion,
    onDurationScanVersion: deps.onDurationScanVersion,
    readNfo: async (relativePath, signal) => {
      const resource = await adapter.open({ sourceId: deps.sourceId, relativePath }, signal);
      return collectBounded(resource.stream, 2 * 1024 * 1024, signal);
    },
    // QYP3-060：音频头部走 bounded GET——Range 0-524287 与播放解析的 range
    // 探针同款，窗口与本地驱动一致（512 KiB，ID3v2/APIC/FLAC 元数据块都在
    // 头部）。服务器忽略 Range 返回 200 全量时 collectBounded 会在窗口处
    // 抛错，由上层按"读取失败"退化文件名启发式，扫描不中断（增量跳过在
    // readAudio 之前，未变文件零成本）
    readAudio: async (entry, signal) => {
      const resource = await adapter.open(
        { sourceId: deps.sourceId, relativePath: entry.relativePath },
        signal,
        'bytes=0-524287'
      );
      return collectBounded(resource.stream, 512 * 1024, signal, '音频头部');
    },
    // QYP3-006：CUE 文本走 bounded GET（64 KiB 上限——CUE 从未这么大）
    readText: async (entry, signal) => {
      const resource = await adapter.open({ sourceId: deps.sourceId, relativePath: entry.relativePath }, signal);
      return collectBounded(resource.stream, 64 * 1024, signal, 'CUE');
    },
  });
}

// ---------------------------------------------------------------------------
// Health persistence (plan §6.1: 健康状态持久化, QYP2-014 acceptance)
// ---------------------------------------------------------------------------

export type SourceHealthState = 'ok' | 'degraded' | 'offline' | 'auth-required';

/**
 * Persist the last health observation into library_sources.options so lists
 * can show the last known state without a live probe. Only the health
 * fields are touched — other options are preserved.
 */
export function persistSourceHealth(
  repo: {
    getSource(id: number):
      | { options: string | null }
      | undefined;
    updateSource(
      id: number,
      patch: { options?: Record<string, string | number | boolean> | null }
    ): void;
  },
  sourceId: number,
  health: SourceHealthState
): void {
  const source = repo.getSource(sourceId);
  if (!source) return;
  let options: Record<string, string | number | boolean> = {};
  if (source.options) {
    try {
      const parsed: unknown = JSON.parse(source.options);
      // options must be a plain object; arrays/primitives would break the
      // merge below with a silent data loss, so they are discarded.
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        options = parsed as Record<string, string | number | boolean>;
      }
    } catch {
      options = {};
    }
  }
  options.health = health;
  options.healthCheckedAt = Math.floor(Date.now() / 1000);
  repo.updateSource(sourceId, { options });
}

/** Read the persisted health observation (undefined = never probed). */
export function readPersistedHealth(
  source: { options: string | null }
): { health: SourceHealthState; checkedAt?: number } | undefined {
  if (!source.options) return undefined;
  try {
    const options = JSON.parse(source.options) as Record<string, string | number | boolean>;
    if (typeof options.health !== 'string') return undefined;
    return {
      health: options.health as SourceHealthState,
      ...(typeof options.healthCheckedAt === 'number' ? { checkedAt: options.healthCheckedAt } : {}),
    };
  } catch {
    return undefined;
  }
}
