// @vitest-environment jsdom
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MusicSettings from '../../../src/renderer/pages/Settings/MusicSettings';
import { useSleepTimerStore, formatRemaining } from '../../../src/renderer/stores/sleep-timer-store';
import { useMusicPlaybackStore } from '../../../src/renderer/stores/music-playback-store';

/**
 * 睡眠定时（P2）：设置页档位 + 剩余时间；到点由主进程暂停 mpv，
 * renderer 引擎音乐靠 ON_EXPIRED 事件暂停（只有我们在放时才动）。
 */

const getSettings = vi.fn();
const setSettings = vi.fn();
const getSleepTimer = vi.fn();
const setSleepTimer = vi.fn();
let expiredCb: (() => void) | null = null;
const onSleepTimerExpired = vi.fn((cb: () => void) => {
  expiredCb = cb;
  return () => undefined;
});

vi.stubGlobal('electronAPI', {
  getSettings,
  setSettings,
  getSleepTimer,
  setSleepTimer,
  onSleepTimerExpired,
});

const idle = { active: false, minutes: null, expiresAt: null, remainingMs: null };

beforeEach(() => {
  vi.clearAllMocks();
  // 注意：store 的事件桥只在首次 init 时挂载（模块级幂等标志），
  // 所以这里不能清空 expiredCb——它保存的是第一次挂载的回调，
  // 回调内部读的是实时状态，跨用例依然有效。
  getSettings.mockResolvedValue({ ok: true, data: null });
  setSettings.mockResolvedValue({ ok: true });
  getSleepTimer.mockResolvedValue({ ok: true, data: idle });
  setSleepTimer.mockImplementation((minutes: number) =>
    Promise.resolve({
      ok: true,
      data:
        minutes > 0
          ? { active: true, minutes, expiresAt: Date.now() + minutes * 60_000, remainingMs: minutes * 60_000 }
          : idle,
    })
  );
  useSleepTimerStore.setState({ active: false, minutes: null, expiresAt: null, remainingMs: null });
  useMusicPlaybackStore.setState({ engine: null, current: null, isPlaying: false, position: 0, duration: 0 });
  void useSleepTimerStore.getState().init();
});

describe('formatRemaining (P2)', () => {
  it('renders m:ss and h:mm:ss', () => {
    expect(formatRemaining(null)).toBe('');
    expect(formatRemaining(0)).toBe('0:00');
    expect(formatRemaining(59_000)).toBe('0:59');
    expect(formatRemaining(90_000)).toBe('1:30');
    expect(formatRemaining(3_600_000 + 5 * 60_000)).toBe('1:05:00');
  });
});

describe('sleep timer UI (P2)', () => {
  it('sets a timer from a preset and shows the remaining time', async () => {
    render(<MusicSettings />);
    fireEvent.click(await screen.findByRole('button', { name: '30 分钟' }));
    await waitFor(() => expect(setSleepTimer).toHaveBeenCalledWith(30));
    await waitFor(() => expect(screen.getByText(/剩余 30:00/)).toBeTruthy());
    expect(screen.getByRole('button', { name: '取消定时' })).toBeTruthy();
  });

  it('cancels with 关闭 / 取消定时', async () => {
    render(<MusicSettings />);
    fireEvent.click(await screen.findByRole('button', { name: '15 分钟' }));
    await waitFor(() => expect(useSleepTimerStore.getState().active).toBe(true));

    fireEvent.click(screen.getByRole('button', { name: '取消定时' }));
    await waitFor(() => expect(setSleepTimer).toHaveBeenLastCalledWith(0));
    await waitFor(() => expect(useSleepTimerStore.getState().active).toBe(false));
    expect(screen.queryByText(/剩余/)).toBeNull();
  });

  it('pauses the renderer music engine when the timer expires', async () => {
    const pause = vi.fn();
    useMusicPlaybackStore.setState({
      engine: 'webaudio',
      isPlaying: true,
      current: { id: 1, title: '晴天', artist: null, album: null, albumartist: null, duration: 200, url: 'x' },
      pause,
    });
    expect(expiredCb).toBeTypeOf('function');
    expiredCb!();
    expect(pause).toHaveBeenCalled();
    expect(useSleepTimerStore.getState().active).toBe(false);
  });

  it('leaves the renderer engine alone when it is not the one playing', async () => {
    const pause = vi.fn();
    useMusicPlaybackStore.setState({ engine: 'mpv', isPlaying: true, pause });
    expect(expiredCb).toBeTypeOf('function');
    expiredCb!();
    // mpv 引擎由主进程暂停，这里不能重复动作
    expect(pause).not.toHaveBeenCalled();
  });
});
