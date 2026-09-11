import { request as httpRequest } from 'http';
import { request as httpsRequest } from 'https';
import { URL } from 'url';
import { PluginError, type PluginContext, type PluginHttpRequest, type PluginHttpResponse } from '../../../shared/types/plugins';

/**
 * Narrow PluginContext (QYP2-026, plan §11.1).
 *
 * Capability contract — deliberately NOT a security sandbox. Built-ins run
 * in-process; the point is that plugin code only *uses* these narrow
 * capabilities, so review and rate/size limits are centralized here.
 *
 * Provides exactly: allowlisted/timed/rate-limited/capped HTTP, a
 * per-plugin LRU+TTL cache, a namespaced secret reader, locale/app info.
 * Provides never: db, fs, player, Electron, child_process, module loading.
 */

export interface PluginContextOptions {
  /** Secret reader bound to the host SecretStore (may return null). */
  getSecret: (namespace: string, key: string) => string | null;
  hasSecret?: (namespace: string, key: string) => boolean;
  locale?: string;
  appVersion?: string;
  /** Defaults: 8s timeout, 2 MiB cap, 1 req/s per host, 256-entry cache. */
  defaultTimeoutMs?: number;
  defaultMaxBytes?: number;
  minRequestIntervalMs?: number;
  cacheMaxEntries?: number;
  cacheTtlMs?: number;
}

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

const DEFAULTS = {
  timeoutMs: 8000,
  maxBytes: 2 * 1024 * 1024,
  minRequestIntervalMs: 1000,
  cacheMaxEntries: 256,
  cacheTtlMs: 6 * 60 * 60 * 1000,
};

/** Single HTTP request honoring absolute deadline, abort, maxBytes. */
function performRequest(url: URL, req: PluginHttpRequest, timeoutMs: number, maxBytes: number): Promise<PluginHttpResponse> {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return Promise.reject(new PluginError('NETWORK_ERROR', '不支持的协议'));
  }
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? httpsRequest : httpRequest;
    let settled = false;
    let deadlineTimer: ReturnType<typeof setTimeout>;
    let idleTimer: ReturnType<typeof setTimeout>;
    const abortSignal = req.signal;

    const onAbort = (): void => {
      request.destroy();
      settle(() => new PluginError('CANCELLED', '请求已取消'));
    };
    // Absolute deadline: socket-idle timeouts reset on trickle data, so a
    // slow-drip body could otherwise hang forever (§16.4 bounded requests).
    deadlineTimer = setTimeout(() => {
      request.destroy();
      settle(() => new PluginError('NETWORK_ERROR', `请求超时（${timeoutMs}ms 总时限）`));
    }, timeoutMs);
    const cleanup = (): void => {
      clearTimeout(deadlineTimer);
      clearTimeout(idleTimer);
      abortSignal?.removeEventListener('abort', onAbort);
    };
    function settle(fail: () => Error): void {
      if (settled) return;
      settled = true;
      cleanup();
      reject(fail());
    }
    const request = transport(
      {
        hostname: url.hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: req.method ?? 'GET',
        headers: req.headers ?? {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (chunk: Buffer) => {
          if (settled) return;
          total += chunk.length;
          if (total > maxBytes) {
            res.destroy();
            // Over-cap fails the whole request - no half-trusted bodies.
            settle(() => new PluginError('INVALID_RESPONSE', `响应超过 ${Math.round(maxBytes / 1024)} KiB 上限`));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          if (settled) return;
          settled = true;
          cleanup();
          const headers: Record<string, string> = {};
          for (const [key, value] of Object.entries(res.headers)) {
            if (typeof value === 'string') headers[key] = value;
            else if (Array.isArray(value)) headers[key] = value.join(', ');
          }
          resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks) });
        });
        res.on('error', (err) => {
          settle(() => new PluginError('NETWORK_ERROR', `响应读取失败: ${err.message}`));
        });
      }
    );
    // Socket-idle guard (secondary): resets on activity, so the absolute
    // deadline above is what actually bounds the request.
    idleTimer = setTimeout(() => {
      request.destroy();
      settle(() => new PluginError('NETWORK_ERROR', '连接空闲超时'));
    }, timeoutMs);
    abortSignal?.addEventListener('abort', onAbort, { once: true });
    request.on('error', (err) => {
      settle(() => new PluginError('NETWORK_ERROR', `网络请求失败: ${err.message}`));
    });
    request.end();
  });
}

/** SecretStore excludes ':' from namespaces/keys; encode the composite. */
export function encodePluginSecretKey(pluginId: string, key: string): string {
  return Buffer.from(`${pluginId}:${key}`, 'utf8').toString('base64url');
}

/** Build the narrow context for one plugin id. */
export function createPluginContext(pluginId: string, options: PluginContextOptions): PluginContext {
  const timeoutMs = options.defaultTimeoutMs ?? DEFAULTS.timeoutMs;
  const maxBytes = options.defaultMaxBytes ?? DEFAULTS.maxBytes;
  const minInterval = options.minRequestIntervalMs ?? DEFAULTS.minRequestIntervalMs;
  const cacheMax = options.cacheMaxEntries ?? DEFAULTS.cacheMaxEntries;
  const cacheTtl = options.cacheTtlMs ?? DEFAULTS.cacheTtlMs;

  const allowedHosts = new Set<string>();
  const lastRequestAt = new Map<string, number>();
  const cache = new Map<string, CacheEntry>();

  const sanitizeHost = (host: string): string => host.trim().toLowerCase();

  const http = {
    allowHosts(hosts: string[]): void {
      if (!Array.isArray(hosts)) return;
      for (const host of hosts) {
        if (typeof host === 'string' && host.length > 0) allowedHosts.add(sanitizeHost(host));
      }
    },
    async request(req: PluginHttpRequest): Promise<PluginHttpResponse> {
      let url: URL;
      try {
        url = new URL(req.url);
      } catch {
        throw new PluginError('INVALID_RESPONSE', 'URL 无效');
      }
      if (allowedHosts.size === 0) {
        throw new PluginError('NETWORK_ERROR', '尚未配置允许访问的主机');
      }
      if (!allowedHosts.has(sanitizeHost(url.hostname))) {
        throw new PluginError('NETWORK_ERROR', `主机 ${url.hostname} 不在允许列表中`);
      }
      if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        throw new PluginError('NETWORK_ERROR', '不支持的协议');
      }
      // Per-host rate limiting (plan §16.4 plugin budget): the slot is
      // booked BEFORE awaiting, so concurrent callers serialize instead of
      // all reading the same stale timestamp and bursting together.
      const nowMs = Date.now();
      const last = lastRequestAt.get(url.hostname) ?? 0;
      const scheduledAt = Math.max(nowMs, last);
      lastRequestAt.set(url.hostname, scheduledAt + minInterval);
      const wait = scheduledAt - nowMs;
      if (wait > 0) {
        await new Promise((resolve) => setTimeout(resolve, wait));
      }

      // Query params: only scalars; values are encoded by URL.
      const effectiveUrl = new URL(url.toString());
      if (req.query) {
        for (const [key, value] of Object.entries(req.query)) {
          if (value !== undefined) effectiveUrl.searchParams.set(key, String(value));
        }
      }
      const timeout = req.timeoutMs ?? timeoutMs;
      const cap = req.maxBytes ?? maxBytes;
      if (req.signal?.aborted) {
        throw new PluginError('CANCELLED', '请求已取消');
      }
      return performRequest(effectiveUrl, req, timeout, cap);
    },
  };

  const context: PluginContext = {
    pluginId,
    locale: options.locale ?? 'zh-CN',
    appVersion: options.appVersion ?? '',
    http,
    cache: {
      get<T>(key: string): T | undefined {
        const entry = cache.get(key);
        if (!entry) return undefined;
        if (entry.expiresAt <= Date.now()) {
          cache.delete(key);
          return undefined;
        }
        // LRU refresh.
        cache.delete(key);
        cache.set(key, entry);
        return entry.value as T;
      },
      set(key: string, value: unknown, ttlMs?: number): void {
        if (cache.has(key)) cache.delete(key);
        cache.set(key, { value, expiresAt: Date.now() + (ttlMs ?? cacheTtl) });
        while (cache.size > cacheMax) {
          const oldest = cache.keys().next();
          if (oldest.done) break;
          cache.delete(oldest.value);
        }
      },
      delete(key: string): void {
        cache.delete(key);
      },
      clear(): void {
        cache.clear();
      },
    },
    secrets: {
      // SecretStore namespaces/keys exclude ':', so the composite
      // plugin:<id>:<key> is encoded into one legal key (base64url of
      // '<id>:<key>' - reversible, collision-free, no ':' emitted).
      get(key: string): string | null {
        return options.getSecret('plugin', encodePluginSecretKey(pluginId, key));
      },
      has(key: string): boolean {
        return options.hasSecret?.('plugin', encodePluginSecretKey(pluginId, key)) ?? options.getSecret('plugin', encodePluginSecretKey(pluginId, key)) !== null;
      },
    },
  };
  return context;
}
