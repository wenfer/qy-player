import { describe, expect, it, vi } from 'vitest';

/**
 * 精简浮窗几何（QYP3-035）：主窗口原地缩到指定显示器工作区的右上角。
 * `screen`/`BrowserWindow` 由 electron 提供，测试只验纯函数几何。
 */
vi.mock('electron', () => ({
  BrowserWindow: class {},
  screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
}));

import {
  compactBounds,
  musicBounds,
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
