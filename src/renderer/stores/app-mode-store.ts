import { create } from 'zustand';

/**
 * 应用顶层模式（QYP3-040）：视频与音乐完全隔离——各有一套导航、设置页签
 * 与媒体库入口。模式是显式 UI 状态，**不持久化**：默认打开永远是视频模式
 * （用户要求）。迷你条/精简浮窗不受模式影响（它们由音乐会话门禁，
 * 音乐后台播放时浏览视频模式照常）。
 *
 * QYP3-044：音乐模式同时把主窗口原地改成竖窄屏（同窗改尺寸，不新开窗口——
 * 频谱与播放状态都在主窗口 renderer 里）。窗口几何由主进程负责，这里只发
 * 意图；窗口没起来（测试/H5）时静默失败。
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
  setMode: (mode) => {
    set({ mode });
    void Promise.resolve(window.electronAPI?.setMusicMode?.(mode === 'music')).catch(() => undefined);
  },
}));
