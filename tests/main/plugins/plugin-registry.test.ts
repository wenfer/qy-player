import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearRegistry,
  getPlugin,
  getPluginContext,
  listPlugins,
  registerPlugin,
  validateManifest,
} from '../../../src/main/modules/plugin-runtime/registry';
import { PluginError } from '../../../src/shared/types/plugins';
import type { MetadataProviderPlugin } from '../../../src/shared/types/plugins';

const SECRET_READER = vi.fn(() => null);

function makePlugin(over: Partial<MetadataProviderPlugin> = {}): MetadataProviderPlugin {
  return {
    manifest: {
      id: 'test-provider',
      name: '测试提供方',
      version: '1.0.0',
      apiVersion: 1,
      capability: 'metadata-provider',
    },
    search: async () => [],
    getDetails: async () => ({
      kind: 'movie',
      genres: [],
      studios: [],
      countries: [],
      actors: [],
      directors: [],
      uniqueIds: [],
      thumbs: [],
    }),
    ...over,
  };
}

const CONTEXT_OPTIONS = {
  getSecret: SECRET_READER,
  locale: 'zh-CN',
  appVersion: '1.2.0',
  minRequestIntervalMs: 10,
  defaultTimeoutMs: 500,
};

beforeEach(() => {
  clearRegistry();
  SECRET_READER.mockClear();
});

describe('validateManifest (registration-time contract)', () => {
  it('accepts a well-formed metadata-provider manifest', () => {
    const { errors } = validateManifest(makePlugin().manifest);
    expect(errors).toEqual([]);
  });

  it('rejects malformed manifests with specific reasons', () => {
    expect(validateManifest(null).errors.length).toBeGreaterThan(0);
    expect(validateManifest({}).errors.length).toBeGreaterThan(0);
    expect(validateManifest(makePlugin({ manifest: { ...makePlugin().manifest, id: 'Bad_ID' } }).manifest).errors.some((e) => e.includes('id'))).toBe(true);
    expect(validateManifest(makePlugin({ manifest: { ...makePlugin().manifest, apiVersion: 2 } }).manifest).errors.some((e) => e.includes('apiVersion'))).toBe(true);
    // Incompatible capability: 二期 only carries metadata-provider.
    expect(
      validateManifest(makePlugin({ manifest: { ...makePlugin().manifest, capability: 'scraper' as never } }).manifest).errors.some((e) =>
        e.includes('metadata-provider')
      )
    ).toBe(true);
    expect(validateManifest(makePlugin({ manifest: { ...makePlugin().manifest, version: '1.0' } }).manifest).errors.some((e) => e.includes('version'))).toBe(true);
  });
});

describe('registry', () => {
  it('registers, lists and retrieves built-ins', () => {
    const result = registerPlugin(makePlugin(), CONTEXT_OPTIONS);
    expect(result.ok).toBe(true);
    expect(listPlugins()).toHaveLength(1);
    expect(getPlugin('test-provider')?.manifest.name).toBe('测试提供方');
    expect(getPluginContext('test-provider')?.pluginId).toBe('test-provider');
  });

  it('rejects duplicate ids', () => {
    expect(registerPlugin(makePlugin(), CONTEXT_OPTIONS).ok).toBe(true);
    const second = registerPlugin(makePlugin(), CONTEXT_OPTIONS);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.errors[0]).toContain('已注册');
    expect(listPlugins()).toHaveLength(1);
  });

  it('rejects plugins without callable search/getDetails', () => {
    const noSearch = registerPlugin(makePlugin({ search: undefined as never }), CONTEXT_OPTIONS);
    expect(noSearch.ok).toBe(false);
    if (!noSearch.ok) expect(noSearch.errors.some((e) => e.includes('search'))).toBe(true);
  });

  it('gives each plugin its own context instance', () => {
    registerPlugin(makePlugin(), CONTEXT_OPTIONS);
    registerPlugin(makePlugin({ manifest: { ...makePlugin().manifest, id: 'other-provider', name: '另一个' } }), CONTEXT_OPTIONS);
    const a = getPluginContext('test-provider');
    const b = getPluginContext('other-provider');
    expect(a).not.toBe(b);
    expect(a?.pluginId).toBe('test-provider');
    expect(b?.pluginId).toBe('other-provider');
  });
});

describe('PluginContext: narrow capability contract (plan §11.1)', () => {
  it('exposes exactly the allowed capability surface (no db/fs/player/electron/child_process)', () => {
    registerPlugin(makePlugin(), CONTEXT_OPTIONS);
    const context = getPluginContext('test-provider');
    expect(context).toBeDefined();
    const keys = Object.keys(context as object).sort();
    expect(keys).toEqual(['appVersion', 'cache', 'http', 'locale', 'pluginId', 'secrets']);
    // The nested surfaces are closed too.
    expect(Object.keys(context!.http).sort()).toEqual(['allowHosts', 'request']);
    expect(Object.keys(context!.cache).sort()).toEqual(['clear', 'delete', 'get', 'set']);
    expect(Object.keys(context!.secrets).sort()).toEqual(['get', 'has']);
  });

  it('refuses hosts that were never allowlisted and empty allowlists', async () => {
    registerPlugin(makePlugin(), CONTEXT_OPTIONS);
    const context = getPluginContext('test-provider');
    if (!context) throw new Error('no context');
    await expect(context.http.request({ url: 'https://api.example.com/x' })).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
    });
    context.http.allowHosts(['api.tmdb.org']);
    await expect(context.http.request({ url: 'https://evil.example.com/x' })).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
      message: expect.stringContaining('不在允许列表'),
    });
    await expect(context.http.request({ url: 'file:///etc/passwd' })).rejects.toBeInstanceOf(PluginError);
  });

  it('caches per plugin (isolation) with LRU quota and TTL', async () => {
    registerPlugin(makePlugin(), CONTEXT_OPTIONS);
    const context = getPluginContext('test-provider');
    if (!context) throw new Error('no context');
    context.cache.set('k', 'v', 10_000);
    expect(context.cache.get('k')).toBe('v');
    context.cache.delete('k');
    expect(context.cache.get('k')).toBeUndefined();

    // Isolation: another plugin never sees these entries.
    registerPlugin(makePlugin({ manifest: { ...makePlugin().manifest, id: 'other-provider', name: '另一个' } }), CONTEXT_OPTIONS);
    const other = getPluginContext('other-provider');
    expect(other?.cache.get('k')).toBeUndefined();

    // Quota: writing beyond the cap evicts the oldest entry.
    for (let i = 0; i < 300; i += 1) context.cache.set(`key-${i}`, i);
    expect(context.cache.get('key-0')).toBeUndefined(); // evicted
    expect(context.cache.get('key-299')).toBeDefined();
  });

  it('namespaces secret reads as plugin + encoded key (SecretStore-legal)', () => {
    registerPlugin(makePlugin(), CONTEXT_OPTIONS);
    const context = getPluginContext('test-provider');
    context?.secrets.get('api-token');
    context?.secrets.has('api-token');
    const calls = SECRET_READER.mock.calls as unknown as Array<[string, string]>;
    for (const [ns, key] of calls) {
      expect(ns).toBe('plugin');
      // The encoded key must satisfy the SecretStore key charset (no ':').
      expect(key).not.toContain(':');
      expect(key).not.toMatch(/[^A-Za-z0-9_-]/);
    }
    // Reversible: decode round-trips to the composite id:key.
    const encoded = calls[0][1];
    expect(Buffer.from(encoded, 'base64url').toString('utf8')).toBe('test-provider:api-token');
    expect(context?.secrets.has('api-token')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// HTTP danger branches (§16.2): over-cap, timeout, abort, rate gate, query
// ---------------------------------------------------------------------------

import { createServer, type Server } from 'http';
import { performance } from 'perf_hooks';

describe('plugin http danger branches', () => {
  let server: Server;
  let port: number;
  // Different plugin id per test avoids the per-host rate gate cross-talk.
  let counter = 0;

  beforeEach(async () => {
    counter += 1;
    server = createServer((req, res) => {
      if (req.url?.startsWith('/big')) {
        res.setHeader('Content-Type', 'text/plain');
        res.end('x'.repeat(3 * 1024 * 1024));
        return;
      }
      if (req.url?.startsWith('/slow')) {
        setTimeout(() => res.end('late'), 3000);
        return;
      }
      if (req.url?.startsWith('/echo')) {
        res.end(`q=${new URL(req.url, 'http://x').searchParams.get('q') ?? ''}`);
        return;
      }
      res.end('ok');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function httpContext(): NonNullable<ReturnType<typeof getPluginContext>> {
    const id = `http-plugin-${counter}`;
    registerPlugin(makePlugin({ manifest: { ...makePlugin().manifest, id, name: id } }), {
      ...CONTEXT_OPTIONS,
      minRequestIntervalMs: 10,
      defaultTimeoutMs: 400,
    });
    const context = getPluginContext(id);
    if (!context) throw new Error('no context');
    context.http.allowHosts(['127.0.0.1']);
    return context;
  }

  it('rejects over-cap responses whole (no half-trusted body)', async () => {
    const context = httpContext();
    await expect(context.http.request({ url: `http://127.0.0.1:${port}/big`, maxBytes: 1024 })).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
  });

  it('enforces the absolute deadline against a slow-drip server', async () => {
    const context = httpContext();
    await expect(context.http.request({ url: `http://127.0.0.1:${port}/slow`, timeoutMs: 200 })).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
    });
  });

  it('maps abort to CANCELLED', async () => {
    const context = httpContext();
    const controller = new AbortController();
    const pending = context.http.request({
      url: `http://127.0.0.1:${port}/slow`,
      timeoutMs: 5000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('serializes per-host requests by at least the rate interval', async () => {
    const context = httpContext();
    const start = performance.now();
    await Promise.all([
      context.http.request({ url: `http://127.0.0.1:${port}/` }),
      context.http.request({ url: `http://127.0.0.1:${port}/` }),
    ]);
    const elapsed = performance.now() - start;
    // minRequestIntervalMs 10 → 2 requests take >= 10ms wall clock.
    expect(elapsed).toBeGreaterThanOrEqual(9);
  });

  it('encodes query scalars into the URL', async () => {
    const context = httpContext();
    const res = await context.http.request({
      url: `http://127.0.0.1:${port}/echo`,
      query: { q: '流浪地球', skip: undefined },
    });
    expect(res.body.toString('utf8')).toBe('q=流浪地球');
  });

  it('rejects invalid URLs before any network activity', async () => {
    const context = httpContext();
    await expect(context.http.request({ url: 'not-a-url' })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
});
