import { create } from 'zustand';
import { useMusicPlaybackStore } from './music-playback-store';

/**
 * 睡眠定时状态（P2）：权威状态在主进程（定时器不能因为窗口重载而丢），
 * 这里只做镜像 + 每秒倒计时显示。到点由主进程暂停 mpv，renderer 引擎
 * 的音乐由 ON_EXPIRED 事件暂停（两者都可能在放）。
 */

export interface SleepTimerStoreState {
  active: boolean;
  /** 已设置的分钟数；未启用为 null。 */
  minutes: number | null;
  /** 触发时刻（epoch ms）；未启用为 null。 */
  expiresAt: number | null;
  /** 剩余毫秒；未启用为 null。 */
  remainingMs: number | null;
  init: () => Promise<void>;
  /** 设置分钟数；0 = 关闭。 */
  setMinutes: (minutes: number) => Promise<void>;
}

let tickHandle: ReturnType<typeof setInterval> | null = null;
let bridgeAttached = false;

/** 剩余毫秒 → `h:mm:ss` / `m:ss`（仅用于显示）。 */
export function formatRemaining(ms: number | null): string {
  if (ms === null || ms < 0) return '';
  const total = Math.ceil(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export const useSleepTimerStore = create<SleepTimerStoreState>((set, get) => ({
  active: false,
  minutes: null,
  expiresAt: null,
  remainingMs: null,

  init: async () => {
    // 事件桥接只挂一次（Shell 挂载时调用，重载后重挂也无害）
    if (!bridgeAttached) {
      bridgeAttached = true;
      window.electronAPI.onSleepTimerExpired(() => {
        useSleepTimerStore.setState({ active: false, minutes: null, expiresAt: null, remainingMs: null });
        // renderer 引擎的音乐不受 mpv 暂停影响，需要自己停
        const music = useMusicPlaybackStore.getState();
        if (music.engine === 'webaudio') music.pause();
      });
    }
    const res = (await window.electronAPI.getSleepTimer()) as { data?: Partial<SleepTimerStoreState> };
    if (res?.data) {
      set({
        active: res.data.active === true,
        minutes: res.data.minutes ?? null,
        expiresAt: res.data.expiresAt ?? null,
        remainingMs: res.data.remainingMs ?? null,
      });
    }
    syncTicker(set, get);
  },

  setMinutes: async (minutes) => {
    const res = (await window.electronAPI.setSleepTimer(minutes)) as {
      data?: {
        minutes?: number | null;
        active?: boolean;
        expiresAt?: number | null;
        remainingMs?: number | null;
      };
    };
    set({
      active: res?.data?.active === true,
      minutes: res?.data?.minutes ?? null,
      expiresAt: res?.data?.expiresAt ?? null,
      remainingMs: res?.data?.remainingMs ?? null,
    });
    syncTicker(set, get);
  },
}));

type SetState = (partial: Partial<SleepTimerStoreState>) => void;
type GetState = () => SleepTimerStoreState;

/** 仅在启用时每秒刷新剩余时间（不启用时不留定时器）。 */
function syncTicker(set: SetState, get: GetState): void {
  const stop = (): void => {
    if (tickHandle !== null) {
      clearInterval(tickHandle);
      tickHandle = null;
    }
  };
  stop();
  if (!get().active) return;
  tickHandle = setInterval(() => {
    const { active, expiresAt } = get();
    if (!active || expiresAt === null) {
      stop();
      return;
    }
    const remaining = Math.max(0, expiresAt - Date.now());
    if (remaining === 0) {
      set({ active: false, minutes: null, expiresAt: null, remainingMs: null });
      stop();
      return;
    }
    set({ remainingMs: remaining });
  }, 1000);
}
