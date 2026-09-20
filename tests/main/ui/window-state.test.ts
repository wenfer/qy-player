import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 窗口与模式记忆（QYP3-051）：记忆的解析/夹回是纯函数，落盘接线用假窗口 +
 * 假 config 存储验证（真实 BrowserWindow 不参与）。
 */
vi.mock('electron', () => ({
  BrowserWindow: class {},
  screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
}));

import type { BrowserWindow, Rectangle } from 'electron';
import {
  DEFAULT_NORMAL_HEIGHT,
  DEFAULT_NORMAL_WIDTH,
  MIN_VISIBLE_WIDTH,
  WINDOW_MEMORY_KEY,
  attachWindowMemory,
  flushWindowMemory,
  normalizeBounds,
  parseWindowMemory,
  readWindowMemory,
  resetWindowMemory,
  resolveRestoreBounds,
  restoreWindowProfile,
  serializeWindowMemory,
  type ConfigStore,
  type WindowMemory,
} from '../../../src/main/modules/ui-shell/window-state';
import {
  COMPACT_WIDTH,
  MUSIC_WIDTH,
  getWindowProfile,
  setCompactMode,
  setMusicMode,
} from '../../../src/main/modules/ui-shell/compact-window';

const MEMORY: WindowMemory = {
  profile: 'normal',
  music: false,
  bounds: { x: 100, y: 100, width: 1600, height: 900 },
  maximized: false,
};

describe('normalizeBounds', () => {
  it('accepts finite numbers and rounds them to integers', () => {
    expect(normalizeBounds({ x: 10.4, y: 20.6, width: 800.5, height: 600.2 })).toEqual({
      x: 10,
      y: 21,
      width: 801,
      height: 600,
    });
  });

  it('rejects junk, missing fields, NaN and non-positive sizes', () => {
    expect(normalizeBounds(null)).toBeNull();
    expect(normalizeBounds('1600x900')).toBeNull();
    expect(normalizeBounds({ x: 0, y: 0, width: 800 })).toBeNull();
    expect(normalizeBounds({ x: 0, y: 0, width: NaN, height: 600 })).toBeNull();
    expect(normalizeBounds({ x: 0, y: 0, width: 800, height: -1 })).toBeNull();
    expect(normalizeBounds({ x: 0, y: 0, width: 0, height: 600 })).toBeNull();
  });
});

describe('parseWindowMemory / serializeWindowMemory', () => {
  it('round-trips a valid memory', () => {
    expect(parseWindowMemory(serializeWindowMemory(MEMORY))).toEqual(MEMORY);
  });

  it('returns null for corrupt JSON, unknown profile or missing bounds', () => {
    expect(parseWindowMemory(undefined)).toBeNull();
    expect(parseWindowMemory('')).toBeNull();
    expect(parseWindowMemory('{not json')).toBeNull();
    expect(parseWindowMemory('null')).toBeNull();
    expect(parseWindowMemory(JSON.stringify({ ...MEMORY, profile: 'theater' }))).toBeNull();
    expect(parseWindowMemory(JSON.stringify({ profile: 'music' }))).toBeNull();
    expect(
      parseWindowMemory(
        JSON.stringify({ profile: 'music', bounds: { x: 0, y: 0, width: -5, height: 10 } })
      )
    ).toBeNull();
  });

  it('only treats literal true as a flag (旧版本/手工改过的行)', () => {
    const parsed = parseWindowMemory(
      JSON.stringify({ profile: 'compact', bounds: MEMORY.bounds, music: 'yes', maximized: 1 })
    );
    expect(parsed).toEqual({
      profile: 'compact',
      music: false,
      bounds: MEMORY.bounds,
      maximized: false,
    });
  });
});

describe('readWindowMemory', () => {
  it('reads through the config store and survives a throwing store', () => {
    const store = {
      getConfig: () => serializeWindowMemory({ ...MEMORY, profile: 'music', music: true }),
      setConfig: () => undefined,
    };
    expect(readWindowMemory(store)?.profile).toBe('music');

    const broken = {
      getConfig: () => {
        throw new Error('db closed');
      },
      setConfig: () => undefined,
    };
    expect(readWindowMemory(broken)).toBeNull();
  });
});

describe('resolveRestoreBounds', () => {
  const primary: Rectangle = { x: 0, y: 0, width: 1920, height: 1080 };

  it('centers the default size when there is no memory', () => {
    const b = resolveRestoreBounds(null, [primary]);
    expect(b.width).toBe(DEFAULT_NORMAL_WIDTH);
    expect(b.height).toBe(DEFAULT_NORMAL_HEIGHT);
    expect(b.x).toBe(Math.round((1920 - DEFAULT_NORMAL_WIDTH) / 2));
    expect(b.y).toBe(Math.round((1080 - DEFAULT_NORMAL_HEIGHT) / 2));
  });

  it('keeps a visible window exactly where it was', () => {
    const saved = { x: 120, y: 60, width: 1400, height: 860 };
    expect(resolveRestoreBounds(saved, [primary])).toEqual(saved);
  });

  it('pulls a partially off-screen window back so a strip stays visible', () => {
    // 左边只剩 50px 露在屏内（< 80）→ 夹到只留 80px
    const saved = { x: -1350, y: 100, width: 1400, height: 860 };
    const b = resolveRestoreBounds(saved, [primary]);
    expect(b.x).toBe(primary.x - (1400 - MIN_VISIBLE_WIDTH));
    expect(b.width).toBe(1400);

    // 下边只剩 20px（< 48）→ 夹到只留 48px
    const below = resolveRestoreBounds({ x: 100, y: 1060, width: 1400, height: 860 }, [primary]);
    expect(below.y).toBe(primary.y + primary.height - 48);
  });

  it('falls back to the primary screen center when that display is gone', () => {
    const saved = { x: 4000, y: 300, width: 1400, height: 860 };
    const b = resolveRestoreBounds(saved, [primary]);
    expect(b.x).toBe(Math.round((1920 - DEFAULT_NORMAL_WIDTH) / 2));
    expect(b.width).toBe(DEFAULT_NORMAL_WIDTH);
  });

  it('shrinks to the work area when the screen is smaller than the saved size', () => {
    const small: Rectangle = { x: 0, y: 30, width: 1366, height: 700 };
    const b = resolveRestoreBounds({ x: 0, y: 0, width: 1600, height: 900 }, [small]);
    expect(b.width).toBe(1366);
    expect(b.height).toBe(700);
    expect(b.y).toBe(30);
  });

  it('picks the display with the largest overlap (multi-monitor)', () => {
    const second: Rectangle = { x: 1920, y: 0, width: 1920, height: 1080 };
    const saved = { x: 2400, y: 100, width: 1400, height: 860 };
    const b = resolveRestoreBounds(saved, [primary, second]);
    expect(b.x).toBe(2400);
    expect(b.width).toBe(1400);
  });
});

/** 假窗口：只实现记忆接线与 profile 切换用到的方法/事件。 */
interface FakeWin extends BrowserWindow {
  bounds: Rectangle;
  normalBounds: Rectangle;
  maximized: boolean;
  emits: (event: string) => void;
}

function fakeWin(initial: Rectangle = { x: 100, y: 100, width: 1600, height: 900 }): FakeWin {
  const handlers = new Map<string, Array<() => void>>();
  const win = {
    bounds: { ...initial },
    normalBounds: { ...initial },
    maximized: false,
    resizable: true,
    alwaysOnTop: false,
    on(event: string, cb: () => void) {
      handlers.set(event, [...(handlers.get(event) ?? []), cb]);
      return win;
    },
    emits: (event: string) => {
      for (const cb of handlers.get(event) ?? []) cb();
    },
    isDestroyed: () => false,
    isMaximized: () => win.maximized,
    unmaximize: () => {
      win.maximized = false;
    },
    isResizable: () => win.resizable,
    isAlwaysOnTop: () => win.alwaysOnTop,
    // 真实语义：未最大化时"正常几何"就是当前 bounds
    getBounds: () => ({ ...win.bounds }),
    getNormalBounds: () => (win.maximized ? { ...win.normalBounds } : { ...win.bounds }),
    setBounds: (b: Rectangle) => {
      win.bounds = { ...b };
    },
    setResizable: (v: boolean) => {
      win.resizable = v;
    },
    setAlwaysOnTop: (v: boolean) => {
      win.alwaysOnTop = v;
    },
    setMinimumSize: () => undefined,
  };
  return win as unknown as FakeWin;
}

interface FakeStore extends ConfigStore {
  read: () => WindowMemory | null;
}

function fakeStore(): FakeStore {
  const data = new Map<string, string>();
  return {
    getConfig: (key) => data.get(key),
    setConfig: (key, value) => {
      data.set(key, value);
    },
    read: () => parseWindowMemory(data.get(WINDOW_MEMORY_KEY)),
  };
}

/** compact-window 的 profile 也是模块级状态：用例之间归位。 */
function resetProfile(win: FakeWin): void {
  setCompactMode(win, false);
  setMusicMode(win, false);
}

describe('attachWindowMemory (QYP3-051 落盘)', () => {
  let win: FakeWin;

  beforeEach(() => {
    vi.useFakeTimers();
    win = fakeWin();
    resetWindowMemory();
    resetProfile(win);
  });

  afterEach(() => {
    resetWindowMemory(); // 先摘掉监听器，免得归位过程触发写入
    resetProfile(win);
    vi.useRealTimers();
  });

  it('debounces normal-mode resize/move and stores the normal bounds', () => {
    const store = fakeStore();
    attachWindowMemory(win, store, MEMORY);

    win.bounds = { x: 300, y: 200, width: 1200, height: 800 };
    win.emits('resize');
    win.emits('move');
    expect(store.read()).toBeNull(); // 还没到防抖时间
    vi.advanceTimersByTime(500);
    expect(store.read()).toEqual({
      ...MEMORY,
      bounds: { x: 300, y: 200, width: 1200, height: 800 },
    });
  });

  it('does not record geometry while maximized (最大化矩形不是用户的正常尺寸)', () => {
    const store = fakeStore();
    attachWindowMemory(win, store, MEMORY);

    win.maximized = true;
    win.bounds = { x: 0, y: 0, width: 1920, height: 1080 }; // 最大化后的 getBounds
    win.emits('resize');
    vi.advanceTimersByTime(500);
    expect(store.read()).toBeNull();
  });

  it('records the maximized flag immediately, and unmaximize restores normal geometry', () => {
    const store = fakeStore();
    attachWindowMemory(win, store, MEMORY);

    win.maximized = true;
    win.normalBounds = { x: 100, y: 100, width: 1600, height: 900 }; // maximize 前的还原尺寸
    win.bounds = { x: 0, y: 0, width: 1920, height: 1080 };
    win.emits('maximize');
    expect(store.read()?.maximized).toBe(true);
    expect(store.read()?.bounds).toEqual(MEMORY.bounds);

    win.maximized = false;
    win.bounds = { x: 50, y: 50, width: 1280, height: 800 };
    win.emits('unmaximize');
    expect(store.read()?.maximized).toBe(false);
    expect(store.read()?.bounds).toEqual({ x: 50, y: 50, width: 1280, height: 800 });
  });

  it('does not let the music/compact size overwrite the remembered normal geometry', () => {
    const store = fakeStore();
    attachWindowMemory(win, store, MEMORY);

    setMusicMode(win, true);
    expect(win.getBounds().width).not.toBe(1600); // 真的换成竖窄屏了
    win.emits('resize'); // 音乐模式里改尺寸不该被记成"正常几何"
    vi.advanceTimersByTime(500);
    const saved = store.read();
    expect(saved?.profile).toBe('music');
    expect(saved?.bounds).toEqual(MEMORY.bounds);
  });

  it('writes the profile whenever it changes', () => {
    const store = fakeStore();
    attachWindowMemory(win, store, MEMORY);

    setCompactMode(win, true);
    expect(store.read()).toEqual({ ...MEMORY, profile: 'compact', music: false });

    setMusicMode(win, true); // 浮窗里切音乐模式：只改标志
    expect(store.read()).toEqual({ ...MEMORY, profile: 'compact', music: true });

    setCompactMode(win, false); // 依旧在音乐模式
    expect(store.read()).toEqual({ ...MEMORY, profile: 'music', music: true });

    setMusicMode(win, false);
    expect(store.read()).toEqual({ ...MEMORY, profile: 'normal', music: false });
  });

  it('flushes on close and via flushWindowMemory (will-quit 兜底)', () => {
    const store = fakeStore();
    attachWindowMemory(win, store, MEMORY);

    win.bounds = { x: 10, y: 10, width: 1280, height: 800 };
    win.emits('resize');
    win.emits('close'); // 防抖还没到点也要落盘
    expect(store.read()?.bounds).toEqual({ x: 10, y: 10, width: 1280, height: 800 });

    win.bounds = { x: 20, y: 20, width: 1024, height: 768 };
    flushWindowMemory();
    expect(store.read()?.bounds).toEqual({ x: 20, y: 20, width: 1024, height: 768 });
  });

  it('keeps the compact size out of the memory when the app quits inside the widget', () => {
    const store = fakeStore();
    attachWindowMemory(win, store, MEMORY);

    setCompactMode(win, true); // 窗口真的缩成 400×300（getNormalBounds 也这么说）
    expect(win.getBounds().width).toBe(COMPACT_WIDTH);
    flushWindowMemory();
    expect(store.read()).toEqual({ ...MEMORY, profile: 'compact' });
  });
});

describe('restoreWindowProfile（启动套用记忆）', () => {
  let win: FakeWin;

  beforeEach(() => {
    win = fakeWin();
    resetWindowMemory();
    resetProfile(win);
  });

  afterEach(() => {
    resetWindowMemory();
    resetProfile(win);
  });

  it('music：进竖窄屏，且退出后回到记忆里的正常几何', () => {
    restoreWindowProfile(win, { ...MEMORY, profile: 'music', music: true });
    expect(win.getBounds().width).toBe(MUSIC_WIDTH);
    setMusicMode(win, false);
    expect(win.getBounds()).toEqual(MEMORY.bounds);
  });

  it('compact：进浮窗；还原后按底层模式回正常几何（影视）', () => {
    restoreWindowProfile(win, { ...MEMORY, profile: 'compact', music: false });
    expect(win.getBounds().width).toBe(COMPACT_WIDTH);
    expect(getWindowProfile()).toEqual({ compact: true, music: false });
    setCompactMode(win, false);
    expect(win.getBounds()).toEqual(MEMORY.bounds);
  });

  it('compact + music：浮窗里仍记得是从音乐模式进来的（还原回正常，不是竖屏）', () => {
    restoreWindowProfile(win, { ...MEMORY, profile: 'compact', music: true });
    expect(getWindowProfile()).toEqual({ compact: true, music: true });
    setCompactMode(win, false);
    expect(win.getBounds().width).toBe(MUSIC_WIDTH); // 退回竖窄屏
    setMusicMode(win, false);
    expect(win.getBounds()).toEqual(MEMORY.bounds);
  });

  it('normal：不预置快照，之后进音乐模式抓的是当时窗口的真实几何', () => {
    const live = { x: 300, y: 200, width: 1300, height: 780 };
    win.bounds = { ...live }; // 用户这一轮挪过窗口
    restoreWindowProfile(win, MEMORY);
    expect(getWindowProfile()).toEqual({ compact: false, music: false });

    setMusicMode(win, true);
    setMusicMode(win, false);
    expect(win.getBounds()).toEqual(live); // 而不是记忆里的 MEMORY.bounds
  });
});
