import { beforeEach, describe, expect, it, vi } from 'vitest';
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

  it('namespaces secret reads as plugin:<id>:<key>', () => {
    registerPlugin(makePlugin(), CONTEXT_OPTIONS);
    const context = getPluginContext('test-provider');
    context?.secrets.get('api-token');
    expect(SECRET_READER).toHaveBeenCalledWith('plugin:test-provider', 'api-token');
  });
});
