import { BrowserWindow, screen, type Rectangle } from 'electron';

/**
 * 精简模式浮窗（QYP3-035）：把**主窗口原地**缩成屏幕右上角的一个小浮窗，
 * 渲染层切换成精简播放界面（频谱图 + 进度 + 传输键 + 音量 + 循环）。
 *
 * 做法是改主窗口的 bounds/最小尺寸/置顶，而不是新开一个 BrowserWindow：
 * 播放状态与 30fps 频谱都在主窗口的 renderer 里，同窗改尺寸零跨进程同步，
 * 对老机最省 CPU（另开浮窗需要把频谱跨进程转发）。
 *
 * 进入前的 bounds / resizable / 置顶状态会被记住，退出时原样恢复。
 */

export const COMPACT_WIDTH = 400;
export const COMPACT_HEIGHT = 300;
export const COMPACT_MARGIN = 16;
/** 正常模式的最小尺寸（与 createWindow 的 minWidth/minHeight 保持一致）。 */
const NORMAL_MIN_WIDTH = 1280;
const NORMAL_MIN_HEIGHT = 800;
/** 允许缩小到浮窗尺寸所需的最小下限。 */
const COMPACT_MIN_WIDTH = 320;
const COMPACT_MIN_HEIGHT = 200;

interface CompactState {
  bounds: Rectangle;
  resizable: boolean;
  alwaysOnTop: boolean;
}

let state: CompactState | null = null;

/** 浮窗在给定工作区的位置：右上角留 margin（纯函数，可测）。 */
export function compactBounds(
  workArea: Pick<Rectangle, 'x' | 'y' | 'width'>,
  width = COMPACT_WIDTH,
  height = COMPACT_HEIGHT,
  margin = COMPACT_MARGIN
): Rectangle {
  return {
    x: workArea.x + workArea.width - width - margin,
    y: workArea.y + margin,
    width,
    height,
  };
}

export function isCompactMode(): boolean {
  return state !== null;
}

/**
 * 进入/退出精简模式。返回是否处于精简模式（供 IPC 回执）。
 * 传入的窗口不可用（已销毁/未创建）时静默忽略。
 */
export function setCompactMode(win: BrowserWindow | null | undefined, enabled: boolean): boolean {
  if (!win || win.isDestroyed()) return state !== null;

  if (enabled) {
    if (state) return true; // 已在精简模式：幂等
    state = {
      bounds: win.getBounds(),
      resizable: win.isResizable(),
      alwaysOnTop: win.isAlwaysOnTop(),
    };
    const workArea = screen.getDisplayMatching(win.getBounds()).workArea;
    // 先放宽最小尺寸，否则 1280×800 的下限会把浮窗顶回去
    win.setMinimumSize(COMPACT_MIN_WIDTH, COMPACT_MIN_HEIGHT);
    win.setResizable(false);
    win.setBounds(compactBounds(workArea));
    win.setAlwaysOnTop(true);
    return true;
  }

  const prev = state;
  state = null;
  if (!prev) return false; // 未在精简模式：无需恢复
  win.setAlwaysOnTop(prev.alwaysOnTop);
  win.setResizable(true);
  // 保持小下限直到 resize 回原尺寸，再把下限恢复成正常值
  win.setBounds(prev.bounds);
  win.setMinimumSize(NORMAL_MIN_WIDTH, NORMAL_MIN_HEIGHT);
  win.setResizable(prev.resizable);
  return false;
}
