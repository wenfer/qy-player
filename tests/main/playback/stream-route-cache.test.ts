import { describe, expect, it } from 'vitest';
import { createStreamRouteCache } from '../../../src/main/modules/security/stream-route-cache';

/**
 * qy-stream 路由表（QYP3-037）：与单次消费的 StreamHeaderCache 相对，
 * 这里必须可反复读取（一首歌多次 Range 请求），且支持滑动 TTL。
 */
describe('stream route cache (QYP3-037)', () => {
  it('get is non-consuming: repeated reads return the same route', () => {
    const cache = createStreamRouteCache();
    cache.put('a', { url: 'http://up/stream', headers: { 'X-Emby-Token': 'tok' } });
    const first = cache.get('a');
    const second = cache.get('a');
    expect(first).toBeDefined();
    expect(second).toBe(first);
    expect(cache.size()).toBe(1);
  });

  it('missing ids return undefined without leaking state', () => {
    const cache = createStreamRouteCache();
    expect(cache.get('ghost')).toBeUndefined();
    cache.put('a', { url: 'http://up/a' });
    expect(cache.get('ghost')).toBeUndefined();
    expect(cache.get('a')).toBeDefined();
  });

  it('expires entries after ttlMs via injected clock', () => {
    let now = 1_000_000;
    const cache = createStreamRouteCache({ ttlMs: 60_000, now: () => now });
    cache.put('a', { url: 'http://up/a' });
    expect(cache.get('a')).toBeDefined();
    now += 59_999;
    expect(cache.get('a')).toBeDefined(); // 59_999ms < ttl：仍存活（且续期）
    now += 60_001; // 距上次命中 60_001ms ≥ ttl：过期
    expect(cache.get('a')).toBeUndefined();
    expect(cache.size()).toBe(0);
  });

  it('slides the ttl on every hit (long tracks survive)', () => {
    let now = 1_000_000;
    const cache = createStreamRouteCache({ ttlMs: 60_000, now: () => now });
    cache.put('a', { url: 'http://up/a' });
    // 每次命中都续期：总跨度远超 ttl 仍可读
    for (let i = 0; i < 20; i += 1) {
      now += 50_000;
      expect(cache.get('a')).toBeDefined();
    }
  });

  it('evicts the least-recently-used entry at maxEntries', () => {
    let now = 1_000_000;
    const cache = createStreamRouteCache({ maxEntries: 2, now: () => now });
    cache.put('a', { url: 'http://up/a' });
    cache.put('b', { url: 'http://up/b' });
    expect(cache.get('a')).toBeDefined(); // a 变为最近使用
    now += 1;
    cache.put('c', { url: 'http://up/c' }); // 淘汰 b（不是 a）
    expect(cache.get('a')).toBeDefined();
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBeDefined();
  });

  it('re-put replaces the entry and refreshes its timestamp', () => {
    let now = 1_000_000;
    const cache = createStreamRouteCache({ ttlMs: 60_000, now: () => now });
    cache.put('a', { url: 'http://up/old' });
    now += 30_000;
    cache.put('a', { url: 'http://up/new' });
    now += 50_000;
    expect(cache.get('a')?.url).toBe('http://up/new');
  });

  it('headers default to an empty object', () => {
    const cache = createStreamRouteCache();
    cache.put('a', { url: 'http://up/a' });
    expect(cache.get('a')?.headers).toEqual({});
  });
});
