// @vitest-environment jsdom
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MusicMiniBar, { resolveMode } from '../../../src/renderer/components/MusicMiniBar';
import { useMusicPlaybackStore } from '../../../src/renderer/stores/music-playback-store';
import { useSleepTimerStore } from '../../../src/renderer/stores/sleep-timer-store';
import { useCompactModeStore } from '../../../src/renderer/stores/compact-mode-store';

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
  getSettings: vi.fn((_key: string): Promise<{ ok: boolean; data: unknown }> =>
    Promise.resolve({ ok: true, data: null })
  ),
  setSettings: vi.fn(() => Promise.resolve({ ok: true })),
  pushDeskLyricsState: vi.fn(() => Promise.resolve({ ok: true })),
  setMusicEngineActive: vi.fn(() => Promise.resolve({ ok: true })),
  setCompactMode: vi.fn(() => Promise.resolve({ ok: true })),
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
  // getSettings 的实现会被单个用例按 key 改写，这里恢复默认，避免串味
  api.getSettings.mockImplementation((_key: string) =>
    Promise.resolve({ ok: true, data: null })
  );
  useCompactModeStore.setState({ compact: false });
  useSleepTimerStore.setState({ active: false, minutes: null, expiresAt: null, remainingMs: null });
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

describe('visualizer mode resolution (QYP3-050)', () => {
  it('auto picks spectrum for every engine (mpv now has an offline spectrum)', () => {
    expect(resolveMode('auto')).toBe('spectrum');
    expect(resolveMode('spectrum')).toBe('spectrum');
    expect(resolveMode('waveform')).toBe('waveform'); // 仍是显式可选项
    expect(resolveMode('off')).toBeNull();
  });
});

describe('mini bar play-mode button (QYP3-068u)', () => {
  function mountPlaying(): void {
    useMusicPlaybackStore.setState({ engine: 'mpv', current: serverTrack, isPlaying: true });
    render(<MusicMiniBar />);
  }

  it('has one merged play-mode button instead of separate repeat + shuffle', async () => {
    mountPlaying();
    await screen.findByText('以父之名');
    // 循环与随机合并（QYP3-068t/068u）：播放条与浮窗同一套控件
    expect(screen.queryByLabelText('循环模式')).toBeNull();
    expect(screen.queryByLabelText('随机播放')).toBeNull();

    const btn = screen.getByLabelText('播放模式');
    expect(btn.getAttribute('title')).toBe('顺序播放');
    fireEvent.click(btn);
    expect(useMusicPlaybackStore.getState().repeat).toBe('all');
    expect(screen.getByLabelText('播放模式').getAttribute('title')).toBe('列表循环');
  });
});

describe('mini bar spectrum toggle (QYP3-048)', () => {
  function mountPlaying(): void {
    useMusicPlaybackStore.setState({ engine: 'mpv', current: serverTrack, isPlaying: true });
    render(<MusicMiniBar />);
  }

  it('hides the spectrum on click and remembers the choice', async () => {
    mountPlaying();
    await screen.findByText('以父之名');
    expect(document.querySelector('canvas')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('隐藏频谱'));
    await waitFor(() => expect(document.querySelector('canvas')).toBeNull());
    expect(api.setSettings).toHaveBeenCalledWith('playback.showSpectrum', false);
    expect(screen.getByLabelText('显示频谱')).toBeTruthy();
  });

  it('shows it again from the same button', async () => {
    mountPlaying();
    await screen.findByText('以父之名');
    fireEvent.click(screen.getByLabelText('隐藏频谱'));
    await waitFor(() => expect(document.querySelector('canvas')).toBeNull());
    fireEvent.click(screen.getByLabelText('显示频谱'));
    await waitFor(() => expect(api.setSettings).toHaveBeenCalledWith('playback.showSpectrum', true));
    expect(document.querySelector('canvas')).toBeTruthy();
  });

  it('starts hidden when the persisted choice says so', async () => {
    api.getSettings.mockImplementation((key: string) =>
      Promise.resolve({ ok: true, data: key === 'playback.showSpectrum' ? false : null })
    );
    mountPlaying();
    await screen.findByText('以父之名');
    await waitFor(() => expect(screen.getByLabelText('显示频谱')).toBeTruthy());
    expect(document.querySelector('canvas')).toBeNull();
  });
});

describe('mini bar playback layout (QYP3-049)', () => {
  function mountPlaying(): void {
    useMusicPlaybackStore.setState({
      engine: 'webaudio',
      current: localTrack,
      isPlaying: true,
      duration: 200,
      position: 50,
    });
    render(<MusicMiniBar />);
  }

  it('keeps the spectrum and the progress bar as two separate rows', async () => {
    mountPlaying();
    await screen.findByText('晴天');
    // 频谱（canvas）与进度条（role=slider）同时存在，互不替代
    expect(document.querySelector('canvas')).toBeTruthy();
    const slider = screen.getByRole('slider', { name: /播放进度/ });
    expect(slider).toBeTruthy();
    expect(slider.getAttribute('aria-valuenow')).toBe('50');
    // 进度条不是夹在按钮之间的窄条：它与按钮行是兄弟节点，独占一行
    expect(slider.querySelector('button')).toBeNull();
    expect(slider.previousElementSibling?.textContent).toContain('晴天');
    expect(slider.nextElementSibling?.querySelector('button')).toBeTruthy();
  });

  it('seeks by clicking the progress bar', async () => {
    mountPlaying();
    await screen.findByText('晴天');
    const seek = vi.spyOn(useMusicPlaybackStore.getState(), 'seek');
    // jsdom 没有布局：给进度轨道一个可用宽度
    HTMLDivElement.prototype.getBoundingClientRect = vi.fn(
      () => ({ left: 0, width: 200, right: 200, top: 0, bottom: 6, height: 6, x: 0, y: 0, toJSON: () => ({}) })
    ) as never;
    const slider = screen.getByRole('slider', { name: /播放进度/ });
    fireEvent.click(slider, { clientX: 100 });
    // 200 宽的中点 → 50% → 100s
    expect(seek).toHaveBeenCalledWith(100);
  });

  it('seeks with the keyboard (arrows / Home)', async () => {
    mountPlaying();
    await screen.findByText('晴天');
    const seek = vi.spyOn(useMusicPlaybackStore.getState(), 'seek');
    const slider = screen.getByRole('slider', { name: /播放进度/ });
    fireEvent.keyDown(slider, { key: 'ArrowRight' }); // 50 + 5
    expect(seek.mock.lastCall?.[0]).toBeCloseTo(55, 5);
    fireEvent.keyDown(slider, { key: 'ArrowLeft' }); // 50 - 5
    expect(seek.mock.lastCall?.[0]).toBeCloseTo(45, 5);
    fireEvent.keyDown(slider, { key: 'Home' });
    expect(seek.mock.lastCall?.[0]).toBeCloseTo(0, 5);
  });

  it('does not squeeze the buttons (no shrinking classes on the control row)', async () => {
    mountPlaying();
    await screen.findByText('晴天');
    const buttons = Array.from(document.querySelectorAll('button'));
    expect(buttons.length).toBeGreaterThan(5);
    // 圆形/方形按钮被压扁成椭圆的根因是允许压缩：所有按钮都必须是 flex-shrink-0
    for (const b of buttons) {
      expect(b.className).toContain('flex-shrink-0');
    }
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

  it('enters compact mode from the mini bar (QYP3-035)', async () => {
    useMusicPlaybackStore.setState({ engine: 'mpv', current: serverTrack, isPlaying: true });
    render(<MusicMiniBar />);
    await waitFor(() => expect(screen.getByText('以父之名')).toBeTruthy());
    fireEvent.click(screen.getByLabelText('精简模式'));
    await waitFor(() => expect(api.setCompactMode).toHaveBeenCalledWith(true));
  });

  it('renders nothing once the music session has ended', async () => {
    const { container } = render(<MusicMiniBar />);
    // 挂载后的设置/收藏读取完成后再断言，避免 act 噪声
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());
    expect(container.firstChild).toBeNull();
    expect(container.querySelector('canvas')).toBeNull();
  });

  it('shows the sleep countdown chip and cancels it on click', async () => {
    useMusicPlaybackStore.setState({ engine: 'webaudio', current: localTrack, isPlaying: true });
    useSleepTimerStore.setState({
      active: true,
      minutes: 30,
      expiresAt: Date.now() + 12 * 60_000,
      remainingMs: 12 * 60_000,
    });
    render(<MusicMiniBar />);
    const chip = await screen.findByLabelText('取消睡眠定时');
    expect(chip.textContent).toContain('12:00');

    vi.spyOn(useSleepTimerStore.getState(), 'setMinutes').mockResolvedValue(undefined);
    fireEvent.click(chip);
    expect(useSleepTimerStore.getState().setMinutes).toHaveBeenCalledWith(0);
  });
});
