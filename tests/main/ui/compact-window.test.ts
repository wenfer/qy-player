import { describe, expect, it, vi } from 'vitest';

/**
 * 精简浮窗几何（QYP3-035）：主窗口原地缩到指定显示器工作区的右上角。
 * `screen`/`BrowserWindow` 由 electron 提供，测试只验纯函数几何。
 */
vi.mock('electron', () => ({
  BrowserWindow: class {},
  screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
}));

import type { BrowserWindow, Rectangle } from 'electron';
import {
  compactBounds,
  musicBounds,
  setCompactMode,
  setMusicMode,
  getWindowProfile,
  COMPACT_HEIGHT,
  COMPACT_MARGIN,
  COMPACT_WIDTH,
  MUSIC_HEIGHT,
  MUSIC_MARGIN,
  MUSIC_WIDTH,
} from '../../../src/main/modules/ui-shell/compact-window';

describe('compactBounds (QYP3-035)', () => {
  it('pins to the top-right of the work area with a margin', () => {
    const b = compactBounds({ x: 0, y: 0, width: 1920 });
    expect(b.width).toBe(COMPACT_WIDTH);
    expect(b.height).toBe(COMPACT_HEIGHT);
    expect(b.x).toBe(1920 - COMPACT_WIDTH - COMPACT_MARGIN);
    expect(b.y).toBe(COMPACT_MARGIN);
  });

  it('respects a non-zero work area origin (multi-monitor)', () => {
    const b = compactBounds({ x: 1920, y: 100, width: 1280 });
    expect(b.x).toBe(1920 + 1280 - COMPACT_WIDTH - COMPACT_MARGIN);
    expect(b.y).toBe(100 + COMPACT_MARGIN);
  });
});

describe('musicBounds (QYP3-044)', () => {
  it('is a portrait window centered in the work area', () => {
    const b = musicBounds({ x: 0, y: 0, width: 1920, height: 1080 });
    expect(b.width).toBe(MUSIC_WIDTH);
    expect(b.height).toBe(MUSIC_HEIGHT);
    expect(b.x).toBe((1920 - MUSIC_WIDTH) / 2);
    expect(b.y).toBe((1080 - MUSIC_HEIGHT) / 2);
    expect(b.height).toBeGreaterThan(b.width); // 竖屏
  });

  it('clamps to a short screen (old 768p boxes) instead of overflowing', () => {
    const b = musicBounds({ x: 0, y: 30, width: 1366, height: 700 });
    expect(b.height).toBe(700 - MUSIC_MARGIN * 2);
    expect(b.y).toBe(30 + MUSIC_MARGIN);
    expect(b.height).toBeGreaterThanOrEqual(600); // 不低于最小下限
  });

  it('respects a non-zero work area origin (multi-monitor)', () => {
    const b = musicBounds({ x: 1920, y: 100, width: 1280, height: 1024 });
    expect(b.x).toBe(1920 + (1280 - MUSIC_WIDTH) / 2);
    expect(b.y).toBe(100 + (1024 - MUSIC_HEIGHT) / 2);
  });
});

/** 假窗口：只实现 setCompactMode / setMusicMode 用到的那几个方法。 */
function fakeWin(bounds = { x: 100, y: 100, width: 1600, height: 900 }) {
  const calls: string[] = [];
  const win = {
    bounds: { ...bounds },
    resizable: true,
    alwaysOnTop: false,
    calls,
    isDestroyed: () => false,
    isResizable: () => win.resizable,
    isAlwaysOnTop: () => win.alwaysOnTop,
    isMaximized: () => false,
    unmaximize: () => undefined,
    getBounds: () => ({ ...win.bounds }),
    setBounds: (b: Rectangle) => {
      win.bounds = { ...b };
      calls.push(`bounds:${b.width}x${b.height}`);
    },
    setResizable: (v: boolean) => {
      win.resizable = v;
    },
    setAlwaysOnTop: (v: boolean) => {
      win.alwaysOnTop = v;
    },
    setMinimumSize: (w: number, h: number) => calls.push(`min:${w}x${h}`),
  };
  return win as unknown as BrowserWindow & { bounds: Rectangle; calls: string[] };
}

/** 几何状态是模块级的：用例之间先归位，免得互相污染。 */
function resetProfile(win: BrowserWindow): void {
  setCompactMode(win, false);
  setMusicMode(win, false);
}

describe('profile 回填与叠加（QYP3-044 修复）', () => {
  it('reload 后主进程仍记得浮窗/竖屏，且重复下发不再挪动窗口', () => {
    const win = fakeWin();
    resetProfile(win);
    setCompactMode(win, true);
    expect(getWindowProfile()).toEqual({ compact: true, music: false });
    // 渲染层 reload 后回填：先发 music（浮窗优先，不动几何），再发 compact
    setMusicMode(win, true);
    expect(getWindowProfile()).toEqual({ compact: true, music: true });
    const afterEnter = win.calls.length;
    setCompactMode(win, true); // 幂等
    expect(win.calls.length).toBe(afterEnter);
  });

  it('退出浮窗回到竖屏而不是正常尺寸（音乐模式里开过浮窗）', () => {
    const win = fakeWin();
    resetProfile(win);
    setMusicMode(win, true);
    expect(win.bounds.width).toBe(MUSIC_WIDTH);
    setCompactMode(win, true);
    expect(win.bounds.width).toBe(COMPACT_WIDTH);
    setCompactMode(win, false);
    expect(win.bounds.width).toBe(MUSIC_WIDTH);
    expect(getWindowProfile()).toEqual({ compact: false, music: true });
    setMusicMode(win, false);
    expect(win.bounds.width).toBe(1600); // 回到进音乐模式前的尺寸
  });
});
