import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * 歌词契约（QYP3-020）：
 * - Jellyfin 10.9+ 走 GET /Audio/{itemId}/Lyrics；
 * - 无词（空数组）、旧服务器（404）一律降级为 null，不阻塞播放；
 * - Emby 无此端点，静默降级（不发起任何请求）。
 */
const gets: string[] = [];
let nextGet: () => unknown = () => ({ data: {} });

vi.mock('axios', () => {
  const instance = {
    get: vi.fn().mockImplementation((url: string) => {
      gets.push(url);
      return Promise.resolve(nextGet());
    }),
    post: vi.fn().mockResolvedValue({ data: {} }),
    defaults: { headers: { common: {} } },
  };
  return {
    default: { create: vi.fn(() => instance), isAxiosError: (e: unknown) => (e as { isAxiosError?: boolean })?.isAxiosError === true },
    __instance: instance,
  };
});

import { EmbyClient, JellyfinClient } from '../../../src/main/modules/online-connector';

beforeEach(() => {
  gets.length = 0;
  nextGet = () => ({ data: {} });
});

describe('服务器歌词契约 (QYP3-020)', () => {
  it('Jellyfin 读取 /Audio/{itemId}/Lyrics', async () => {
    nextGet = () => ({ data: { Lyrics: [{ Text: '第一行', Start: 0 }, { Text: '第二行', Start: 10_000_000 }] } });
    const client = new JellyfinClient('http://jf:8096', 'key', 'user-1');
    const lyrics = await client.getLyrics('item-1');
    expect(gets[0]).toBe('/Audio/item-1/Lyrics');
    expect(lyrics?.Lyrics).toHaveLength(2);
    expect(lyrics?.Lyrics[1].Text).toBe('第二行');
  });

  it('空歌词数组 → null（视为无词）', async () => {
    nextGet = () => ({ data: { Lyrics: [] } });
    const client = new JellyfinClient('http://jf:8096', 'key', 'user-1');
    expect(await client.getLyrics('item-1')).toBeNull();
  });

  it('旧服务器 404 → null（不抛错）', async () => {
    nextGet = () => {
      const e = new Error('Request failed with status code 404') as Error & {
        isAxiosError: boolean;
        response: { status: number };
      };
      e.isAxiosError = true;
      e.response = { status: 404 };
      return Promise.reject(e);
    };
    const client = new JellyfinClient('http://jf:8096', 'key', 'user-1');
    await expect(client.getLyrics('item-1')).resolves.toBeNull();
  });

  it('Emby 静默降级：不发请求，返回 null', async () => {
    const client = new EmbyClient('http://emby:8096', 'key', 'user-1');
    expect(await client.getLyrics('item-1')).toBeNull();
    expect(gets).toHaveLength(0);
  });
});
