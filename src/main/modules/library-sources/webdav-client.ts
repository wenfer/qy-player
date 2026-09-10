import * as nodeHttp from 'node:http';
import * as nodeHttps from 'node:https';
import type { IncomingMessage } from 'node:http';
import { isSameOrigin } from './url-guard';
import {
  parseWebDavBaseUrl,
  normalizeServerHref,
  relativePathToRequestPath,
  type ParsedWebDavBase,
} from './url-guard';

/**
 * Bounded WebDAV HTTP client (plan §8, QYP2-012).
 *
 * Node http/https only — no new dependencies. Every request is bounded by
 * timeout, byte cap, redirect depth and retry count; 401/403 are terminal;
 * cross-origin redirects are rejected outright so Authorization never
 * crosses origins (plan §8.2).
 */

export const WEBDAV_DEFAULT_TIMEOUT_MS = 15_000;
export const WEBDAV_DEFAULT_MAX_BYTES = 8 * 1024 * 1024; // 8 MiB per response
export const WEBDAV_MAX_REDIRECTS = 3;
export const WEBDAV_MAX_RETRIES = 2;
/** PROPFIND Depth is 0 or 1 only — Depth infinity is forbidden (plan §4.2). */
export type PropfindDepth = 0 | 1;

export interface WebDavAuth {
  type: 'none' | 'basic';
  /** Resolved by the caller via SecretStore; never logged. */
  username?: string;
  password?: string;
}

export interface WebDavEntry {
  /** Decoded absolute server path (starts with the base path). */
  path: string;
  isDirectory: boolean;
  size?: number;
  /** Unix ms. */
  mtime?: number;
  etag?: string;
}

export interface WebDavResponse {
  status: number;
  headers: IncomingMessage['headers'];
  stream: IncomingMessage;
  size?: number;
  supportsRange: boolean;
}

export class WebDavError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'WebDavError';
    this.status = status;
  }
}

export interface WebDavClientOptions {
  baseUrl: string;
  auth: WebDavAuth;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
  maxRetries?: number;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const RETRYABLE_STATUSES = new Set([502, 503, 504]);

const PROPFIND_BODY =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<d:propfind xmlns:d="DAV:"><d:prop>' +
  '<d:resourcetype/><d:getcontentlength/><d:getlastmodified/><d:getetag/><d:displayname/>' +
  '</d:prop></d:propfind>';

interface RawResponse {
  status: number;
  headers: IncomingMessage['headers'];
  stream: IncomingMessage;
  /** Bytes actually buffered by this layer (small bodies only). */
  body?: Buffer;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    const err = new Error('操作已取消');
    err.name = 'AbortError';
    throw err;
  }
}

function singleRequest(
  base: ParsedWebDavBase,
  requestPath: string,
  init: { method: string; headers: Record<string, string>; body?: Buffer },
  opts: Required<Pick<WebDavClientOptions, 'timeoutMs' | 'maxBytes'>> & { signal?: AbortSignal }
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    throwIfAborted(opts.signal);
    let url: URL;
    try {
      // requestPath is a full server path (already contains the base path);
      // resolve it against the ORIGIN, not against base.url (which already
      // includes the base path — naive concatenation would double it).
      url = new URL(requestPath, new URL(base.url).origin);
    } catch (err) {
      reject(new WebDavError(`请求 URL 无效: ${err instanceof Error ? err.message : err}`));
      return;
    }
    const isHttps = url.protocol === 'https:';
    const transport = isHttps ? nodeHttps : nodeHttp;
    const options: nodeHttps.RequestOptions = {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method: init.method,
      headers: init.headers,
    };
    let settled = false;
    const settle = (err: unknown, res?: RawResponse): void => {
      if (settled) return;
      settled = true;
      if (err) reject(err instanceof Error ? err : new WebDavError(String(err)));
      else resolve(res!);
    };
    const timer = setTimeout(() => {
      req.destroy(new WebDavError(`请求超时（${opts.timeoutMs}ms）`));
    }, opts.timeoutMs);
    const abortListener = (): void => {
      req.destroy(new WebDavError('操作已取消'));
    };
    opts.signal?.addEventListener('abort', abortListener, { once: true });

    const req: nodeHttp.ClientRequest = transport.request(options, (res) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', abortListener);
      // Small bodies (PROPFIND/redirects) are buffered with a cap; large
      // media streams are passed through with byte counting by the caller.
      if (init.method === 'PROPFIND' || REDIRECT_STATUSES.has(res.statusCode ?? 0)) {
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > opts.maxBytes) {
            res.destroy(new WebDavError(`响应超过 ${opts.maxBytes} 字节上限`));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          settle(undefined, {
            status: res.statusCode ?? 0,
            headers: res.headers,
            stream: res,
            body: Buffer.concat(chunks),
          });
        });
        res.on('error', (err: Error) => {
          // Response-stream failures must not leak the deadline timer or
          // the abort listener (the response already consumed both).
          clearTimeout(timer);
          opts.signal?.removeEventListener('abort', abortListener);
          settle(err);
        });
      } else {
        settle(undefined, { status: res.statusCode ?? 0, headers: res.headers, stream: res });
      }
    });
    const fail = (err: Error): void => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', abortListener);
      settle(err);
    };
    req.on('error', fail);
    if (init.body) req.write(init.body);
    req.end();
  });
}

/** PROPFIND multistatus parsing — namespace-tolerant, strictly bounded. */
export function parseMultistatus(rawXml: string, base: ParsedWebDavBase, maxEntries: number): WebDavEntry[] {
  // Predefined-entity decoding is part of the parser contract so every
  // caller (tests included) sees the same normalization.
  const xml = decodeEntitiesMinimal(rawXml);
  if (/<!(?:[\w-]+:)?DOCTYPE/i.test(xml)) {
    throw new WebDavError('PROPFIND 响应包含 DOCTYPE，已拒绝');
  }
  if (/&(?!amp;|lt;|gt;|quot;|apos;|#)/.test(xml)) {
    // Entities are never resolved (no parser); any non-predefined entity is
    // treated as hostile input rather than expanded.
    throw new WebDavError('PROPFIND 响应包含未支持实体，已拒绝');
  }
  const entries: WebDavEntry[] = [];
  const blockRe = /<(?:[\w-]+:)?response\b[\s\S]*?<\/(?:[\w-]+:)?response>/gi;
  for (const block of xml.matchAll(blockRe)) {
    if (entries.length >= maxEntries) {
      throw new WebDavError(`目录条目超过 ${maxEntries} 上限`);
    }
    const text = block[0];
    const hrefMatch = text.match(/<(?:[\w-]+:)?href[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?href>/i);
    if (!hrefMatch) continue;
    const href = hrefMatch[1].trim();
    const isDirectory = /<(?:[\w-]+:)?collection\b[\s\S]*?\/(?:[\w-]+:)?collection>/i.test(text) ||
      /<(?:[\w-]+:)?collection\s*\/?>/i.test(text);
    const sizeRaw = text.match(/<(?:[\w-]+:)?getcontentlength[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?getcontentlength>/i);
    const size = sizeRaw ? Number.parseInt(sizeRaw[1].trim(), 10) : undefined;
    const modified = text.match(/<(?:[\w-]+:)?getlastmodified[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?getlastmodified>/i);
    let mtime: number | undefined;
    if (modified) {
      const parsed = Date.parse(modified[1].trim());
      if (Number.isFinite(parsed)) mtime = parsed;
    }
    const etag = text.match(/<(?:[\w-]+:)?getetag[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?getetag>/i);
    entries.push({
      path: normalizeServerHref(href, base),
      isDirectory,
      ...(size !== undefined && Number.isFinite(size) ? { size } : {}),
      ...(mtime !== undefined ? { mtime } : {}),
      ...(etag ? { etag: etag[1].trim().replace(/^&quot;|"&quot;|^"|\"$/g, '') } : {}),
    });
  }
  return entries;
}

function decodeEntitiesMinimal(raw: string): string {
  return raw
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

export interface WebDavClient {
  stat(relativePath: string, signal?: AbortSignal): Promise<WebDavEntry>;
  list(relativePath: string, signal?: AbortSignal): Promise<WebDavEntry[]>;
  get(relativePath: string, range?: { rangeHeader?: string; signal?: AbortSignal }): Promise<WebDavResponse>;
  readText(relativePath: string, signal?: AbortSignal): Promise<string>;
}

export function createWebDavClient(options: WebDavClientOptions): WebDavClient {
  const base = parseWebDavBaseUrl(options.baseUrl);
  const timeoutMs = options.timeoutMs ?? WEBDAV_DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? WEBDAV_DEFAULT_MAX_BYTES;
  const maxRetries = options.maxRetries ?? WEBDAV_MAX_RETRIES;

  const authHeaders = (): Record<string, string> => {
    const headers: Record<string, string> = {};
    if (options.auth.type === 'basic' && options.auth.username !== undefined) {
      // App Passwords use HTTP Basic (plan §8.1); the header value is never
      // logged anywhere in this module.
      const token = Buffer.from(`${options.auth.username}:${options.auth.password ?? ''}`).toString('base64');
      headers.Authorization = `Basic ${token}`;
    }
    return headers;
  };

  function isNetworkError(err: unknown): boolean {
    const code = (err as { code?: string } | null)?.code;
    return ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNREFUSED', 'EPIPE'].includes(code ?? '');
  }

  /**
   * Single logical request: bounded retries on network errors and 502/503/504
   * only. 4xx (incl. 401/403) and other statuses return as-is for the caller
   * to map — they are never retried (plan §8.2).
   */
  async function request(
    method: string,
    requestPath: string,
    init: { headers?: Record<string, string>; body?: Buffer; depth?: PropfindDepth; signal?: AbortSignal } = {}
  ): Promise<RawResponse> {
    const headers: Record<string, string> = { ...authHeaders(), ...init.headers };
    if (init.depth !== undefined) headers.Depth = String(init.depth);
    const signal = init.signal ?? options.signal;
    let attempt = 0;
    for (;;) {
      throwIfAborted(signal);
      let res: RawResponse;
      try {
        res = await singleRequest(base, requestPath, { method, headers, body: init.body }, { timeoutMs, maxBytes, signal });
      } catch (err) {
        if (!isNetworkError(err) || attempt >= maxRetries) throw err;
        throwIfAborted(signal);
        attempt += 1;
        await backoff(attempt, signal);
        continue;
      }
      if (RETRYABLE_STATUSES.has(res.status) && attempt < maxRetries) {
        res.stream.destroy();
        throwIfAborted(signal);
        attempt += 1;
        await backoff(attempt, signal);
        continue;
      }
      return res;
    }
  }

  async function backoff(attempt: number, callSignal: AbortSignal | undefined): Promise<void> {
    await new Promise<void>((resolve) => {
      const t = setTimeout(done, 250 * attempt);
      const onAbort = (): void => done();
      function done(): void {
        clearTimeout(t);
        callSignal?.removeEventListener('abort', onAbort);
        resolve();
      }
      callSignal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** Map statuses to errors; 401/403 are terminal (plan §8.2). */
  function assertStatus(status: number, context: string): void {
    if (status === 401) throw new WebDavError('认证失败（401）', 401);
    if (status === 403) throw new WebDavError('无访问权限（403）', 403);
    if (status === 404) throw new WebDavError('资源不存在（404）', 404);
    if (status >= 400) throw new WebDavError(`${context}失败（HTTP ${status}）`, status);
  }

  async function requestWithRedirects(
    method: string,
    requestPath: string,
    init: { headers?: Record<string, string>; body?: Buffer; depth?: PropfindDepth; signal?: AbortSignal } = {}
  ): Promise<RawResponse> {
    let currentPath = requestPath;
    for (let redirects = 0; redirects <= WEBDAV_MAX_REDIRECTS; redirects += 1) {
      const res = await request(method, currentPath, init);
      if (!REDIRECT_STATUSES.has(res.status)) {
        assertStatus(res.status, method);
        return res;
      }
      const location = res.headers.location;
      if (typeof location !== 'string' || location.length === 0) {
        throw new WebDavError('重定向缺少 Location');
      }
      // Cross-origin redirects are rejected outright (plan §8.2): the
      // Authorization header must never follow to another origin.
      let target: URL;
      try {
        target = new URL(location, new URL(base.url).origin);
      } catch {
        throw new WebDavError('重定向 Location 无法解析');
      }
      if (!isSameOrigin(target, new URL(base.url))) {
        throw new WebDavError('重定向跨源，已拒绝（凭据不跨源）');
      }
      currentPath = `${target.pathname}${target.search}`;
      if (res.body) res.body = undefined; // redirect bodies are ignored
    }
    throw new WebDavError(`重定向次数超过 ${WEBDAV_MAX_REDIRECTS} 上限`);
  }

  function entryForPath(relativePath: string, entries: WebDavEntry[]): WebDavEntry {
    // Depth-1 listings include the collection itself; directories carry
    // trailing slashes, so compare with them stripped. The request path is
    // percent-encoded; entry paths are decoded — normalize both.
    const norm = (p: string): string => {
      const stripped = p.length > 1 ? p.replace(/\/+$/, '') : p;
      try {
        return decodeURIComponent(stripped);
      } catch {
        return stripped;
      }
    };
    const selfPath = relativePathToRequestPath(relativePath, base);
    const found = entries.find((e) => norm(e.path) === norm(selfPath));
    if (!found) throw new WebDavError('PROPFIND 响应缺少自身条目');
    return found;
  }

  return {
    async stat(relativePath: string, callSignal?: AbortSignal): Promise<WebDavEntry> {
      const requestPath = relativePathToRequestPath(relativePath, base);
      const res = await requestWithRedirects('PROPFIND', requestPath, {
        depth: 0,
        headers: { 'Content-Type': 'application/xml; charset=utf-8' },
        body: Buffer.from(PROPFIND_BODY, 'utf8'),
        signal: callSignal,
      });
      assertStatus(res.status, 'PROPFIND');
      // Depth-0 responses contain exactly one entry in practice; the cap
      // tolerates sloppy servers while still bounding the parse.
      const entries = parseMultistatus(res.body ? res.body.toString('utf8') : '', base, 16);
      return entryForPath(relativePath, entries);
    },

    async list(relativePath: string, callSignal?: AbortSignal): Promise<WebDavEntry[]> {
      const requestPath = relativePathToRequestPath(relativePath, base);
      const res = await requestWithRedirects('PROPFIND', requestPath, {
        depth: 1,
        headers: { 'Content-Type': 'application/xml; charset=utf-8' },
        body: Buffer.from(PROPFIND_BODY, 'utf8'),
        signal: callSignal,
      });
      assertStatus(res.status, 'PROPFIND');
      return parseMultistatus(res.body ? res.body.toString('utf8') : '', base, 10_000);
    },

    async get(relativePath: string, range?: { rangeHeader?: string; signal?: AbortSignal }): Promise<WebDavResponse> {
      const requestPath = relativePathToRequestPath(relativePath, base);
      const headers: Record<string, string> = {};
      if (range?.rangeHeader) headers.Range = range.rangeHeader;
      const res = await requestWithRedirects('GET', requestPath, { headers, signal: range?.signal });
      const isPartial = res.status === 206;
      if (res.status !== 200 && !isPartial) {
        assertStatus(res.status, 'GET');
      }
      const contentLength = res.headers['content-length'];
      const size = typeof contentLength === 'string' ? Number.parseInt(contentLength, 10) : undefined;
      return {
        status: res.status,
        headers: res.headers,
        stream: res.stream,
        ...(size !== undefined && Number.isFinite(size) ? { size } : {}),
        supportsRange: isPartial,
      };
    },

    async readText(relativePath: string, callSignal?: AbortSignal): Promise<string> {
      const res = await this.get(relativePath, { signal: callSignal });
      const chunks: Buffer[] = [];
      let bytes = 0;
      await new Promise<void>((resolve, reject) => {
        // The body stream needs its own deadline + abort wiring: after the
        // response headers arrive, a slow/hostile server could otherwise
        // hold the connection open under the byte cap.
        // Deadline on the body phase: a stall is a failure, not a result.
        const timer = setTimeout(() => {
          res.stream.destroy(new WebDavError(`读取超时（${timeoutMs}ms）`));
          done(new WebDavError(`读取超时（${timeoutMs}ms）`));
        }, timeoutMs);
        const onAbort = (): void => {
          res.stream.destroy(new WebDavError('操作已取消'));
          done();
        };
        function done(err?: Error): void {
          clearTimeout(timer);
          callSignal?.removeEventListener('abort', onAbort);
          if (err) reject(err);
          else resolve();
        }
        callSignal?.addEventListener('abort', onAbort, { once: true });
        res.stream.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > maxBytes) {
            res.stream.destroy(new WebDavError(`响应超过 ${maxBytes} 字节上限`));
            done(new WebDavError(`响应超过 ${maxBytes} 字节上限`));
            return;
          }
          chunks.push(chunk);
        });
        res.stream.on('end', () => done());
        res.stream.on('error', (err: Error) => done(err));
      });
      return Buffer.concat(chunks).toString('utf8');
    },
  };
}
