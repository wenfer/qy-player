import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SecretStore } from '../../../src/main/modules/security/secret-store';
import { PluginConfigService, secretFingerprint, secretStorageKey } from '../../../src/main/modules/plugin-runtime/config-service';

// Fake SecretStore: in-memory map, ':'-rejecting keys like the real one.
function makeStore(): {
  store: {
    setSecret: (ns: string, key: string, value: string) => void;
    getSecret: (ns: string, key: string) => string | null;
    hasSecret: (ns: string, key: string) => boolean;
    deleteSecret: (ns: string, key: string) => void;
  };
  data: Map<string, string>;
} {
  const data = new Map<string, string>();
  const guard = (ns: string, key: string) => {
    if (ns.includes(':') || key.includes(':')) throw new Error('非法命名空间/键');
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(ns)) throw new Error('非法命名空间');
  };
  return {
    data,
    store: {
      setSecret: (ns, key, value) => {
        guard(ns, key);
        data.set(`${ns}|${key}`, value);
      },
      getSecret: (ns, key) => {
        guard(ns, key);
        return data.get(`${ns}|${key}`) ?? null;
      },
      hasSecret: (ns, key) => {
        guard(ns, key);
        return data.has(`${ns}|${key}`);
      },
      deleteSecret: (ns, key) => {
        guard(ns, key);
        data.delete(`${ns}|${key}`);
      },
    },
  };
}

let kv: Map<string, string>;
let store: ReturnType<typeof makeStore>;
let service: PluginConfigService;
let probe: ReturnType<typeof vi.fn>;

beforeEach(() => {
  kv = new Map();
  store = makeStore();
  probe = vi.fn(async () => ({ ok: true, retryable: false, message: 'ok' }));
  const partial = store.store;
  const fullStore = partial as unknown as SecretStore;
  service = new PluginConfigService({
    store: fullStore,
    getConfig: (key) => kv.get(key),
    setConfig: (key, value) => kv.set(key, value),
    probe,
  });
});

describe('PluginConfigService (QYP2-027)', () => {
  it('persists enabled/priority/settings in app_config (no secrets)', () => {
    service.setConfig('tmdb', { enabled: true, priority: 5, settings: { locale: 'zh-CN' } });
    const config = service.getConfig('tmdb');
    expect(config).toEqual({ enabled: true, priority: 5, settings: { locale: 'zh-CN' } });
    // The raw KV payload must not contain secret-grade keys.
    const raw = kv.get('plugin.config.tmdb') ?? '';
    expect(raw).not.toContain('api-token');
    expect(raw).not.toContain('secret');
  });

  it('rejects secret-grade keys smuggled through settings', () => {
    expect(() => service.setConfig('tmdb', { settings: { 'API-TOKEN': 'leak' } })).toThrow(/secret/);
  });

  it('clamps invalid priorities instead of persisting them', () => {
    service.setConfig('tmdb', { priority: -5 });
    expect(service.getConfig('tmdb').priority).toBe(100);
  });

  it('stores secrets under the SecretStore-legal encoding, write-only', () => {
    service.setSecret('tmdb', 'api-token', 's3cret-value');
    // The encoded key contains no ':' (SecretStore charset contract).
    const encoded = secretStorageKey('tmdb', 'api-token');
    expect(encoded).not.toContain(':');
    // Reversible: the PluginContext reader finds it.
    expect(service.readSecret('tmdb', 'api-token')).toBe('s3cret-value');
    // hasSecret reports presence without exposing the value.
    expect(service.hasSecret('tmdb', 'api-token')).toBe(true);
  });

  it('fingerprint identifies the secret without revealing it', () => {
    expect(secretFingerprint('abc')).not.toContain('abc');
    expect(secretFingerprint('abc')).toBe(secretFingerprint('abc'));
    expect(secretFingerprint('abc')).not.toBe(secretFingerprint('abd'));
  });

  it('deletes secrets', () => {
    service.setSecret('tmdb', 'api-token', 'v');
    service.deleteSecret('tmdb', 'api-token');
    expect(service.hasSecret('tmdb', 'api-token')).toBe(false);
  });

  it('validates secret keys and values', () => {
    expect(() => service.setSecret('tmdb', 'bad:key', 'v')).toThrow(/键名/);
    expect(() => service.setSecret('tmdb', 'api-token', '')).toThrow(/值/);
    expect(() => service.setSecret('tmdb', 'api-token', 'x'.repeat(4097))).toThrow(/值/);
  });

  it('health derives auth-required when unconfigured (§11.3)', async () => {
    service.setConfig('tmdb', { enabled: true });
    const health = await service.checkHealth('tmdb');
    expect(health.status).toBe('auth-required');
    expect(health.retryable).toBe(false);
  });

  it('health reports disabled for off plugins', async () => {
    const health = await service.checkHealth('tmdb');
    expect(health.status).toBe('disabled');
    expect(probe).not.toHaveBeenCalled();
  });

  it('health uses the probe when configured and caches until config changes', async () => {
    service.setConfig('tmdb', { enabled: true });
    service.setSecret('tmdb', 'api-token', 'v');
    const first = await service.checkHealth('tmdb');
    expect(first.status).toBe('ready');
    expect(probe).toHaveBeenCalledTimes(1);
    await service.checkHealth('tmdb');
    expect(probe).toHaveBeenCalledTimes(1); // cached
    service.setConfig('tmdb', { priority: 1 }); // cache invalidation
    await service.checkHealth('tmdb');
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('probe failures map to a distinct retryable error (not auth-required)', async () => {
    service.setConfig('tmdb', { enabled: true });
    service.setSecret('tmdb', 'api-token', 'v');
    probe.mockRejectedValueOnce(new Error('网络故障'));
    const health = await service.checkHealth('tmdb');
    expect(health.status).toBe('error');
    expect(health.retryable).toBe(true);
    // Failures are NOT cached: the retry actually re-runs the probe.
    probe.mockResolvedValueOnce({ ok: true, retryable: false, message: 'ok' });
    const retried = await service.checkHealth('tmdb');
    expect(retried.status).toBe('ready');
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('settings guard normalizes keys and rejects nesting', () => {
    expect(() => service.setConfig('tmdb', { settings: { ' api-token ': 'leak' } })).toThrow(/secret/);
    expect(() => service.setConfig('tmdb', { settings: { 'ＡＰＩ-token': 'leak' } })).toThrow(/secret/);
    expect(() => service.setConfig('tmdb', { settings: { nested: { inner: 1 } as unknown as string } })).toThrow(/嵌套/);
  });
});
