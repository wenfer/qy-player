// @vitest-environment jsdom
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MusicPage from '../../../src/renderer/pages/Music';

const electronAPI = {
  getMusicAlbums: vi.fn(),
  getAlbumTracks: vi.fn(),
  getMusicTracks: vi.fn(),
  // QYP3-025：来源切换会探测服务器音乐库；默认无服务器
  getLibraries: vi.fn(),
  // toast store 依赖（MusicPage 使用）
};

vi.stubGlobal('electronAPI', electronAPI);

const albums = [
  {
    albumartist: '周杰伦',
    album: '叶惠美',
    track_count: 3,
    total_duration: 800,
    year: 2003,
    cover_track_id: 12,
  },
  {
    albumartist: null,
    album: null,
    track_count: 1,
    total_duration: null,
    year: null,
    cover_track_id: null,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  electronAPI.getLibraries.mockResolvedValue([]);
  electronAPI.getMusicAlbums.mockResolvedValue({ ok: true, data: { albums } });
  electronAPI.getMusicTracks.mockResolvedValue({
    ok: true,
    data: { tracks: [{ id: 1, source_id: 1, path: 'a.mp3', title: '晴天', artist: '周杰伦', album: '叶惠美', albumartist: '周杰伦', track_no: 3, disc_no: null, year: 2003, duration: 269, codec: 'mp3', bitrate: null, has_cover: 1, has_lyrics: 1 }] },
  });
  electronAPI.getAlbumTracks.mockResolvedValue({
    ok: true,
    data: { tracks: [{ id: 1, source_id: 1, path: 'a.mp3', title: '晴天', artist: '周杰伦', album: '叶惠美', albumartist: '周杰伦', track_no: 3, disc_no: null, year: 2003, duration: 269, codec: 'mp3', bitrate: null, has_cover: 1, has_lyrics: 1 }] },
  });
});

describe('Music page (QYP3-008)', () => {
  it('shows album grid and opens album tracks', async () => {
    render(
      <MemoryRouter>
        <MusicPage />
      </MemoryRouter>
    );
    // 默认视图是「全部曲目」（QYP3-045），专辑网格要切过去
    fireEvent.click(await screen.findByText('专辑'));
    await waitFor(() => expect(screen.getByText('叶惠美')).toBeTruthy());
    expect(screen.getByText(/周杰伦 · 3 首/)).toBeTruthy();
    expect(screen.getByText('未知专辑')).toBeTruthy();
    // 点击专辑 → 曲目列表
    fireEvent.click(screen.getByText('叶惠美'));
    await waitFor(() => expect(screen.getByText('晴天')).toBeTruthy());
    expect(screen.getByText(/周杰伦 · 1 首/)).toBeTruthy();
    expect(screen.getByText('← 返回专辑')).toBeTruthy();
    // preload 调用参数
    expect(electronAPI.getAlbumTracks).toHaveBeenCalledWith('周杰伦', '叶惠美');
  });

  it('shows the all-tracks list when switching view', async () => {
    render(
      <MemoryRouter>
        <MusicPage />
      </MemoryRouter>
    );
    fireEvent.click(await screen.findByText('全部曲目'));
    await waitFor(() => expect(screen.getByText('晴天')).toBeTruthy());
    expect(electronAPI.getMusicTracks).toHaveBeenCalledWith(0, 200);
  });

  it('shows empty state when there is no music', async () => {
    // 默认视图是「全部曲目」（QYP3-045）
    electronAPI.getMusicTracks.mockResolvedValue({ ok: true, data: { tracks: [] } });
    render(
      <MemoryRouter>
        <MusicPage />
      </MemoryRouter>
    );
    await waitFor(() => expect(screen.getByText('没有曲目')).toBeTruthy());
  });
});
