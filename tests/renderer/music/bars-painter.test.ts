import { describe, expect, it, vi } from 'vitest';
import {
  BAR_COLORS,
  PEAK_COLOR,
  cellColor,
  createBarsPainter,
  downsamplePeaks,
  litCells,
} from '../../../src/renderer/components/Visualizer/bars-painter';

/**
 * 经典弹跳柱状频谱（QYP3-047）：分段 LED + 峰值帽。
 * 关注点：下采样取峰值、点亮的格数、峰值帽**缓慢下落**（不是跟着电平瞬间归零）。
 */

/** 记录 fillRect 的假 2D 上下文。 */
function fakeCtx() {
  const rects: Array<{ x: number; y: number; w: number; h: number; style: string }> = [];
  const ctx = {
    fillStyle: '',
    fillRect: vi.fn((x: number, y: number, w: number, h: number) => {
      rects.push({ x, y, w, h, style: ctx.fillStyle });
    }),
    clearRect: vi.fn(),
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, rects };
}

describe('bars-painter helpers (QYP3-047)', () => {
  it('downsamplePeaks takes the peak of each group, normalized to 0..1', () => {
    const data = new Uint8Array([0, 10, 20, 30, 40, 50, 60, 70]);
    const out = new Float32Array(4);
    downsamplePeaks(data, 4, out);
    const expected = [10 / 255, 30 / 255, 50 / 255, 70 / 255];
    out.forEach((v, i) => expect(v).toBeCloseTo(expected[i], 6));
  });

  it('downsamplePeaks is empty-safe', () => {
    const out = new Float32Array(4);
    expect(Array.from(downsamplePeaks(new Uint8Array(0), 4, out))).toEqual([0, 0, 0, 0]);
  });

  it('litCells maps level 0..1 to 0..segments', () => {
    expect(litCells(0, 8)).toBe(0);
    expect(litCells(-1, 8)).toBe(0);
    expect(litCells(1, 8)).toBe(8);
    expect(litCells(2, 8)).toBe(8); // 钳制
    expect(litCells(0.5, 8)).toBe(4);
  });

  it('cellColor goes amber → orange → red bottom-up', () => {
    expect(cellColor(0)).toBe(BAR_COLORS.low);
    expect(cellColor(0.6)).toBe(BAR_COLORS.mid);
    expect(cellColor(0.9)).toBe(BAR_COLORS.high);
  });
});

describe('createBarsPainter (QYP3-047)', () => {
  it('lights one LED cell per level step', () => {
    const { ctx, rects } = fakeCtx();
    const painter = createBarsPainter(ctx, { bars: 1, segments: 8 });
    painter.paint(100, 80, new Uint8Array([255]), 16);
    // 8 段全亮 + 1 条峰值帽
    expect(rects.filter((r) => r.style !== PEAK_COLOR).length).toBe(8);
  });

  it('drops the peak cap gradually instead of snapping to zero', () => {
    const { ctx, rects } = fakeCtx();
    const painter = createBarsPainter(ctx, { bars: 1, segments: 8 });
    painter.paint(100, 80, new Uint8Array([255, 255]), 16); // 满电平 → 峰值帽到顶
    const top = rects.filter((r) => r.style === PEAK_COLOR).pop();
    expect(top).toBeTruthy();
    const peakY = top!.y;
    expect(peakY).toBeLessThan(2); // 顶部

    rects.length = 0;
    // 电平掉到 0：一帧（200ms）内峰值帽只往下走一点点，绝不瞬间归零
    painter.paint(100, 80, new Uint8Array([0, 0]), 200);
    const after = rects.filter((r) => r.style === PEAK_COLOR).pop();
    expect(after).toBeTruthy();
    expect(after!.y).toBeGreaterThan(peakY);
    expect(after!.y).toBeLessThan(80 / 2); // 仍在画面上半部

    // 持续静音若干帧后峰值帽落回底部并消失（不再画）
    for (let i = 0; i < 100; i += 1) {
      rects.length = 0;
      painter.paint(100, 80, new Uint8Array([0, 0]), 33);
    }
    const settled = rects.filter((r) => r.style === PEAK_COLOR).pop();
    expect(settled).toBeUndefined();
  });

  it('draws nothing but empty bars when there is no data', () => {
    const { ctx, rects } = fakeCtx();
    const painter = createBarsPainter(ctx, { bars: 4, segments: 8 });
    painter.paint(100, 80, null, 16);
    expect(rects.length).toBe(0);
    painter.paint(100, 80, new Uint8Array(0), 16);
    expect(rects.length).toBe(0);
  });
});
