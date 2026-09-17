import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * 服务器歌单契约（P2 只读）：
 * - 条目走规范端点 `/Playlists/{id}/Items?UserId=`（Emby 多一层 `/emby`）；
 * - 顺序即歌单顺序，不做排序（用户排的顺序就是歌单的意义）；
 * - 空/缺 Items 一律返回空数组，不抛错。
 */
const gets: Array<{ url: string; params?: unknown }> = [];
let nextGet: () => unknown = () => ({ data: {} });

vi.mock('axios', () => {
  const instance = {
    get: vi.fn().mockImplementation((url: string, config?: { params?: unknown }) => {
      gets.push({ url, params: config?.params });
      return Promise.resolve(nextGet());
    }),
    post: vi.fn().mockResolvedValue({ data: {} }),
    defaults: { headers: { common: {} } },
  };
  return {
    default: {
      create: vi.fn(() => instance),
      isAxiosError: (e: unknown) => (e as { isAxiosError?: boolean })?.isAxiosError === true,
    },
    __instance: instance,
  };
});

import { EmbyClient, JellyfinClient } from '../../../src/main/modules/online-connector';

beforeEach(() => {
  gets.length = 0;
  nextGet = () => ({ data: {} });
});

describe('服务器歌单契约 (P2)', () => {
  it('Jellyfin 读取 /Playlists/{id}/Items 并带上 UserId', async () => {
    nextGet = () => ({
      data: { Items: [{ Id: 't1', Name: '晴天' }, { Id: 't2', Name: '以父之名' }] },
    });
    const client = new JellyfinClient('http://jf:8096', 'key', 'user-1');
    const items = await client.getPlaylistItems('pl-1');
    expect(gets[0].url).toBe('/Playlists/pl-1/Items');
    expect(gets[0].params).toEqual({ UserId: 'user-1' });
    expect(items.map((i) => i.Id)).toEqual(['t1', 't2']);
  });

  it('Emby 走 /emby/Playlists/{id}/Items', async () => {
    nextGet = () => ({ data: { Items: [{ Id: 't1' }] } });
    const client = new EmbyClient('http://emby:8096', 'key', 'user-1');
    const items = await client.getPlaylistItems('pl-9');
    expect(gets[0].url).toBe('/emby/Playlists/pl-9/Items');
    expect(items).toHaveLength(1);
  });

  it('缺 Items / 空歌单 → 空数组', async () => {
    const client = new JellyfinClient('http://jf:8096', 'key', 'user-1');
    expect(await client.getPlaylistItems('pl-1')).toEqual([]);
    nextGet = () => ({ data: { Items: [] } });
    expect(await client.getPlaylistItems('pl-2')).toEqual([]);
  });
});
