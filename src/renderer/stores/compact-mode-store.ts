import { create } from 'zustand';

/**
 * 精简模式（QYP3-035）：主窗口原地缩成右上角浮窗时，renderer 切换成精简
 * 播放界面。
 *
 * 窗口几何（缩小/置顶/复原）在主进程 `ui-shell/compact-window.ts`；这里只
 * 持有 UI 开关，并把开关同步给主进程。同窗方案下播放状态与频谱零跨进程
 * 同步——`getSpectrum` 直接读同一个 WebAudioEngine。
 */
export interface CompactModeStore {
  compact: boolean;
  enter: () => void;
  exit: () => void;
  toggle: () => void;
  setCompact: (enabled: boolean) => void;
}

export const useCompactModeStore = create<CompactModeStore>((set, get) => ({
  compact: false,

  enter: () => {
    if (get().compact) return;
    set({ compact: true });
    void Promise.resolve(window.electronAPI.setCompactMode?.(true)).catch(() => undefined);
  },

  exit: () => {
    if (!get().compact) return;
    set({ compact: false });
    void Promise.resolve(window.electronAPI.setCompactMode?.(false)).catch(() => undefined);
  },

  toggle: () => (get().compact ? get().exit() : get().enter()),

  setCompact: (enabled) => (enabled ? get().enter() : get().exit()),
}));
