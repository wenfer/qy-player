import { BrowserWindow, type Rectangle } from 'electron';
import {
  getProfileName,
  getWindowProfile,
  setCompactMode,
  setMusicMode,
  setNormalBoundsSeed,
  setProfileChangeListener,
  type WindowProfileName,
} from './compact-window';

export type { WindowProfileName };

/**
 * 窗口与模式记忆（QYP3-051）。
 *
 * 关窗时把"上次是什么模式 + 正常几何"记进 `app_config`，下次启动原样恢复：
 * 影视 / 音乐（竖窄屏）/ 精简浮窗。**音乐模式下的手动改尺寸不记忆**——音乐模式
 * 每次按当前工作区重算标准 460×820，只有"正常模式"的几何才是用户的。
 *
 * 纯函数（解析 / 夹回可见区域）与落盘接线都放这里，便于单测；窗口状态机仍由
 * `compact-window.ts` 持有，本模块只读它、并订阅 profile 变化。
 */

export const WINDOW_MEMORY_KEY = 'window.memory';
export const DEFAULT_NORMAL_WIDTH = 1600;
export const DEFAULT_NORMAL_HEIGHT = 900;
/** 记忆里的窗口至少要留这么多像素在屏内，否则视为"跑到屏外了"。 */
export const MIN_VISIBLE_WIDTH = 80;
export const MIN_VISIBLE_HEIGHT = 48;
/** 正常模式下 resize/move 的落盘防抖（Linux 没有 resized/moved，只能 debounce）。 */
export const SAVE_DEBOUNCE_MS = 500;

export interface WindowMemory {
  profile: WindowProfileName;
  /** 精简浮窗是从音乐模式进的（true）还是影视模式进的（false）。 */
  music: boolean;
  /** **正常**几何：最大化时也存还原后的尺寸（`getNormalBounds()`）。 */
  bounds: Rectangle;
  maximized: boolean;
}

/** 只需要 config 读写两件事，避免这里依赖整个 Storage 接口。 */
export interface ConfigStore {
  getConfig(key: string): string | undefined;
  setConfig(key: string, value: string): void;
}

function toInt(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null;
}

/** 四个字段都是有限整数、宽高为正才算合法。 */
export function normalizeBounds(v: unknown): Rectangle | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const x = toInt(o.x);
  const y = toInt(o.y);
  const width = toInt(o.width);
  const height = toInt(o.height);
  if (x === null || y === null || width === null || height === null) return null;
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

function isProfileName(v: unknown): v is WindowProfileName {
  return v === 'normal' || v === 'compact' || v === 'music';
}

/** 任何一处不合法（坏 JSON、非法 profile、缺 bounds）都返回 null → 走默认。 */
export function parseWindowMemory(raw: string | undefined): WindowMemory | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const o = parsed as Record<string, unknown>;
  if (!isProfileName(o.profile)) return null;
  const bounds = normalizeBounds(o.bounds);
  if (!bounds) return null;
  return {
    profile: o.profile,
    music: o.music === true,
    bounds,
    maximized: o.maximized === true,
  };
}

export function serializeWindowMemory(memory: WindowMemory): string {
  return JSON.stringify(memory);
}

export function readWindowMemory(store: ConfigStore): WindowMemory | null {
  try {
    return parseWindowMemory(store.getConfig(WINDOW_MEMORY_KEY));
  } catch {
    return null; // 库还没就绪之类的意外：宁可当作没有记忆
  }
}

function overlapArea(a: Rectangle, b: Rectangle): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

function clamp(v: number, lo: number, hi: number): number {
  if (lo > hi) return lo;
  return Math.min(Math.max(v, lo), hi);
}

/** 在工作区里居中放一个 size（超过工作区就缩到工作区大小）。 */
function centered(area: Rectangle, width: number, height: number): Rectangle {
  const w = Math.min(width, area.width);
  const h = Math.min(height, area.height);
  return {
    x: Math.round(area.x + (area.width - w) / 2),
    y: Math.round(area.y + (area.height - h) / 2),
    width: w,
    height: h,
  };
}

/**
 * 把记忆里的几何夹回"看得见"的范围：
 * - 有交集的那块屏（可见面积最大者）优先
 * - 一块都不挨着（拔显示器）→ 主屏居中默认尺寸
 * - 部分越界 → 至少保留 `MIN_VISIBLE_*` 在屏内
 * - 比屏还大 → 缩到工作区
 */
export function resolveRestoreBounds(
  saved: Rectangle | null,
  workAreas: Rectangle[],
  size: { width: number; height: number } = {
    width: DEFAULT_NORMAL_WIDTH,
    height: DEFAULT_NORMAL_HEIGHT,
  }
): Rectangle {
  const primary =
    workAreas[0] ?? { x: 0, y: 0, width: size.width, height: size.height };
  if (!saved) return centered(primary, size.width, size.height);

  let host: Rectangle | null = null;
  let hostVisible = 0;
  for (const area of workAreas) {
    const visible = overlapArea(saved, area);
    if (visible > hostVisible) {
      host = area;
      hostVisible = visible;
    }
  }
  if (!host) return centered(primary, size.width, size.height);

  const width = Math.min(saved.width, host.width);
  const height = Math.min(saved.height, host.height);
  // 横向只要露出 MIN_VISIBLE_WIDTH 就算可用（贴边放置是常见用法）
  const minX = host.x - Math.max(0, width - MIN_VISIBLE_WIDTH);
  const maxX = host.x + host.width - MIN_VISIBLE_WIDTH;
  const minY = host.y;
  const maxY = host.y + host.height - MIN_VISIBLE_HEIGHT;
  return {
    x: Math.round(clamp(saved.x, Math.min(minX, maxX), Math.max(minX, maxX))),
    y: Math.round(clamp(saved.y, Math.min(minY, maxY), Math.max(minY, maxY))),
    width,
    height,
  };
}

interface Tracker {
  win: BrowserWindow;
  store: ConfigStore;
  /** 记忆中的正常几何（profile 不是 normal 时不会被当前 bounds 覆盖）。 */
  normalBounds: Rectangle;
  maximized: boolean;
  timer: NodeJS.Timeout | null;
}

let tracker: Tracker | null = null;

function write(profile: WindowProfileName, music: boolean): void {
  if (!tracker) return;
  const memory: WindowMemory = {
    profile,
    music,
    bounds: tracker.normalBounds,
    maximized: tracker.maximized,
  };
  try {
    tracker.store.setConfig(WINDOW_MEMORY_KEY, serializeWindowMemory(memory));
  } catch {
    // 落盘失败只影响下次启动的观感，不能影响退出流程
  }
}

function saveCurrent(): void {
  write(getProfileName(), getWindowProfile().music);
}

/** 正常的 resize/move：刷新正常几何（最大化时别动，那是最大化矩形）。 */
function recordNormalGeometry(): void {
  if (!tracker) return;
  const { win } = tracker;
  if (win.isDestroyed()) return;
  tracker.normalBounds = win.getNormalBounds();
  tracker.maximized = win.isMaximized();
  saveCurrent();
}

function scheduleSave(): void {
  if (!tracker || tracker.timer) return;
  tracker.timer = setTimeout(() => {
    if (!tracker) return;
    tracker.timer = null;
    recordNormalGeometry();
  }, SAVE_DEBOUNCE_MS);
  // 退出时别为了这个定时器多活 0.5s
  tracker.timer.unref?.();
}

function clearTimer(): void {
  if (tracker?.timer) {
    clearTimeout(tracker.timer);
    tracker.timer = null;
  }
}

/**
 * 挂上记忆：正常模式下的几何变化、最大化状态、退出都落盘。启动时先调用它
 * （用已经解析好的 `memory` 做种子），再 `restoreWindowProfile()` 套用模式。
 */
export function attachWindowMemory(
  win: BrowserWindow,
  store: ConfigStore,
  memory: WindowMemory
): void {
  tracker = {
    win,
    store,
    normalBounds: memory.bounds,
    maximized: memory.maximized,
    timer: null,
  };

  const onGeometryChange = (): void => {
    // 音乐/精简模式下的尺寸不是用户想要的"正常几何"，别拿它覆盖记忆
    if (getProfileName() !== 'normal') return;
    if (win.isDestroyed() || win.isMaximized()) return;
    scheduleSave();
  };
  const onMaximizeChange = (): void => {
    if (win.isDestroyed()) return;
    clearTimer();
    if (win.isMaximized()) {
      // 最大化时 getBounds 是最大化矩形，正常几何仍以 getNormalBounds 为准
      tracker!.maximized = true;
      tracker!.normalBounds = win.getNormalBounds();
      saveCurrent();
      return;
    }
    recordNormalGeometry();
  };

  win.on('resize', onGeometryChange);
  win.on('move', onGeometryChange);
  win.on('maximize', onMaximizeChange);
  win.on('unmaximize', onMaximizeChange);
  win.on('close', () => {
    clearTimer();
    if (getProfileName() === 'normal' && !win.isDestroyed()) {
      tracker!.normalBounds = win.getNormalBounds();
      tracker!.maximized = win.isMaximized();
    }
    saveCurrent();
  });

  // 模式变化（进/退音乐模式、进/退精简浮窗）也记一笔
  setProfileChangeListener(({ profile, music }) => {
    clearTimer();
    // 此刻正常几何的快照仍由 compact-window / 上面的事件维护，直接用
    write(profile, music);
  });
}

/** 退出兜底（`will-quit` 不 await，所以必须是同步的）。 */
export function flushWindowMemory(): void {
  if (!tracker) return;
  clearTimer();
  const { win } = tracker;
  if (!win.isDestroyed() && getProfileName() === 'normal') {
    tracker.normalBounds = win.getNormalBounds();
    tracker.maximized = win.isMaximized();
  }
  saveCurrent();
}

/** 仅测试用：解开模块级状态，避免用例之间互相污染。 */
export function resetWindowMemory(): void {
  clearTimer();
  setProfileChangeListener(null);
  tracker = null;
}

/**
 * 启动时按记忆套用模式（QYP3-051）。
 *
 * 顺序至关重要：进音乐/浮窗模式前**先**把记忆的正常几何种进 `compact-window`
 * 的还原快照——否则 `applyProfile` 会把刚建好的窗口 bounds 当成"正常几何"，
 * 退出音乐模式时就回不到用户上次的尺寸了。精简浮窗还要先于音乐模式套用，
 * 因为浮窗优先级更高（`setMusicMode` 在 profile === 'compact' 时只记标志）。
 */
export function restoreWindowProfile(win: BrowserWindow, memory: WindowMemory): void {
  // 正常模式启动：窗口本来就以记忆里的几何建好了，**不要**预置快照——用户这
  // 一轮里挪过的窗口才是"正常几何"，进音乐/浮窗时才该抓当时的尺寸
  if (memory.profile === 'normal') return;
  setNormalBoundsSeed(memory.bounds);
  if (memory.profile === 'music') {
    setMusicMode(win, true);
    return;
  }
  setCompactMode(win, true);
  if (memory.music) setMusicMode(win, true);
}
