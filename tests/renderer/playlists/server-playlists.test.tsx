// @vitest-environment jsdom
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ServerPlaylists from '../../../src/renderer/pages/Playlists/ServerPlaylists';
import { useMusicPlaybackStore } from '../../../src/renderer/stores/music-playback-store';

/**
 * 服务器歌单只读浏览（P2）：列表 → 条目 → 播放（mpv 引擎 + 服务器队列）。
 * 只读：没有任何创建/重命名/删除入口。
 */

const api = {
  getServers: vi.fn(),
  getItems: vi.fn(),
  getServerPlaylistItems: vi.fn(),
  resolvePlayback: vi.fn(),
  playerLoadFile: vi.fn(),
  playerControl: vi.fn(),
  setMusicEngineActive: vi.fn(() => Promise.resolve({ ok: true })),
  getSettings: vi.fn(() => Promise.resolve({ ok: true, data: null })),
  getMusicLyrics: vi.fn(() => Promise.resolve({ ok: true, data: { hasLyrics: false, content: null } })),
  getServerLyrics: vi.fn(() => Promise.resolve({ ok: true, data: { hasLyrics: false, content: null } })),
  pushDeskLyricsState: vi.fn(() => Promise.resolve({ ok: true })),
};

vi.stubGlobal('electronAPI', api);

beforeEach(() => {
  vi.clearAllMocks();
  useMusicPlaybackStore.setState({
    engine: null,
    current: null,
    currentSource: null,
    position: 0,
    duration: 0,
    isPlaying: false,
    queueLength: 0,
    queueIndex: 0,
    errorMessage: null,
    queueSnapshot: [],
    serverQueue: [],
    serverIndex: -1,
  });
  api.getServers.mockResolvedValue([
    { id: 1, name: '家里', type: 'jellyfin', is_active: 1 },
    { id: 2, name: '旧机', type: 'emby', is_active: 0 },
  ]);
  api.getItems.mockResolvedValue([
    { Id: 'p1', Name: '通勤', ChildCount: 2, ImageTags: {} },
  ]);
  api.getServerPlaylistItems.mockResolvedValue([
    { Id: 't1', Name: '晴天', AlbumArtist: '周杰伦', Album: '叶惠美', RunTimeTicks: 26_900_000_000, Type: 'Audio' },
    { Id: 't2', Name: '以父之名', AlbumArtist: '周杰伦', RunTimeTicks: 34_100_000_000, Type: 'Audio' },
    // 视频条目（视频歌单）：不当作音轨呈现
    { Id: 'v1', Name: '某电影', Type: 'Movie' },
  ]);
  api.resolvePlayback.mockImplementation((ref: { itemId: string }) =>
    Promise.resolve({
      ok: true,
      data: {
        url: `http://s:8096/Audio/${ref.itemId}/stream`,
        startPosition: 0,
        mediaContext: { mediaType: 'jellyfin', mediaId: ref.itemId, serverId: 1 },
      },
    })
  );
  api.playerLoadFile.mockResolvedValue(undefined);
});

describe('server playlists (P2, read-only)', () => {
  it('lists playlists from active servers only', async () => {
    render(<ServerPlaylists />);
    await waitFor(() => expect(screen.getByText('通勤')).toBeTruthy());
    expect(screen.getByText(/家里 · 2 首 · 只读/)).toBeTruthy();
    // 未激活的服务器不参与
    expect(api.getItems).toHaveBeenCalledTimes(1);
    expect(api.getItems).toHaveBeenCalledWith(
      '',
      { includeItemTypes: 'Playlist', recursive: true },
      1
    );
  });

  it('offers no editing affordance (read-only by design)', async () => {
    render(<ServerPlaylists />);
    await waitFor(() => expect(screen.getByText('通勤')).toBeTruthy());
    for (const label of ['新建', '重命名', '删除']) {
      expect(screen.queryByRole('button', { name: label })).toBeNull();
    }
  });

  it('opens a playlist, drops non-audio entries and plays via mpv', async () => {
    render(<ServerPlaylists />);
    fireEvent.click(await screen.findByText('通勤'));
    await waitFor(() => expect(api.getServerPlaylistItems).toHaveBeenCalledWith('p1', 1));
    await waitFor(() => expect(screen.getByText('以父之名')).toBeTruthy());
    expect(screen.queryByText('某电影')).toBeNull();
    expect(screen.getByText(/只读（服务器歌单在本应用内不可编辑）/)).toBeTruthy();

    fireEvent.click(screen.getByText('以父之名'));
    await waitFor(() =>
      expect(api.playerLoadFile).toHaveBeenCalledWith(
        'http://s:8096/Audio/t2/stream',
        undefined,
        undefined,
        expect.objectContaining({ serverId: 1 }),
        undefined,
        expect.anything()
      )
    );
    const state = useMusicPlaybackStore.getState();
    expect(state.engine).toBe('mpv');
    // 只有音轨进队列（视频条目不会混进来）
    expect(state.serverQueue.map((t) => t.itemId)).toEqual(['t1', 't2']);
    expect(state.serverIndex).toBe(1);
  });

  it('shows an empty state when the server has no playlists', async () => {
    api.getItems.mockResolvedValue([]);
    render(<ServerPlaylists />);
    await waitFor(() => expect(screen.getByText('服务器上没有歌单')).toBeTruthy());
  });
});
