import { create } from 'zustand';

/**
 * 应用顶层模式（QYP3-040）：视频与音乐完全隔离——各有一套导航、设置页签
 * 与媒体库入口。模式是显式 UI 状态，**不持久化**：默认打开永远是视频模式
 * （用户要求）。迷你条/精简浮窗不受模式影响（它们由音乐会话门禁，
 * 音乐后台播放时浏览视频模式照常）。
 */

export type AppMode = 'video' | 'music';

/** 各模式的默认页（切换模式时导航目标）。 */
export const MODE_HOME: Record<AppMode, string> = {
  video: '/',
  music: '/music',
};

interface AppModeState {
  mode: AppMode;
  setMode: (mode: AppMode) => void;
}

export const useAppModeStore = create<AppModeState>((set) => ({
  mode: 'video',
  setMode: (mode) => set({ mode }),
}));
