import { request as httpRequest } from 'http';
import { request as httpsRequest } from 'https';
import * as net from 'net';
import * as tls from 'tls';
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
  /** Non-sensitive plugin settings reader (returns latest snapshot). */
  getSettings?: () => Record<string, string | number | boolean>;
  /** Optional custom proxy URL or getter, e.g. 'http://127.0.0.1:7890'. */
  proxyUrl?: string | (() => string | null);
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

function getProxyUrlFor(url: URL, configuredProxy?: string | null): URL | null {
  const envProxy =
    configuredProxy ||
    (url.protocol === 'https:'
      ? process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy
      : process.env.HTTP_PROXY || process.env.http_proxy || process.env.ALL_PROXY || process.env.all_proxy);
  if (!envProxy) return null;
  try {
    const raw = envProxy.startsWith('http://') || envProxy.startsWith('https://') ? envProxy : `http://${envProxy}`;
    return new URL(raw);
  } catch {
    return null;
  }
}

function createTunneledTlsSocket(proxyUrl: URL, targetUrl: URL, timeoutMs: number): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const proxyPort = Number(proxyUrl.port) || (proxyUrl.protocol === 'https:' ? 443 : 80);
    const proxyHost = proxyUrl.hostname;

    const proxySocket = net.connect({
      host: proxyHost,
      port: proxyPort,
    });

    const timer = setTimeout(() => {
      proxySocket.destroy();
      reject(new PluginError('NETWORK_ERROR', `代理连接超时（${proxyHost}:${proxyPort}）`));
    }, timeoutMs);

    proxySocket.on('error', (err) => {
      clearTimeout(timer);
      reject(new PluginError('NETWORK_ERROR', `代理连接失败: ${err.message}`));
    });

    proxySocket.on('connect', () => {
      const targetPort = targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80);
      let connectReq = `CONNECT ${targetUrl.hostname}:${targetPort} HTTP/1.1\r\nHost: ${targetUrl.hostname}:${targetPort}\r\n`;
      if (proxyUrl.username || proxyUrl.password) {
        const auth = Buffer.from(
          `${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`
        ).toString('base64');
        connectReq += `Proxy-Authorization: Basic ${auth}\r\n`;
      }
      connectReq += '\r\n';
      proxySocket.write(connectReq);
    });

    let headerBuf = '';
    const onData = (chunk: Buffer): void => {
      headerBuf += chunk.toString('utf8');
      const headerEnd = headerBuf.indexOf('\r\n\r\n');
      if (headerEnd !== -1) {
        proxySocket.off('data', onData);
        clearTimeout(timer);
        const statusLine = headerBuf.split('\r\n')[0] || '';
        const statusCode = parseInt(statusLine.split(' ')[1] || '0', 10);
        if (statusCode >= 200 && statusCode < 300) {
          const tlsSocket = tls.connect({
            socket: proxySocket,
            servername: targetUrl.hostname,
          });
          tlsSocket.on('error', (err) => {
            reject(new PluginError('NETWORK_ERROR', `代理 TLS 握手失败: ${err.message}`));
          });
          resolve(tlsSocket);
        } else {
          proxySocket.destroy();
          reject(new PluginError('NETWORK_ERROR', `代理握手响应异常: ${statusLine}`));
        }
      }
    };
    proxySocket.on('data', onData);
  });
}

/** Single HTTP request honoring absolute deadline, abort, maxBytes. */
function performRequest(
  url: URL,
  req: PluginHttpRequest,
  timeoutMs: number,
  maxBytes: number,
  configuredProxy?: string | null
): Promise<PluginHttpResponse> {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return Promise.reject(new PluginError('NETWORK_ERROR', '不支持的协议'));
  }
  const proxyUrl = getProxyUrlFor(url, configuredProxy);
  return new Promise((resolve, reject) => {
    const isHttps = url.protocol === 'https:';
    const transport = isHttps ? httpsRequest : httpRequest;
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

    const headers: Record<string, string> = { ...(req.headers ?? {}) };
    let reqPath = `${url.pathname}${url.search}`;
    let reqHostname = url.hostname;
    let reqPort: number | string | undefined = url.port || undefined;

    const requestOptions: Record<string, unknown> = {
      method: req.method ?? 'GET',
      headers,
    };

    if (proxyUrl) {
      if (isHttps) {
        requestOptions.createConnection = (
          _opts: unknown,
          oncreate: (err: Error | null, socket?: tls.TLSSocket) => void
        ) => {
          createTunneledTlsSocket(proxyUrl, url, timeoutMs)
            .then((socket) => oncreate(null, socket))
            .catch((err) => oncreate(err as Error));
        };
      } else {
        reqHostname = proxyUrl.hostname;
        reqPort = proxyUrl.port || 80;
        reqPath = url.href;
        headers.Host = url.host;
        if (proxyUrl.username || proxyUrl.password) {
          const auth = Buffer.from(
            `${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`
          ).toString('base64');
          headers['Proxy-Authorization'] = `Basic ${auth}`;
        }
      }
    }

    requestOptions.hostname = reqHostname;
    requestOptions.port = reqPort;
    requestOptions.path = reqPath;

    const request = transport(requestOptions, (res) => {
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
        const resHeaders: Record<string, string> = {};
        for (const [key, value] of Object.entries(res.headers)) {
          if (typeof value === 'string') resHeaders[key] = value;
          else if (Array.isArray(value)) resHeaders[key] = value.join(', ');
        }
        resolve({ status: res.statusCode ?? 0, headers: resHeaders, body: Buffer.concat(chunks) });
      });
      res.on('error', (err) => {
        settle(() => new PluginError('NETWORK_ERROR', `响应读取失败: ${err.message}`));
      });
    });
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
      const proxyParam = typeof options.proxyUrl === 'function' ? options.proxyUrl() : options.proxyUrl;
      return performRequest(effectiveUrl, req, timeout, cap, proxyParam);
    },
  };

  const context: PluginContext = {
    pluginId,
    locale: options.locale ?? 'zh-CN',
    appVersion: options.appVersion ?? '',
    get settings() {
      return options.getSettings?.();
    },
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
