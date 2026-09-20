import { BrowserWindow, screen, type Rectangle } from 'electron';

/**
 * 精简模式浮窗（QYP3-035）：把**主窗口原地**缩成屏幕右上角的一个小浮窗，
 * 渲染层切换成精简播放界面（频谱图 + 进度 + 传输键 + 音量 + 循环）。
 *
 * 音乐模式窗口（QYP3-044）：同样是**主窗口原地改尺寸**——竖窄屏更贴音乐
 * 的浏览方式，且播放状态与 30fps 频谱都在主窗口 renderer 里，同窗改尺寸零
 * 跨进程同步。另开 BrowserWindow 就得把频谱跨进程转发，老机 CPU 不划算。
 *
 * 做法是改主窗口的 bounds/最小尺寸/置顶，而不是新开一个 BrowserWindow。
 * 两个 profile 共用同一份"正常几何"记忆，互不覆盖。
 */

export const COMPACT_WIDTH = 400;
export const COMPACT_HEIGHT = 300;
export const COMPACT_MARGIN = 16;
/** 竖窄屏音乐窗口（QYP3-044）：宽度按音乐页的封面网格与曲目行定。 */
export const MUSIC_WIDTH = 460;
export const MUSIC_HEIGHT = 820;
export const MUSIC_MARGIN = 24;
/** 正常模式的最小尺寸（与 createWindow 的 minWidth/minHeight 保持一致）。 */
const NORMAL_MIN_WIDTH = 1280;
const NORMAL_MIN_HEIGHT = 800;
/** 允许缩小到浮窗尺寸所需的最小下限。 */
const COMPACT_MIN_WIDTH = 320;
const COMPACT_MIN_HEIGHT = 200;
const MUSIC_MIN_WIDTH = 380;
const MUSIC_MIN_HEIGHT = 600;

interface CompactState {
  bounds: Rectangle;
  resizable: boolean;
  alwaysOnTop: boolean;
}

/** 窗口形态名（QYP3-051 起这个名字会被持久化，见 `window-state.ts`）。 */
export type WindowProfileName = 'normal' | 'compact' | 'music';

let state: CompactState | null = null;
/** 当前生效的窗口 profile（两个 profile 可能叠加：音乐模式里再进精简浮窗）。 */
let profile: WindowProfileName = 'normal';
let musicMode = false;

/** 形态变化通知（记忆落盘用，QYP3-051）。 */
export type ProfileChangeListener = (state: { profile: WindowProfileName; music: boolean }) => void;
let profileChangeListener: ProfileChangeListener | null = null;

export function setProfileChangeListener(listener: ProfileChangeListener | null): void {
  profileChangeListener = listener;
}

function notifyProfileChange(): void {
  profileChangeListener?.({ profile, music: musicMode });
}

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
  return profile === 'compact';
}

/**
 * 当前窗口 profile（给渲染层回填用）。
 *
 * renderer reload（dev 热重载）不会重置主进程：窗口还是浮窗/竖屏尺寸，但渲染层
 * 的 store 全归零，于是小窗口里画出完整影视界面。几何的主进程才是权威，渲染层
 * 启动时得回来问一次。
 */
export function getWindowProfile(): { compact: boolean; music: boolean } {
  return { compact: profile === 'compact', music: musicMode };
}

/** 当前形态名（QYP3-051：记忆落盘与"正常几何才值得记"的判断都靠它）。 */
export function getProfileName(): WindowProfileName {
  return profile;
}

/** 某个 profile 的最小窗口尺寸——构造窗口时就得给对，否则小尺寸会被顶回去。 */
export function minSizeForProfile(name: WindowProfileName): [number, number] {
  if (name === 'compact') return [COMPACT_MIN_WIDTH, COMPACT_MIN_HEIGHT];
  if (name === 'music') return [MUSIC_MIN_WIDTH, MUSIC_MIN_HEIGHT];
  return [NORMAL_MIN_WIDTH, NORMAL_MIN_HEIGHT];
}

/**
 * 用记忆里的正常几何预置还原快照（QYP3-051 启动恢复）。
 *
 * 只在还没有快照时生效：启动时若不预置，随后套用音乐/精简模式会把**刚建好的
 * 窗口 bounds** 当成"正常几何"存进快照，退出时就回不到用户上次的尺寸。
 */
export function setNormalBoundsSeed(bounds: Rectangle): void {
  if (state) return;
  state = { bounds: { ...bounds }, resizable: true, alwaysOnTop: false };
}

/** 竖窄屏音乐窗口在给定工作区的位置：水平居中、垂直尽量居中（纯函数，可测）。 */
export function musicBounds(
  workArea: Pick<Rectangle, 'x' | 'y' | 'width' | 'height'>,
  width = MUSIC_WIDTH,
  height = MUSIC_HEIGHT,
  margin = MUSIC_MARGIN
): Rectangle {
  // 矮屏（老机 768 高）优先保证能放下：先夹高度，再夹宽度
  const w = Math.max(MUSIC_MIN_WIDTH, Math.min(width, workArea.width - margin * 2));
  const h = Math.max(MUSIC_MIN_HEIGHT, Math.min(height, workArea.height - margin * 2));
  return {
    x: workArea.x + Math.round((workArea.width - w) / 2),
    y: workArea.y + Math.max(margin, Math.round((workArea.height - h) / 2)),
    width: w,
    height: h,
  };
}

/**
 * 应用一个窗口 profile：normal 恢复记忆里的正常几何，compact/music 各自改
 * 尺寸与最小下限。正常几何只记一次，音乐模式里再进精简浮窗不会互相覆盖。
 */
function applyProfile(win: BrowserWindow, next: WindowProfileName): void {
  if (next === 'normal') {
    const prev = state;
    state = null;
    profile = 'normal';
    if (!prev) {
      notifyProfileChange();
      return;
    }
    win.setAlwaysOnTop(prev.alwaysOnTop);
    win.setResizable(true);
    // 保持小下限直到 resize 回原尺寸，再把下限恢复成正常值
    win.setBounds(prev.bounds);
    win.setMinimumSize(NORMAL_MIN_WIDTH, NORMAL_MIN_HEIGHT);
    win.setResizable(prev.resizable);
    notifyProfileChange();
    return;
  }

  if (!state) {
    // 记的是"还原后的尺寸"：最大化时 getBounds 是最大化矩形，退出音乐模式
    // 会把窗口留成"最大化大小但没最大化"的怪状态（QYP3-051 修）
    state = {
      bounds: win.getNormalBounds(),
      resizable: win.isResizable(),
      alwaysOnTop: win.isAlwaysOnTop(),
    };
  }
  profile = next;
  const workArea = screen.getDisplayMatching(win.getBounds()).workArea;
  // 先放宽最小尺寸，否则 1280×800 的下限会把小窗顶回去
  if (next === 'compact') {
    win.setMinimumSize(COMPACT_MIN_WIDTH, COMPACT_MIN_HEIGHT);
    win.setResizable(false);
    win.setBounds(compactBounds(workArea));
    win.setAlwaysOnTop(true);
    notifyProfileChange();
    return;
  }
  win.setMinimumSize(MUSIC_MIN_WIDTH, MUSIC_MIN_HEIGHT);
  win.setResizable(true);
  if (win.isMaximized()) win.unmaximize(); // 最大化状态下 setBounds 行为不确定
  win.setBounds(musicBounds(workArea));
  win.setAlwaysOnTop(state.alwaysOnTop);
  notifyProfileChange();
}

/**
 * 进入/退出精简模式。返回是否处于精简模式（供 IPC 回执）。
 * 退出时若仍在音乐模式，回到竖窄屏而不是正常尺寸。
 */
export function setCompactMode(win: BrowserWindow | null | undefined, enabled: boolean): boolean {
  if (!win || win.isDestroyed()) return profile === 'compact';
  if (enabled) {
    if (profile === 'compact') return true; // 幂等
    applyProfile(win, 'compact');
    return true;
  }
  if (profile !== 'compact') return false;
  applyProfile(win, musicMode ? 'music' : 'normal');
  return false;
}

/**
 * 进入/退出音乐模式（QYP3-044）：主窗口原地变成竖窄屏。
 * 精简浮窗优先级更高——音乐模式里开了浮窗就先不打断它。
 */
export function setMusicMode(win: BrowserWindow | null | undefined, enabled: boolean): boolean {
  const next = Boolean(enabled);
  const wantProfile: 'music' | 'normal' = next ? 'music' : 'normal';
  const changed = musicMode !== next;
  musicMode = next;
  if (!win || win.isDestroyed()) {
    if (changed) notifyProfileChange();
    return musicMode;
  }
  if (profile === 'compact') {
    if (changed) notifyProfileChange();
    return musicMode;
  }
  // 幂等：reload 后渲染层会回填一次，不该把用户摆好的窗口再挪一遍
  if (profile === wantProfile) {
    if (changed) notifyProfileChange();
    return musicMode;
  }
  applyProfile(win, wantProfile); // 内部会通知
  return musicMode;
}
