/**
 * Shortcut definitions shared between main (registration) and renderer
 * (display / editing on the Shortcuts page).
 */

export interface ShortcutDef {
  id: string;
  label: string;
  description: string;
  /** Electron accelerator, e.g. "CommandOrControl+Shift+Q". */
  defaultAccelerator: string;
  /**
   * Media keys cannot be captured from a DOM keydown listener, so these
   * entries can only be reset to default, not re-recorded.
   */
  fixed?: boolean;
}

/** Global (system-wide) shortcuts - registered via Electron globalShortcut. */
export const GLOBAL_SHORTCUTS: ShortcutDef[] = [
  {
    id: 'togglePause',
    label: '播放 / 暂停',
    description: '切换 MPV 播放状态，应用在后台也生效',
    defaultAccelerator: 'MediaPlayPause',
    fixed: true,
  },
  {
    id: 'seekForward',
    label: '快进 30 秒',
    description: '播放中向前跳转 30 秒（下一曲键复用）',
    defaultAccelerator: 'MediaNextTrack',
    fixed: true,
  },
  {
    id: 'seekBack',
    label: '后退 30 秒',
    description: '播放中向后跳转 30 秒（上一曲键复用）',
    defaultAccelerator: 'MediaPreviousTrack',
    fixed: true,
  },
  {
    id: 'toggleWindow',
    label: '显示 / 隐藏主窗口',
    description: '在任意应用前台时快速唤起或隐藏本播放器',
    defaultAccelerator: 'CommandOrControl+Shift+Q',
  },
  {
    id: 'cycleAspect',
    label: '循环切换画面比例',
    description: '自动 → 16:9 → 4:3 → 2.35:1 → 1:1',
    defaultAccelerator: 'CommandOrControl+Shift+A',
  },
];

/** MPV-window-only bindings (fixed in mpv-input.conf + mpv defaults). */
export const MPV_SHORTCUTS: Array<{ keys: string; label: string }> = [
  { keys: 'Space', label: '播放 / 暂停' },
  { keys: '← / →', label: '快退 / 快进 5 秒' },
  { keys: 'Shift + ← / →', label: '快退 / 快进 1 秒（精确）' },
  { keys: '↑ / ↓ / 滚轮', label: '音量 ±3' },
  { keys: 'f / 双击画面', label: '全屏切换' },
  { keys: 'Esc', label: '退出全屏' },
  { keys: 'm', label: '静音切换' },
  { keys: 's', label: '截图保存' },
  { keys: 'a', label: '音轨菜单' },
  { keys: 'c', label: '字幕菜单' },
  { keys: 'Ctrl + 1~5', label: '画面比例预设（自动/16:9/4:3/2.35:1/1:1）' },
  { keys: 'Ctrl + r', label: '循环切换画面比例' },
  { keys: 'P / O', label: '画中画小窗开 / 恢复' },
  { keys: 't', label: '显示当前时间 / 总时长' },
  { keys: 'q', label: '退出播放器窗口' },
];
