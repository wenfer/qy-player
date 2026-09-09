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

/**
 * MPV-window-only bindings. These are written into a generated input.conf
 * (key = Electron-recorder-style string, e.g. "Shift+Right") and hot-reloaded
 * via set_property("input-conf", ...) when edited.
 */
export interface MpvBindingDef {
  id: string;
  label: string;
  defaultKeys: string;
  /** mpv command to bind, fixed per action - only the key is editable. */
  command: string;
}

export const MPV_BINDINGS: MpvBindingDef[] = [
  { id: 'playPause', label: '播放 / 暂停', defaultKeys: 'Space', command: 'cycle pause' },
  { id: 'seekFwd5', label: '快进 5 秒', defaultKeys: 'Right', command: 'seek 5' },
  { id: 'seekBack5', label: '快退 5 秒', defaultKeys: 'Left', command: 'seek -5' },
  { id: 'seekFwd1', label: '快进 1 秒（精确）', defaultKeys: 'Shift+Right', command: 'seek 1 exact' },
  { id: 'seekBack1', label: '快退 1 秒（精确）', defaultKeys: 'Shift+Left', command: 'seek -1 exact' },
  { id: 'volUp', label: '音量 +', defaultKeys: 'Up', command: 'add volume 3' },
  { id: 'volDown', label: '音量 -', defaultKeys: 'Down', command: 'add volume -3' },
  { id: 'fullscreen', label: '全屏切换', defaultKeys: 'f', command: 'cycle fullscreen' },
  { id: 'mute', label: '静音切换', defaultKeys: 'm', command: 'cycle mute' },
  { id: 'screenshot', label: '截图保存', defaultKeys: 's', command: 'async screenshot' },
  { id: 'pipOn', label: '画中画小窗', defaultKeys: 'P', command: 'set ontop yes; set window-scale 0.3' },
  { id: 'pipOff', label: '恢复窗口', defaultKeys: 'O', command: 'set ontop no; set window-scale 1' },
  { id: 'showTime', label: '显示当前时间', defaultKeys: 't', command: 'show-text "${time-pos} / ${duration} (${percent-pos}%)" 1500' },
  { id: 'quitPlayer', label: '退出播放器窗口', defaultKeys: 'q', command: 'quit' },
];

/** MPV bindings that cannot be re-recorded (mouse / preset entries), display only. */
export const MPV_FIXED_SHORTCUTS: Array<{ keys: string; label: string }> = [
  { keys: '双击画面', label: '全屏切换' },
  { keys: 'Esc', label: '退出全屏' },
  { keys: '滚轮', label: '音量 ±3' },
  { keys: 'a', label: '音轨菜单' },
  { keys: 'c', label: '字幕菜单' },
  { keys: 'Ctrl + 1~5', label: '画面比例预设（自动/16:9/4:3/2.35:1/1:1）' },
  { keys: 'Ctrl + r', label: '循环切换画面比例' },
];
