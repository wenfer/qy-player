// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import CompactPlayer, {
  nextRepeat,
  repeatLabel,
} from '../../../src/renderer/components/CompactPlayer';
import { useMusicPlaybackStore } from '../../../src/renderer/stores/music-playback-store';
import { useCompactModeStore } from '../../../src/renderer/stores/compact-mode-store';

/**
 * 精简模式（QYP3-035）：主窗口原地缩成右上角浮窗，界面只留频谱图 + 进度 +
 * 传输键 + 循环 + 音量 + 还原。这里钉住 UI 开关的 IPC 同步与各控件的 store 行为。
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
  it('cycles the repeat mode off → all → one → off', () => {
    expect(nextRepeat('off')).toBe('all');
    expect(nextRepeat('all')).toBe('one');
    expect(nextRepeat('one')).toBe('off');
  });

  it('labels the repeat mode in Chinese', () => {
    expect(repeatLabel('off')).toBe('顺序播放');
    expect(repeatLabel('all')).toBe('列表循环');
    expect(repeatLabel('one')).toBe('单曲循环');
  });
});

describe('CompactPlayer (QYP3-035)', () => {
  it('renders the basic controls', () => {
    render(<CompactPlayer />);
    for (const label of ['上一曲', '暂停', '下一曲', '循环模式', '随机播放', '音量', '还原窗口']) {
      expect(screen.getByLabelText(label)).toBeTruthy();
    }
    expect(screen.getByText(/晴天/)).toBeTruthy();
  });

  it('pause button pauses playback', () => {
    render(<CompactPlayer />);
    fireEvent.click(screen.getByLabelText('暂停'));
    expect(useMusicPlaybackStore.getState().isPlaying).toBe(false);
  });

  it('cycles the repeat mode through the store', () => {
    render(<CompactPlayer />);
    fireEvent.click(screen.getByLabelText('循环模式'));
    expect(useMusicPlaybackStore.getState().repeat).toBe('all');
    fireEvent.click(screen.getByLabelText('循环模式'));
    expect(useMusicPlaybackStore.getState().repeat).toBe('one');
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

  it('restore button exits compact mode', () => {
    useCompactModeStore.setState({ compact: true });
    render(<CompactPlayer />);
    fireEvent.click(screen.getByLabelText('还原窗口'));
    expect(useCompactModeStore.getState().compact).toBe(false);
    expect(api.setCompactMode).toHaveBeenCalledWith(false);
  });
});
