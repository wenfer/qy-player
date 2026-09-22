// @vitest-environment jsdom
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MusicPage from '../../../src/renderer/pages/Music';
import { useMusicPlaybackStore } from '../../../src/renderer/stores/music-playback-store';

const api = {
  getLibraries: vi.fn(),
  getServers: vi.fn(),
  getItems: vi.fn(),
  resolvePlayback: vi.fn(),
  playerLoadFile: vi.fn(),
  playerControl: vi.fn(),
  setMusicEngineActive: vi.fn(),
  getSettings: vi.fn(),
  // 服务器曲目歌词在起播后拉取（QYP3-020b）
  getServerLyrics: vi.fn(),
  getMusicLyrics: vi.fn(),
  getMusicAlbums: vi.fn(),
  getMusicArtists: vi.fn(),
  getMusicTracks: vi.fn(),
  getMusicFavorites: vi.fn(),
};

vi.stubGlobal('electronAPI', api);

const albums = [
  { Id: 'al1', Name: '叶惠美', AlbumArtist: '周杰伦', ProductionYear: 2003, ImageTags: { Primary: 'tg' } },
];
const tracks = [
  { Id: 't1', Name: '晴天', AlbumArtist: '周杰伦', Album: '叶惠美', RunTimeTicks: 26_900_000_000, IndexNumber: 1 },
  { Id: 't2', Name: '以父之名', AlbumArtist: '周杰伦', Album: '叶惠美', RunTimeTicks: 34_100_000_000, IndexNumber: 2 },
];

beforeEach(() => {
  vi.clearAllMocks();
  useMusicPlaybackStore.setState({
    engine: null,
    current: null,
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
  api.getLibraries.mockResolvedValue([
    {
      serverId: 1,
      serverName: '家里',
      serverType: 'jellyfin',
      views: [
        { Id: 'v-music', Name: '音乐', CollectionType: 'music' },
        { Id: 'v-movie', Name: '电影', CollectionType: 'movies' },
      ],
    },
  ]);
  api.getServers.mockResolvedValue([
    { id: 1, name: '家里', type: 'jellyfin', base_url: 'http://s:8096', is_active: 1 },
  ]);
  api.getItems.mockImplementation((parentId: string) =>
    Promise.resolve(parentId === 'v-music' ? albums : tracks)
  );
  api.resolvePlayback.mockImplementation((ref: { itemId: string }) =>
    Promise.resolve({
      ok: true,
      data: {
        kind: 'online-direct',
        url: `http://s:8096/Audio/${ref.itemId}/stream`,
        startPosition: 0,
        mediaContext: { mediaType: 'jellyfin', mediaId: ref.itemId, serverId: 1 },
      },
    })
  );
  api.playerLoadFile.mockResolvedValue(undefined);
  api.getSettings.mockResolvedValue(null);
  api.getServerLyrics.mockResolvedValue({ ok: true, data: { hasLyrics: true, content: '[00:01.00]词' } });
  api.getMusicLyrics.mockResolvedValue({ ok: true, data: { hasLyrics: false, content: null } });
  api.getMusicAlbums.mockResolvedValue({ ok: true, data: { albums: [] } });
  api.getMusicArtists.mockResolvedValue({ ok: true, data: { artists: [] } });
  api.getMusicTracks.mockResolvedValue({ ok: true, data: { tracks: [] } });
  api.getMusicFavorites.mockResolvedValue({ ok: true, data: { tracks: [] } });
});

describe('server music browsing (QYP3-025)', () => {
  it('lists only server music views as sources', async () => {
    render(<MusicPage />);
    await waitFor(() => expect(screen.getByText('家里 · 音乐')).toBeTruthy());
    // 非音乐库（电影）不出现在来源里
    expect(screen.queryByText('家里 · 电影')).toBeNull();
    expect(screen.getByRole('button', { name: '本地 / WebDAV' })).toBeTruthy();
  });

  it('browses server albums into tracks and plays the clicked one', async () => {
    render(<MusicPage />);
    fireEvent.click(await screen.findByText('家里 · 音乐'));

    await waitFor(() => expect(api.getItems).toHaveBeenCalledWith('v-music', expect.anything(), 1));
    fireEvent.click(await screen.findByText('叶惠美'));

    await waitFor(() => expect(api.getItems).toHaveBeenCalledWith('al1', expect.anything(), 1));
    fireEvent.click(await screen.findByText('以父之名'));

    // 服务器曲目一律走 mpv 引擎（ADR-0007）
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
    expect(api.resolvePlayback).toHaveBeenCalledWith(
      { provider: 'jellyfin', serverId: 1, itemId: 't2' }
    );
    const state = useMusicPlaybackStore.getState();
    expect(state.engine).toBe('mpv');
    expect(state.serverQueue.map((t) => t.itemId)).toEqual(['t1', 't2']);
    expect(state.serverIndex).toBe(1);
    // 服务器歌词按 serverId + itemId 路由（QYP3-020b），不读本地缓存
    await waitFor(() => expect(api.getServerLyrics).toHaveBeenCalledWith(1, 't2'));
    expect(api.getMusicLyrics).not.toHaveBeenCalled();
  });

  it('advances and rewinds inside the server queue', async () => {
    render(<MusicPage />);
    fireEvent.click(await screen.findByText('家里 · 音乐'));
    fireEvent.click(await screen.findByText('叶惠美'));
    fireEvent.click(await screen.findByText('晴天'));

    await waitFor(() => expect(useMusicPlaybackStore.getState().serverIndex).toBe(0));

    await act(() => useMusicPlaybackStore.getState().next());
    await waitFor(() => expect(useMusicPlaybackStore.getState().serverIndex).toBe(1));
    expect(api.playerLoadFile).toHaveBeenLastCalledWith(
      'http://s:8096/Audio/t2/stream',
      undefined,
      undefined,
      expect.anything(),
      undefined,
      expect.anything()
    );

    await act(() => useMusicPlaybackStore.getState().prev());
    await waitFor(() => expect(useMusicPlaybackStore.getState().serverIndex).toBe(0));
    expect(api.playerLoadFile).toHaveBeenLastCalledWith(
      'http://s:8096/Audio/t1/stream',
      undefined,
      undefined,
      expect.anything(),
      undefined,
      expect.anything()
    );
  });

  it('stops at the end of the server queue instead of loading the first track', async () => {
    render(<MusicPage />);
    fireEvent.click(await screen.findByText('家里 · 音乐'));
    fireEvent.click(await screen.findByText('叶惠美'));
    fireEvent.click(await screen.findByText('以父之名'));
    await waitFor(() => expect(useMusicPlaybackStore.getState().serverIndex).toBe(1));

    await act(() => useMusicPlaybackStore.getState().next());
    expect(api.playerControl).toHaveBeenCalledWith('stop');
    expect(useMusicPlaybackStore.getState().serverIndex).toBe(1);
  });
});
