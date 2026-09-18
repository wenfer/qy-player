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
  COMPACT_HEIGHT,
  COMPACT_MARGIN,
  COMPACT_WIDTH,
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
