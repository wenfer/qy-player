import { create } from 'zustand';

/**
 * 应用顶层模式（QYP3-040）：视频与音乐完全隔离——各有一套导航、设置页签
 * 与媒体库入口。迷你条/精简浮窗不受模式影响（它们由音乐会话门禁，
 * 音乐后台播放时浏览视频模式照常）。
 *
 * QYP3-051 起**模式跨重启记忆**：主进程把上次的 profile 存进 `app_config`
 * 的 `window.memory`，启动时窗口直接按该形态出现（竖屏/浮窗），渲染层由
 * `WindowProfileHost` 回填这里。首次启动或记忆损坏时才是视频模式。
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
