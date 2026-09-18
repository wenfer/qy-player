/**
 * qy-stream 代理协议（QYP3-037）。
 *
 * 服务器（Jellyfin/Emby）与 WebDAV 的音频直链需要认证，而渲染层的 `<audio>`
 * 既无法注入请求头，跨源媒体经 `createMediaElementSource` 还会因非 CORS-clean
 * 输出静音——所以音频必须经主进程代理，才能在内置引擎（Web Audio）里拿到真
 * 频谱/真波形/均衡器。
 *
 * 形态：渲染层只拿到 `qy-stream://audio/<opaqueId>`，目标 URL 与认证头存在
 * `StreamRouteCache` 里，永不跨 IPC。一个 `<audio>` 播放一首歌会发多次 Range
 * 请求（起播 + 每次 seek），所以路由是**可重复读取**的。
 *
 * 为什么不用 axios / Electron net：它们会透明解压并改写 `Content-Length`，
 * 而字节代理必须逐字节一致 —— 这里用裸 `node:http(s)`，并向上游声明
 * `Accept-Encoding: identity`、向下游不透传 `content-encoding`。
 *
 * 与 `qy-file://` 的关系：`qy-file` 用 `registerFileProtocol` 注册（只接受文件
 * 路径），且其 `audio/` 分支的安全语义是「只服务 local 包含校验内的文件」——
 * 服务器/WebDAV 永不在那里解析。新 scheme 保持这条边界清晰。
 */

import { protocol } from 'electron';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import type { StreamRouteCache } from '../security/stream-route-cache';

export const STREAM_SCHEME = 'qy-stream';
const HOST_SEGMENT = 'audio';

/** 渲染层可见的播放 URL；id 由主进程 randomUUID 生成，不可猜测。 */
export function buildStreamUrl(routeId: string): string {
  return `${STREAM_SCHEME}://${HOST_SEGMENT}/${routeId}`;
}

/**
 * 手工切片而非 `new URL()`：standard scheme 会把第二段当 host，路径段的
 * 编码处理在 Electron 各版本间有差异（沿用 qy-file 的做法最稳）。
 */
export function parseStreamUrl(rawUrl: string): string | null {
  const prefix = `${STREAM_SCHEME}://${HOST_SEGMENT}/`;
  if (typeof rawUrl !== 'string' || !rawUrl.startsWith(prefix)) return null;
  const id = rawUrl.slice(prefix.length);
  if (!id || id.includes('/') || id.includes('?') || id.includes('#')) return null;
  return id;
}

/** 下游透传的上游响应头白名单（Range/缓存相关，其余一律丢弃）。 */
const RESPONSE_HEADER_WHITELIST = [
  'content-type',
  'content-length',
  'content-range',
  'accept-ranges',
  'cache-control',
  'last-modified',
  'etag',
];

/** HTTP 头名大小写不敏感（Electron 通常已小写，但不做假设）。 */
function headerOf(headers: Record<string, string>, name: string): string | undefined {
  if (headers[name] !== undefined) return headers[name];
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key];
  }
  return undefined;
}

function pickResponseHeaders(headers: IncomingHttpHeaders): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const name of RESPONSE_HEADER_WHITELIST) {
    const value = headers[name];
    // content-encoding / transfer-encoding / connection / set-cookie 有意不转发：
    // 前者会与未解压的字节数矛盾，后者属于上游会话管理。
    if (value !== undefined) out[name] = value;
  }
  return out;
}

export type StreamProtocolCallback = (
  response: ProtocolResponseLike | NodeJS.ReadableStream
) => void;
type ProtocolResponseLike = {
  error?: number;
  statusCode?: number;
  headers?: Record<string, string | string[]>;
  data?: NodeJS.ReadableStream;
};

export interface StreamProtocolRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
}

export type StreamProtocolHandler = (
  request: StreamProtocolRequest,
  callback: StreamProtocolCallback
) => void;

export interface StreamProtocolDeps {
  routes: StreamRouteCache;
}

/**
 * 协议处理器（独立可测）：解析路由 → 裸 http(s) 转发 → 原样回传状态码与
 * Range 相关头。任何失败都返回 error 而不是「200 + 错误正文」——后者会被
 * Chromium 当成损坏媒体。
 */
export function createStreamProtocolHandler(deps: StreamProtocolDeps): StreamProtocolHandler {
  return (request, callback) => {
    const id = parseStreamUrl(request.url);
    const route = id ? deps.routes.get(id) : undefined;
    if (!route) {
      // 不区分「不存在」与「已过期」：不给探测者任何信息
      callback({ error: -6 }); // net::ERR_FILE_NOT_FOUND
      return;
    }

    let target: URL;
    try {
      target = new URL(route.url);
    } catch {
      callback({ error: -2 }); // net::ERR_FAILED
      return;
    }

    const headers: Record<string, string> = {
      ...route.headers,
      // 字节代理必须拿未压缩正文，否则 Content-Length 与实体不再一致
      'accept-encoding': 'identity',
    };
    const range = headerOf(request.headers ?? {}, 'range');
    if (range) headers.range = range;
    const accept = headerOf(request.headers ?? {}, 'accept');
    if (accept) headers.accept = accept;
    const ifRange = headerOf(request.headers ?? {}, 'if-range');
    if (ifRange) headers['if-range'] = ifRange;

    const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
    let responded = false;
    const upstream = send(target, {
      method: request.method === 'HEAD' ? 'HEAD' : 'GET',
      headers,
    });

    upstream.on('response', (res: IncomingMessage) => {
      responded = true;
      // 已交出响应流：此后上游的错误不能再 callback（Electron 只接受一次）
      res.on('error', () => {
        // 流中断由 Electron 侧感知；这里仅避免未捕获的 error 事件
      });
      callback({
        statusCode: res.statusCode ?? 200,
        headers: pickResponseHeaders(res.headers),
        data: res,
      });
      // 客户端中止（换曲/seek/关窗）→ 关闭上游 socket，避免连接与带宽泄漏
      res.on('close', () => {
        if (!res.readableEnded) upstream.destroy();
      });
    });

    upstream.on('error', () => {
      if (responded) return;
      responded = true;
      callback({ error: -2 });
    });

    upstream.end();
  };
}

/** app.whenReady() 内调用（scheme 须先经 registerSchemesAsPrivileged 声明）。 */
export function registerStreamProtocol(deps: StreamProtocolDeps): void {
  protocol.registerStreamProtocol(
    STREAM_SCHEME,
    createStreamProtocolHandler(deps) as Parameters<typeof protocol.registerStreamProtocol>[1]
  );
}
