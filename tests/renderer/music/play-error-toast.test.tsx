// @vitest-environment jsdom
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MusicPage from '../../../src/renderer/pages/Music';

/**
 * 播放失败必须看得见（QYP3-030）。
 *
 * 音乐页原本读的是「点击那一刻闭包里的 store 快照」（`useCallback([playback])`
 * 里的 playback 在 await 之后仍是旧值），而错误信息是在 await 期间写进 store
 * 的 —— 所以失败信息永远读成 null，用户点了曲目什么提示都没有。这里从页面
 * 入口钉住"失败要有 Toast"。
 */

const addToast = vi.fn();
vi.mock('../../../src/renderer/stores/toast-store', () => ({
  useToastStore: (sel: (s: { addToast: typeof addToast }) => unknown) => sel({ addToast }),
}));

const api = {
  getMusicAlbums: vi.fn(),
  getAlbumTracks: vi.fn(),
  getMusicTracks: vi.fn(),
  getMusicArtists: vi.fn(),
  getArtistAlbums: vi.fn(),
  getMusicFavorites: vi.fn(),
  setMusicFavorite: vi.fn(),
  getLibraries: vi.fn(),
  resolvePlayback: vi.fn(),
  playerLoadFile: vi.fn(),
  setMusicEngineActive: vi.fn(() => Promise.resolve({ ok: true })),
  getSettings: vi.fn(() => Promise.resolve({ ok: true, data: null })),
  getMusicLyrics: vi.fn(() => Promise.resolve({ ok: true, data: { hasLyrics: false, content: null } })),
  pushDeskLyricsState: vi.fn(() => Promise.resolve({ ok: true })),
};

vi.stubGlobal('electronAPI', api);

const track = (id: number, title: string) => ({
  id,
  source_id: 5,
  path: `${title}.flac`,
  title,
  artist: '张心杰',
  album: null,
  albumartist: '张心杰',
  track_no: id,
  disc_no: null,
  year: null,
  duration: 284,
  codec: 'flac',
  bitrate: null,
  has_cover: 1,
  has_lyrics: 1,
  favorite: 0,
});

beforeEach(() => {
  vi.clearAllMocks();
  api.getLibraries.mockResolvedValue([]);
  api.getMusicAlbums.mockResolvedValue({ ok: true, data: { albums: [] } });
  api.getMusicTracks.mockResolvedValue({ ok: true, data: { tracks: [track(13, '嘲笑')] } });
});

describe('music play failure surfacing (QYP3-030)', () => {
  it('toasts the error that was written to the store during the await', async () => {
    api.resolvePlayback.mockResolvedValue({
      ok: false,
      error: { message: '这首曲目无法播放（格式不受支持）' },
    });

    render(<MusicPage />);
    fireEvent.click(screen.getByRole('button', { name: /全部曲目/ }));
    fireEvent.click(await screen.findByText('嘲笑'));

    await waitFor(() =>
      expect(addToast).toHaveBeenCalledWith('这首曲目无法播放（格式不受支持）', 'error')
    );
    // 失败时不该把音频交给播放器
    expect(api.playerLoadFile).not.toHaveBeenCalled();
  });
});
