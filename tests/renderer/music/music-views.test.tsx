// @vitest-environment jsdom
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MusicPage from '../../../src/renderer/pages/Music';

const api = {
  getMusicAlbums: vi.fn(),
  getAlbumTracks: vi.fn(),
  getMusicTracks: vi.fn(),
  getMusicArtists: vi.fn(),
  getArtistAlbums: vi.fn(),
  getMusicFavorites: vi.fn(),
  setMusicFavorite: vi.fn(),
  // QYP3-025：来源切换会探测服务器音乐库；默认无服务器
  getLibraries: vi.fn(),
};

vi.stubGlobal('electronAPI', api);

const track = (id: number, title: string, favorite = 0) => ({
  id,
  source_id: 1,
  path: `/music/${id}.mp3`,
  title,
  artist: '周杰伦',
  album: '叶惠美',
  albumartist: '周杰伦',
  track_no: id,
  disc_no: null,
  year: 2003,
  duration: 260,
  codec: 'mp3',
  bitrate: null,
  has_cover: 1,
  has_lyrics: 0,
  favorite,
});

beforeEach(() => {
  vi.clearAllMocks();
  api.getLibraries.mockResolvedValue([]);
  api.getMusicAlbums.mockResolvedValue({ ok: true, data: { albums: [] } });
  api.getMusicArtists.mockResolvedValue({
    ok: true,
    data: { artists: [{ albumartist: '周杰伦', album_count: 2, track_count: 4, cover_track_id: 1 }] },
  });
  api.getArtistAlbums.mockResolvedValue({
    ok: true,
    data: { albums: [{ albumartist: '周杰伦', album: '叶惠美', track_count: 2, total_duration: 520, year: 2003, cover_track_id: 1 }] },
  });
  api.getMusicTracks.mockResolvedValue({ ok: true, data: { tracks: [track(1, '晴天')] } });
  api.getMusicFavorites.mockResolvedValue({ ok: true, data: { tracks: [track(1, '晴天', 1)] } });
  api.setMusicFavorite.mockResolvedValue({ ok: true, data: { favorite: false } });
});

describe('Music page views (QYP3-008a)', () => {
  it('shows artists and drills into one artist albums', async () => {
    render(<MusicPage />);
    fireEvent.click(screen.getByRole('button', { name: '歌手' }));
    await waitFor(() => expect(screen.getByText('周杰伦')).toBeTruthy());
    expect(screen.getByText(/2 张专辑 · 4 首/)).toBeTruthy();

    fireEvent.click(screen.getByText('周杰伦'));
    await waitFor(() => expect(api.getArtistAlbums).toHaveBeenCalledWith('周杰伦'));
    expect(screen.getByText('叶惠美')).toBeTruthy();
  });

  it('lists favorites and unfavorites optimistically', async () => {
    render(<MusicPage />);
    fireEvent.click(screen.getByRole('button', { name: '收藏' }));
    await waitFor(() => expect(screen.getByText('晴天')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: '取消收藏' }));
    await waitFor(() => expect(api.setMusicFavorite).toHaveBeenCalledWith(1, false));
    // 乐观更新：立即从收藏列表移除
    await waitFor(() => expect(screen.queryByText('晴天')).toBeNull());
  });

  it('rolls back the favorite toggle when the IPC fails', async () => {
    api.setMusicFavorite.mockResolvedValue({ ok: false });
    render(<MusicPage />);
    fireEvent.click(screen.getByRole('button', { name: '收藏' }));
    await waitFor(() => expect(screen.getByText('晴天')).toBeTruthy());

    // Toast 由 App 层统一渲染，这里只验证失败后列表回滚
    fireEvent.click(screen.getByRole('button', { name: '取消收藏' }));
    await waitFor(() => expect(api.setMusicFavorite).toHaveBeenCalledWith(1, false));
    await waitFor(() => expect(screen.getByRole('button', { name: '取消收藏' })).toBeTruthy());
  });

  it('toggles favorite from the all-tracks list', async () => {
    render(<MusicPage />);
    fireEvent.click(screen.getByRole('button', { name: '全部曲目' }));
    await waitFor(() => expect(screen.getByText('晴天')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: '收藏此曲' }));
    await waitFor(() => expect(api.setMusicFavorite).toHaveBeenCalledWith(1, true));
  });
});

/** 默认就是曲目列表（QYP3-045）：进音乐模式先看到曲目，不用再点一次 tab。 */
describe('Music page default view', () => {
  it('shows the track list without any extra click', async () => {
    render(<MusicPage />);
    await waitFor(() => expect(screen.getByText('晴天')).toBeTruthy());
    expect(api.getMusicTracks).toHaveBeenCalled();
    expect(api.getMusicAlbums).not.toHaveBeenCalled();
  });
});

/** 加载失败必须显式呈现（前端审查）：此前只弹 Toast，页面渲染成空网格。 */
describe('Music page load failure', () => {
  it('shows a retryable error state instead of an empty grid', async () => {
    api.getMusicTracks.mockResolvedValue({ ok: false });
    render(<MusicPage />);
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByText('没能加载音乐库')).toBeTruthy();
    // 不是"没有曲目"——那条文案会让人以为库真的是空的
    expect(screen.queryByText('没有曲目')).toBeNull();

    api.getMusicTracks.mockResolvedValue({ ok: true, data: { tracks: [] } });
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(screen.getByText('没有曲目')).toBeTruthy());
  });
});
