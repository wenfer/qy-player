import { createServer, type Server, type IncomingMessage } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {

  buildStreamUrl,
  createStreamProtocolHandler,
  parseStreamUrl,
  type StreamProtocolRequest,
} from '../../../src/main/modules/playback-engine/stream-protocol';
import { createStreamRouteCache } from '../../../src/main/modules/security/stream-route-cache';

/**
 * qy-stream 代理协议（QYP3-037）：主进程按 Range 转发并注入认证头。
 * 用真实上游 http server 验证字节级行为（Range 透传、认证注入、
 * accept-encoding 压制、客户端中止 → 上游断开）。
 */

let server: Server;
let port = 0;
// 上游观察到的最近一次请求
let lastUpstream: {
  url: string;
  method: string;
  headers: IncomingMessage['headers'];
  abortedEarly: boolean;
} | null = null;

beforeAll(async () => {
  server = createServer((req, res) => {
    const abortedEarlyRef = { aborted: false };
    req.on('close', () => {
      if (!res.writableEnded) abortedEarlyRef.aborted = true;
    });
    // headers 在 handler 调用前已到齐；GET 无 body 时 'end' 不保证触发，
    // 所以同步记录（abortedEarly 用 getter 延迟求值）
    lastUpstream = {
      url: req.url ?? '',
      method: req.method ?? '',
      headers: req.headers,
      get abortedEarly() {
        return abortedEarlyRef.aborted;
      },
    };
    if (req.url === '/slow') {
      // 永不主动结束：用于验证客户端中止会掐断上游
      res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
      const timer = setInterval(() => res.write(Buffer.alloc(1024, 7)), 5);
      res.on('close', () => clearInterval(timer));
      return;
    }
    const range = req.headers.range;
    res.writeHead(range ? 206 : 200, {
      'Content-Type': 'audio/flac',
      'Content-Length': 4,
      ...(range ? { 'Content-Range': 'bytes 0-3/100' } : {}),
      'Accept-Ranges': 'bytes',
      // 故意带上应被丢弃的头（Transfer-Encoding 与 Content-Length 互斥，
      // 不能同时造；whitelist 本身保证 hop-by-hop 头透不过去）
      'Content-Encoding': 'gzip',
      'Set-Cookie': 'session=secret',
    });
    res.end('data');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function makeHandler() {
  const routes = createStreamRouteCache();
  const handler = createStreamProtocolHandler({ routes });
  return { routes, handler };
}

function req(over: Partial<StreamProtocolRequest> = {}): StreamProtocolRequest {
  return { url: buildStreamUrl('a'), method: 'GET', headers: {}, ...over };
}

type Res = { statusCode?: number; headers?: Record<string, unknown>; data?: unknown; error?: number };

function call(
  handler: ReturnType<typeof createStreamProtocolHandler>,
  request: StreamProtocolRequest
): Promise<Res> {
  return new Promise((resolve) => handler(request, (response) => resolve(response as Res)));
}

describe('stream url helpers (QYP3-037)', () => {
  it('builds and parses the opaque url roundtrip', () => {
    const url = buildStreamUrl('route-1');
    expect(url).toBe('qy-stream://audio/route-1');
    expect(parseStreamUrl(url)).toBe('route-1');
    expect(parseStreamUrl('qy-stream://covers/route-1')).toBeNull();
    expect(parseStreamUrl('qy-stream://audio/route-1/extra')).toBeNull();
    expect(parseStreamUrl('http://audio/route-1')).toBeNull();
  });
});

describe('stream protocol handler (QYP3-037)', () => {
  it('forwards Range and passes 206 + range headers through honestly', async () => {
    const { routes, handler } = makeHandler();
    routes.put('a', { url: `http://127.0.0.1:${port}/song.flac` });
    const response = await call(handler, req({ headers: { range: 'bytes=0-3' } }));
    expect(response.error).toBeUndefined();
    expect(response.statusCode).toBe(206);
    expect(response.headers?.['content-range']).toBe('bytes 0-3/100');
    expect(response.headers?.['accept-ranges']).toBe('bytes');
    expect(response.headers?.['content-type']).toBe('audio/flac');
    expect(lastUpstream?.headers.range).toBe('bytes=0-3');
  });

  it('injects route auth headers upstream and never echoes them downstream', async () => {
    const { routes, handler } = makeHandler();
    routes.put('a', {
      url: `http://127.0.0.1:${port}/song.flac`,
      headers: { 'X-Emby-Token': 'secret-token' },
    });
    const response = await call(handler, req());
    expect(response.error).toBeUndefined();
    expect(lastUpstream?.headers['x-emby-token']).toBe('secret-token');
    const serialized = JSON.stringify({
      statusCode: response.statusCode,
      headers: response.headers,
    });
    expect(serialized).not.toContain('secret-token');
  });

  it('suppresses compression upstream and drops hop-by-hop headers downstream', async () => {
    const { routes, handler } = makeHandler();
    routes.put('a', { url: `http://127.0.0.1:${port}/song.flac` });
    const response = await call(handler, req());
    expect(lastUpstream?.headers['accept-encoding']).toBe('identity');
    expect(response.headers?.['content-encoding']).toBeUndefined();
    expect(response.headers?.['transfer-encoding']).toBeUndefined();
    expect(response.headers?.['connection']).toBeUndefined();
    expect(response.headers?.['set-cookie']).toBeUndefined();
  });

  it('returns an error for unknown/expired route ids without revealing which', async () => {
    const { handler } = makeHandler();
    const response = await call(handler, req({ url: buildStreamUrl('ghost') }));
    expect(response.error).toBe(-6);
    expect(response.statusCode).toBeUndefined();
  });

  it('surfaces upstream connection failures as a protocol error', async () => {
    const { routes, handler } = makeHandler();
    routes.put('a', { url: 'http://127.0.0.1:1/nope' }); // 端口 1：连接拒绝
    const response = await call(handler, req());
    expect(response.error).toBe(-2);
  });

  it('destroys the upstream request when the client aborts the stream', async () => {
    const { routes, handler } = makeHandler();
    routes.put('a', { url: `http://127.0.0.1:${port}/slow` });
    const response = await call(handler, req());
    const stream = response.data as NodeJS.ReadableStream & { destroy: () => void };
    expect(stream).toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 30)); // 让上游开始发送
    stream.destroy();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(lastUpstream?.abortedEarly).toBe(true);
  });
});
