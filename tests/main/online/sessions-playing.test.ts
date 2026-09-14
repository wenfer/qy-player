import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * Sessions/Playing 系列回传契约：
 * - 起播必须先 POST /Sessions/Playing（Emby 缺会话的 Progress → 400，
 *   UserData 永不更新——实测教训）；
 * - Progress/Stopped 携带同一 PlaySessionId；
 * - Emby 路径带 /emby 前缀，Jellyfin 不带。
 */
const posts: Array<{ url: string; body: Record<string, unknown> }> = [];

vi.mock('axios', () => {
  const instance = {
    get: vi.fn().mockResolvedValue({ data: {} }),
    post: vi.fn().mockImplementation((url: string, body: Record<string, unknown>) => {
      posts.push({ url, body });
      return Promise.resolve({ data: {} });
    }),
    defaults: { headers: { common: {} } },
  };
  const create = vi.fn(() => instance);
  return { default: { create }, __instance: instance };
});

import { EmbyClient, JellyfinClient } from '../../../src/main/modules/online-connector';

beforeEach(() => {
  posts.length = 0;
});

describe('Sessions/Playing 回传契约', () => {
  it('起播报告 POST /Sessions/Playing，携带 PlaySessionId', async () => {
    const client = new JellyfinClient('http://jf:8096', 'key', 'user-1');
    await client.reportPlayingStart('item-1', 'ms-1', 'session-abc');
    expect(posts[0].url).toBe('/Sessions/Playing');
    expect(posts[0].body).toMatchObject({
      ItemId: 'item-1',
      PlaySessionId: 'session-abc',
      CanSeek: true,
    });
  });

  it('Progress/Stopped 携带 PlaySessionId', async () => {
    const client = new JellyfinClient('http://jf:8096', 'key', 'user-1');
    await client.reportProgress('item-1', 'ms-1', 25_000_000_000, false, false, 'DirectPlay', 'session-abc');
    expect(posts[0].url).toBe('/Sessions/Playing/Progress');
    expect(posts[0].body.PlaySessionId).toBe('session-abc');
    expect(posts[0].body.PositionTicks).toBe(25_000_000_000);
    posts.length = 0;
    await client.reportProgress('item-1', 'ms-1', 30_000_000_000, true, false, 'DirectPlay', 'session-abc');
    expect(posts[0].url).toBe('/Sessions/Playing/Stopped');
    expect(posts[0].body.PlaySessionId).toBe('session-abc');
  });

  it('Emby 路径带 /emby 前缀', async () => {
    const client = new EmbyClient('http://emby:8096', 'key', 'user-1');
    await client.reportPlayingStart('item-1', 'ms-1', 's-1');
    expect(posts[0].url).toBe('/emby/Sessions/Playing');
    await client.reportProgress('item-1', 'ms-1', 1, false, false, 'DirectPlay', 's-1');
    expect(posts[1].url).toBe('/emby/Sessions/Playing/Progress');
    expect(posts[1].body.PlaySessionId).toBe('s-1');
  });

  it('无 PlaySessionId 的 Progress/Stopped 不写字段（旧行为兼容）', async () => {
    const client = new JellyfinClient('http://jf:8096', 'key', 'user-1');
    await client.reportProgress('item-1', 'ms-1', 1, false, false);
    expect(posts[0].url).toBe('/Sessions/Playing/Progress');
    expect('PlaySessionId' in posts[0].body).toBe(false);
  });
});
