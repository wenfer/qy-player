// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MusicMiniBar from '../../../src/renderer/components/MusicMiniBar';
import { useMusicPlaybackStore } from '../../../src/renderer/stores/music-playback-store';

/**
 * 迷你控制条可见性（QYP3-026）：
 * - 音乐会话（任一引擎）期间显示；无音乐会话时完全不渲染
 *   （否则切到视频后音乐条会一直挂在画面上）；
 * - 服务器曲目不在本地库 → 收藏按钮禁用。
 */

const api = {
  onPlayerStateChange: vi.fn(() => () => undefined),
  onMusicSessionEnd: vi.fn(() => () => undefined),
  onMusicCommand: vi.fn(() => () => undefined),
  getMusicFavorites: vi.fn(() => Promise.resolve({ ok: true, data: { tracks: [] } })),
  getSettings: vi.fn(() => Promise.resolve({ ok: true, data: null })),
  pushDeskLyricsState: vi.fn(() => Promise.resolve({ ok: true })),
  setMusicEngineActive: vi.fn(() => Promise.resolve({ ok: true })),
};

vi.stubGlobal('electronAPI', api);

// jsdom 无 2D 上下文：显式返回 null（Visualizer 静默跳过，且不打印
// jsdom 的 "Not implemented" 噪音）
HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as never;

const localTrack = {
  id: 7,
  title: '晴天',
  artist: '周杰伦',
  album: null,
  albumartist: '周杰伦',
  duration: 269,
  url: 'qy-file://audio/1/x.mp3',
};

const serverTrack = { ...localTrack, id: 0, title: '以父之名', url: 'http://s:8096/Audio/t2/stream' };

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
});

describe('music mini bar visibility (QYP3-026)', () => {
  it('renders for the mpv engine (server music) with the waveform strip', async () => {
    useMusicPlaybackStore.setState({
      engine: 'mpv',
      current: serverTrack,
      isPlaying: true,
      duration: 269,
      position: 10,
      serverQueue: [
        {
          trackId: 0,
          sourceId: 0,
          serverId: 1,
          provider: 'jellyfin',
          itemId: 't2',
          title: '以父之名',
          artist: '周杰伦',
          albumartist: '周杰伦',
          duration: 269,
          path: '',
          codec: null,
        },
      ],
      serverIndex: 0,
    });
    render(<MusicMiniBar />);
    await waitFor(() => expect(screen.getByText('以父之名')).toBeTruthy());
    expect(screen.getByLabelText('下一曲')).toBeTruthy();
    expect(screen.getByLabelText('歌词')).toBeTruthy();
    // 拾音器波形（mpv 无频谱数据 → 波形模式）
    expect(document.querySelector('canvas')).toBeTruthy();
  });

  it('disables the favorite button for server tracks but keeps it for local ones', async () => {
    useMusicPlaybackStore.setState({ engine: 'mpv', current: serverTrack, isPlaying: true });
    const { unmount } = render(<MusicMiniBar />);
    await waitFor(() => expect(screen.getByText('以父之名')).toBeTruthy());
    expect((screen.getByLabelText('收藏此曲') as HTMLButtonElement).disabled).toBe(true);
    unmount();

    useMusicPlaybackStore.setState({ engine: 'webaudio', current: localTrack, isPlaying: true });
    render(<MusicMiniBar />);
    await waitFor(() => expect(screen.getByText('晴天')).toBeTruthy());
    expect((screen.getByLabelText('收藏此曲') as HTMLButtonElement).disabled).toBe(false);
  });

  it('renders nothing once the music session has ended', async () => {
    const { container } = render(<MusicMiniBar />);
    // 挂载后的设置/收藏读取完成后再断言，避免 act 噪声
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());
    expect(container.firstChild).toBeNull();
    expect(container.querySelector('canvas')).toBeNull();
  });
});
