import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  parseWebDavBaseUrl,
  normalizeServerHref,
  relativePathToRequestPath,
  WebDavUrlError,
} from '../../../src/main/modules/library-sources/url-guard';
import {
  createWebDavClient,
  parseMultistatus,
} from '../../../src/main/modules/library-sources/webdav-client';
import { WebDavSourceAdapter } from '../../../src/main/modules/library-sources/webdav-source';

// ---------------------------------------------------------------------------
// Mock WebDAV server
// ---------------------------------------------------------------------------

let server: Server;
let port = 0;
let lastRequest: { method: string; url: string; headers: Record<string, string>; body: string } | null = null;
/** Per-test handler; default 404. */
let handler: ((req: IncomingMessage, res: ServerResponse, body: string) => void) | null = null;

const PROPFIND_OK = (body: string): (req: IncomingMessage, res: ServerResponse, b: string) => void => {
  void body;
  return (_req, res) => {
    res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' });
    res.end(body);
  };
};

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      lastRequest = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)])),
        body,
      };
      if (handler) handler(req, res, body);
      else {
        res.writeHead(404);
        res.end('no handler');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  handler = null;
  lastRequest = null;
});

afterEach(() => {
  handler = null;
});

/** Late-bound: `port` is 0 until the server binds in beforeAll. */
const baseUrl = (): string => `http://127.0.0.1:${port}/dav`;

function client() {
  return createWebDavClient({ baseUrl: baseUrl(), auth: { type: 'none' }, timeoutMs: 1500 });
}

function clientBasic(): ReturnType<typeof createWebDavClient> {
  return createWebDavClient({
    baseUrl: baseUrl(),
    auth: { type: 'basic', username: 'user', password: 'secret-pass' },
    timeoutMs: 1500,
  });
}

const LIST_BODY = `<?xml version="1.0"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/dav/</D:href>
    <D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/Movies/</D:href>
    <D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/Movies/流浪地球%20(2019).mkv</D:href>
    <D:propstat><D:prop>
      <D:resourcetype/>
      <D:getcontentlength>452984832</D:getcontentlength>
      <D:getlastmodified>Wed, 12 Feb 2020 10:00:00 GMT</D:getlastmodified>
      <D:getetag>&quot;abc-123&quot;</D:getetag>
    </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
  </D:response>
</D:multistatus>`;

describe('url-guard', () => {
  it('accepts and normalizes valid base URLs', () => {
    const parsed = parseWebDavBaseUrl('http://example.com:5005/dav/');
    expect(parsed.basePath).toBe('/dav');
    expect(parsed.isHttps).toBe(false);
    const https = parseWebDavBaseUrl('https://example.com');
    expect(https.basePath).toBe('');
    expect(https.isHttps).toBe(true);
  });

  it('rejects userinfo, query, fragment and non-http schemes', () => {
    expect(() => parseWebDavBaseUrl('http://user:pass@example.com/dav')).toThrow(/userinfo/);
    expect(() => parseWebDavBaseUrl('http://example.com/dav?token=x')).toThrow(/query/);
    expect(() => parseWebDavBaseUrl('http://example.com/dav#frag')).toThrow(/fragment/);
    expect(() => parseWebDavBaseUrl('ftp://example.com')).toThrow(/http/);
    expect(() => parseWebDavBaseUrl('file:///etc/passwd')).toThrow(/http/);
    expect(() => parseWebDavBaseUrl('http://example.com/da v')).toThrow(/控制字符/);
    expect(() => parseWebDavBaseUrl('   ')).toThrow(/为空/);
  });

  it('decodes and contains server hrefs against the root', () => {
    const parsed = parseWebDavBaseUrl(baseUrl());
    expect(normalizeServerHref('/dav/Movies/', parsed)).toBe('/dav/Movies/');
    expect(normalizeServerHref('/dav/Movies/%E6%B5%81%E6%B5%AA.mkv', parsed)).toBe('/dav/Movies/流浪.mkv');
    expect(normalizeServerHref('/dav/a/./b/../c', parsed)).toBe('/dav/a/c');
    // Relative href joins against the base path.
    expect(normalizeServerHref('Movies/x.mkv', parsed)).toBe('/dav/Movies/x.mkv');
  });

  it('rejects traversal, double encoding, cross-origin absolute hrefs', () => {
    const parsed = parseWebDavBaseUrl(baseUrl());
    expect(() => normalizeServerHref('/dav/../secret', parsed)).toThrow(/逃逸/);
    expect(() => normalizeServerHref('/dav/%2e%2e/secret', parsed)).toThrow(/编码穿越/);
    // Double-encoded: one decode resurrects encoded dots → rejected.
    expect(() => normalizeServerHref('/dav/%252e%252e/secret', parsed)).toThrow(/双重编码/);
    expect(() => normalizeServerHref('http://evil.example.com/x', parsed)).toThrow(/跨源/);
    expect(() => normalizeServerHref('//evil.example.com/x', parsed)).toThrow(/协议相对/);
    expect(() => normalizeServerHref('/dav/a%zz', parsed)).toThrow(/百分号编码/);
  });

  it('builds encoded request paths from relative paths', () => {
    const parsed = parseWebDavBaseUrl(baseUrl());
    expect(relativePathToRequestPath('Movies/a b.mkv', parsed)).toBe('/dav/Movies/a%20b.mkv');
    expect(relativePathToRequestPath('', parsed)).toBe('/dav');
    expect(() => relativePathToRequestPath('../etc', parsed)).toThrow();
  });
});

describe('webdav client', () => {
  it('sends PROPFIND with Depth and parses the multistatus', async () => {
    handler = PROPFIND_OK(LIST_BODY);
    const c = client();
    const entries = await c.list('');
    expect(lastRequest!.method).toBe('PROPFIND');
    expect(lastRequest!.headers.depth).toBe('1');
    expect(lastRequest!.url).toBe('/dav');
    expect(entries.map((e) => e.path)).toEqual(['/dav/', '/dav/Movies/', '/dav/Movies/流浪地球 (2019).mkv']);
    const file = entries[2];
    expect(file.isDirectory).toBe(false);
    expect(file.size).toBe(452984832);
    expect(file.etag).toBe('abc-123');
    expect(file.mtime).toBe(Date.parse('Wed, 12 Feb 2020 10:00:00 GMT'));
  });

  it('basic auth sends an Authorization header', async () => {
    handler = PROPFIND_OK(LIST_BODY);
    await clientBasic().stat('');
    expect(lastRequest!.headers.authorization).toBe(
      `Basic ${Buffer.from('user:secret-pass').toString('base64')}`
    );
  });

  it('maps 401 and 403 without retrying', async () => {
    let calls = 0;
    handler = (_req, res) => {
      calls += 1;
      res.writeHead(401);
      res.end();
    };
    await expect(client().stat('')).rejects.toThrow(/401/);
    expect(calls).toBe(1);
    calls = 0;
    handler = (_req, res) => {
      calls += 1;
      res.writeHead(403);
      res.end();
    };
    await expect(client().list('')).rejects.toThrow(/403/);
    expect(calls).toBe(1);
  });

  it('retries transient 503 within bounds and then succeeds', async () => {
    let calls = 0;
    handler = (_req, res) => {
      calls += 1;
      if (calls < 3) {
        res.writeHead(503);
        res.end();
      } else {
        res.writeHead(207, { 'Content-Type': 'application/xml' });
        res.end(LIST_BODY);
      }
    };
    const entries = await client().stat('');
    expect(calls).toBe(3);
    expect(entries.path).toBe('/dav/');
  });

  it('gives up after the retry cap', async () => {
    let calls = 0;
    handler = (_req, res) => {
      calls += 1;
      res.writeHead(503);
      res.end();
    };
    await expect(client().stat('')).rejects.toThrow(/503/);
    expect(calls).toBe(3); // initial + 2 retries
  });

  it('follows same-origin redirects (Authorization stays same-origin)', async () => {
    let redirects = 0;
    handler = (_req, res) => {
      if (redirects === 0) {
        redirects += 1;
        res.writeHead(301, { Location: '/dav-moved/' });
        res.end();
      } else {
        res.writeHead(207, { 'Content-Type': 'application/xml' });
        res.end(LIST_BODY);
      }
    };
    const entries = await client().list('');
    expect(entries.length).toBeGreaterThan(0);
    expect(lastRequest!.url).toBe('/dav-moved/');
  });

  it('rejects cross-origin redirects (credentials never cross origins)', async () => {
    handler = (_req, res) => {
      res.writeHead(302, { Location: `http://127.0.0.1:${port - 1}/evil/` });
      res.end();
    };
    await expect(clientBasic().stat('')).rejects.toThrow(/跨源/);
  });

  it('caps redirect chains', async () => {
    handler = (_req, res) => {
      res.writeHead(302, { Location: '/dav/loop' });
      res.end();
    };
    await expect(client().stat('')).rejects.toThrow(/重定向次数/);
  });

  it('GET passes through Range and reports 206', async () => {
    handler = (req, res) => {
      expect(req.headers.range).toBe('bytes=100-199');
      res.writeHead(206, { 'Content-Type': 'application/octet-stream', 'Content-Length': 100 });
      res.end('x'.repeat(100));
    };
    const res = await client().get('Movies/file.mkv', { rangeHeader: 'bytes=100-199' });
    expect(res.status).toBe(206);
    expect(res.size).toBe(100);
    expect(res.supportsRange).toBe(true);
    const first = await new Promise<Buffer>((resolve) => {
      res.stream.once('data', (c: Buffer) => resolve(c));
    });
    expect(first.length).toBe(100);
  });

  it('times out against a hanging server', async () => {
    handler = () => {
      // never respond
    };
    await expect(client().stat('')).rejects.toThrow(/超时/);
  });

  it('aborts via AbortSignal', async () => {
    handler = () => {
      // never respond
    };
    const controller = new AbortController();
    const c = createWebDavClient({ baseUrl: baseUrl(), auth: { type: 'none' }, signal: controller.signal });
    const promise = c.stat('');
    controller.abort();
    await expect(promise).rejects.toThrow();
  });

  it('rejects oversized PROPFIND responses', async () => {
    handler = (_req, res) => {
      res.writeHead(207, { 'Content-Type': 'application/xml' });
      res.end(`<D:multistatus xmlns:D="DAV:">${'<D:response><D:href>/dav/x</D:href></D:response>'.repeat(50_000)}</D:multistatus>`);
    };
    await expect(client().list('')).rejects.toThrow(/上限/);
  });

  it('readText collects a small resource within the byte cap', async () => {
    handler = (_req, res) => {
      const body = '<movie/>héllo';
      res.writeHead(200, { 'Content-Type': 'text/xml', 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
    };
    const text = await client().readText('Movies/a.nfo');
    expect(text).toBe('<movie/>héllo');
  });

  it('readText aborts and respects the deadline while streaming', async () => {
    // Slow drip under the byte cap: deadline (1500ms) must cut it off.
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      const t = setInterval(() => res.write('a'.repeat(10)), 200);
      res.on('close', () => clearInterval(t));
    };
    await expect(client().readText('Movies/slow.txt')).rejects.toThrow(/超时/);
  });

  it('fails with a clear error when the Depth-0 response lacks the self entry', async () => {
    handler = (_req, res) => {
      res.writeHead(207, { 'Content-Type': 'application/xml' });
      res.end('<D:multistatus xmlns:D="DAV:"></D:multistatus>');
    };
    await expect(client().stat('')).rejects.toThrow(/缺少自身条目/);
  });

  it('rejects hostile multistatus payloads', () => {
    const parsed = parseWebDavBaseUrl(baseUrl());
    expect(() => parseMultistatus('<!DOCTYPE x><D:multistatus/>', parsed, 10)).toThrow(/DOCTYPE/);
    expect(() => parseMultistatus('<D:multistatus><D:href>&xxe;</D:href></D:multistatus>', parsed, 10)).toThrow(/实体/);
    // Escape sequences in hrefs must be contained.
    expect(() =>
      parseMultistatus(
        '<D:multistatus><D:response><D:href>/dav/%2e%2e/passwd</D:href></D:response></D:multistatus>',
        parsed,
        10
      )
    ).toThrow(/编码穿越/);
  });
});

describe('webdav source adapter', () => {
  it('lists entries with relative paths, sizes and etags', async () => {
    handler = PROPFIND_OK(LIST_BODY);
    const adapter = WebDavSourceAdapter.fromSource(3, baseUrl(), null);
    const entries: Array<{ relativePath: string; isDirectory: boolean; size?: number; etag?: string }> = [];
    for await (const entry of adapter.list('', new AbortController().signal)) {
      entries.push(entry);
    }
    expect(entries.map((e) => e.relativePath)).toEqual(['Movies/', 'Movies/流浪地球 (2019).mkv']);
    expect(entries[1].size).toBe(452984832);
    expect(entries[1].etag).toBe('abc-123');
    expect(entries[0].isDirectory).toBe(true);
  });

  it('exposes explicit capabilities (canDelete always false in phase 2)', async () => {
    handler = PROPFIND_OK(LIST_BODY);
    const adapter = WebDavSourceAdapter.fromSource(3, baseUrl(), null);
    const caps = await adapter.testConnection(new AbortController().signal);
    // The fixture's root entry declares no ETag → honest false; Range stays
    // optimistic until the per-file 206 probe (plan §8.1).
    expect(caps).toEqual({ canSeek: true, canDelete: false, supportsEtag: false, supportsRange: true });
  });

  it('stats single resources with Depth 0', async () => {
    handler = PROPFIND_OK(LIST_BODY);
    const adapter = WebDavSourceAdapter.fromSource(3, baseUrl(), null);
    const stat = await adapter.stat({ sourceId: 3, relativePath: 'Movies/流浪地球 (2019).mkv' }, new AbortController().signal);
    expect(lastRequest!.headers.depth).toBe('0');
    expect(stat.size).toBe(452984832);
    expect(stat.supportsRange).toBe(true);
  });

  it('rejects contract-violating base URLs at construction', () => {
    expect(() => WebDavSourceAdapter.fromSource(3, 'http://user@x/dav', null)).toThrow(WebDavUrlError);
  });
});
