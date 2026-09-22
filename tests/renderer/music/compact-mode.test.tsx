// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import CompactPlayer from '../../../src/renderer/components/CompactPlayer';
import {
  nextPlayMode,
  playModeLabel,
  playModeOf,
  playModeState,
  useMusicPlaybackStore,
} from '../../../src/renderer/stores/music-playback-store';
import { useCompactModeStore } from '../../../src/renderer/stores/compact-mode-store';
import { useResourceStore } from '../../../src/renderer/stores/resource-store';

/**
 * 精简模式（QYP3-035）：主窗口原地缩成右上角浮窗，界面只留频谱图 + 进度 +
 * 传输键 + 播放模式 + 音量。这里钉住 UI 开关的 IPC 同步与各控件的 store 行为。
 * QYP3-068t：循环与随机合并成一个播放模式按钮，「还原窗口」只剩标题栏那一个。
 */

const api = {
  setCompactMode: vi.fn(() => Promise.resolve({ ok: true })),
  getSettings: vi.fn(() => Promise.resolve({ ok: true, data: null })),
  setSettings: vi.fn(() => Promise.resolve({ ok: true })),
  playerControl: vi.fn(() => Promise.resolve({ ok: true })),
  reportMusicProgress: vi.fn(() => Promise.resolve({ ok: true })),
  pushDeskLyricsState: vi.fn(() => Promise.resolve({ ok: true })),
  setMusicEngineActive: vi.fn(() => Promise.resolve({ ok: true })),
  getMusicLyrics: vi.fn(() => Promise.resolve({ ok: true, data: { content: null } })),
  onPlayerStateChange: vi.fn(() => () => undefined),
  onMusicSessionEnd: vi.fn(() => () => undefined),
};

vi.stubGlobal('electronAPI', api);
// jsdom 无 2D 上下文：SpectrumGraph 静默跳过绘制
HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as never;

const track = {
  id: 7,
  title: '晴天',
  artist: '周杰伦',
  album: null,
  albumartist: '周杰伦',
  duration: 269,
  url: 'qy-file://audio/1/x.mp3',
};

function seed(engine: 'webaudio' | 'mpv'): void {
  useMusicPlaybackStore.setState({
    engine,
    current: track,
    currentSource: { trackId: 7 },
    position: 30,
    duration: 269,
    isPlaying: true,
    volume: 80,
    repeat: 'off',
    shuffle: false,
    queueLength: 1,
    queueIndex: 0,
    queueSnapshot: [],
    serverQueue: [],
    serverIndex: -1,
    errorMessage: null,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  useCompactModeStore.setState({ compact: false });
  useResourceStore.setState({ pressure: 'normal', powerSave: true });
  seed('webaudio');
});

describe('compact mode store (QYP3-035)', () => {
  it('enter/exit toggle the flag and notify the main process', () => {
    useCompactModeStore.getState().enter();
    expect(useCompactModeStore.getState().compact).toBe(true);
    expect(api.setCompactMode).toHaveBeenCalledWith(true);

    useCompactModeStore.getState().exit();
    expect(useCompactModeStore.getState().compact).toBe(false);
    expect(api.setCompactMode).toHaveBeenCalledWith(false);
  });

  it('is idempotent (no duplicate IPC)', () => {
    useCompactModeStore.getState().enter();
    useCompactModeStore.getState().enter();
    expect(api.setCompactMode).toHaveBeenCalledTimes(1);
  });
});

describe('compact player helpers (QYP3-035)', () => {
  it('folds repeat + shuffle into one four-state play mode (QYP3-068t)', () => {
    expect(playModeOf('off', false)).toBe('sequence');
    expect(playModeOf('all', false)).toBe('repeat-all');
    expect(playModeOf('one', false)).toBe('repeat-one');
    // 随机优先：遗留的 shuffle + 循环叠加态一律显示成"随机"
    expect(playModeOf('all', true)).toBe('shuffle');
    expect(playModeOf('one', true)).toBe('shuffle');

    expect(nextPlayMode('sequence')).toBe('repeat-all');
    expect(nextPlayMode('repeat-all')).toBe('repeat-one');
    expect(nextPlayMode('repeat-one')).toBe('shuffle');
    expect(nextPlayMode('shuffle')).toBe('sequence');

    // 一维模式落到存储层两个字段：随机不与循环叠加
    expect(playModeState('sequence')).toEqual({ repeat: 'off', shuffle: false });
    expect(playModeState('repeat-all')).toEqual({ repeat: 'all', shuffle: false });
    expect(playModeState('repeat-one')).toEqual({ repeat: 'one', shuffle: false });
    expect(playModeState('shuffle')).toEqual({ repeat: 'off', shuffle: true });

    for (const mode of ['sequence', 'repeat-all', 'repeat-one', 'shuffle'] as const) {
      expect(playModeLabel(mode)).toBeTruthy();
    }
  });
});

describe('CompactPlayer (QYP3-035)', () => {
  it('renders the basic controls', () => {
    render(<CompactPlayer />);
    for (const label of ['上一曲', '暂停', '下一曲', '播放模式', '音量']) {
      expect(screen.getByLabelText(label)).toBeTruthy();
    }
    expect(screen.getByText(/晴天/)).toBeTruthy();
  });

  it('has only one restore entry — the graph header button is gone (QYP3-068t)', () => {
    render(<CompactPlayer />);
    // 浮窗里的「还原窗口」只保留标题栏那一个（TitleBar 的用例覆盖它的行为）
    expect(screen.queryByLabelText('还原窗口')).toBeNull();
  });

  it('pause button pauses playback', () => {
    render(<CompactPlayer />);
    fireEvent.click(screen.getByLabelText('暂停'));
    expect(useMusicPlaybackStore.getState().isPlaying).toBe(false);
  });

  it('cycles repeat → shuffle through the single play-mode button (QYP3-068t)', () => {
    render(<CompactPlayer />);
    const btn = () => screen.getByLabelText('播放模式');
    fireEvent.click(btn());
    expect(useMusicPlaybackStore.getState().repeat).toBe('all');
    expect(useMusicPlaybackStore.getState().shuffle).toBe(false);
    fireEvent.click(btn());
    expect(useMusicPlaybackStore.getState().repeat).toBe('one');
    fireEvent.click(btn());
    expect(useMusicPlaybackStore.getState().repeat).toBe('off');
    expect(useMusicPlaybackStore.getState().shuffle).toBe(true);
    fireEvent.click(btn());
    expect(useMusicPlaybackStore.getState().shuffle).toBe(false);
  });

  it('volume slider writes the store volume', () => {
    render(<CompactPlayer />);
    fireEvent.change(screen.getByLabelText('音量'), { target: { value: '35' } });
    expect(useMusicPlaybackStore.getState().volume).toBe(35);
  });

  it('seek commits to the mpv engine via playerControl', () => {
    seed('mpv');
    render(<CompactPlayer />);
    const progress = screen.getByLabelText('播放进度');
    fireEvent.change(progress, { target: { value: '120' } });
    fireEvent.mouseUp(progress);
    expect(api.playerControl).toHaveBeenCalledWith('seek', 120, 'absolute');
  });

  it('power-save toggle flips the persisted setting (QYP3-036)', async () => {
    render(<CompactPlayer />);
    const btn = screen.getByLabelText('性能保护');
    expect(btn.getAttribute('aria-pressed')).toBe('true'); // 默认开
    fireEvent.click(btn);
    await vi.waitFor(() =>
      expect(api.setSettings).toHaveBeenCalledWith('playback.powerSave', false)
    );
    expect(useResourceStore.getState().powerSave).toBe(false);
  });

  it('lyrics button toggles the overlay panel (QYP3-058)', async () => {
    render(<CompactPlayer />);
    const btn = screen.getByLabelText('歌词');
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(screen.queryByText(/还没有歌词/)).toBeNull();

    fireEvent.click(btn);
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    // LyricsPanel 渲染为 overlay（compact api 的 getMusicLyrics 返回无词）
    await waitFor(() => expect(screen.getByText(/还没有歌词/)).toBeTruthy());
    expect(screen.getByText(/还没有歌词/).closest('.backdrop-blur')?.className).toContain('top-10');

    fireEvent.click(screen.getByLabelText('关闭歌词面板'));
    expect(screen.queryByText(/还没有歌词/)).toBeNull();
    expect(screen.getByLabelText('歌词').getAttribute('aria-pressed')).toBe('false');
  });
});
