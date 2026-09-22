import { describe, expect, it, vi } from 'vitest';
import {
  LED_AMBER,
  LED_GREEN,
  LED_RED,
  PEAK_COLOR,
  createBarsPainter,
  createSpectrumDecay,
  downsamplePeaks,
  litCells,
  segmentColor,
  shapeLevel,
} from '../../../src/renderer/components/Visualizer/bars-painter';

/**
 * 经典弹跳柱状频谱（QYP3-047）：分段 LED + 峰值帽。
 * 关注点：下采样取峰值、点亮的格数、峰值帽**缓慢下落**（不是跟着电平瞬间归零）。
 * QYP3-068r：老式功放 LED 的三段分区配色（绿 → 琥珀 → 红）+ 电平整形。
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

  it('segmentColor splits the column into green / amber / red zones (QYP3-068r)', () => {
    // 8 段（拾音器）：绿 5 格 / 琥珀 2 格 / 红 1 格
    expect(Array.from({ length: 8 }, (_, s) => segmentColor(s, 8))).toEqual([
      LED_GREEN, LED_GREEN, LED_GREEN, LED_GREEN, LED_GREEN,
      LED_AMBER, LED_AMBER,
      LED_RED,
    ]);
    // 16 段（频谱图）：绿 10 格 / 琥珀 4 格 / 红 2 格——比例与 8 段一致
    const tall = Array.from({ length: 16 }, (_, s) => segmentColor(s, 16));
    expect(tall.filter((c) => c === LED_GREEN).length).toBe(10);
    expect(tall.filter((c) => c === LED_AMBER).length).toBe(4);
    expect(tall.filter((c) => c === LED_RED).length).toBe(2);
    // 整格换色：三段各自连续（去重后的出现顺序就是绿→琥珀→红）
    expect([...new Set(tall)]).toEqual([LED_GREEN, LED_AMBER, LED_RED]);
  });

  it('shapeLevel suppresses the noise floor and compresses mid levels (QYP3-068r)', () => {
    expect(shapeLevel(0)).toBe(0);
    expect(shapeLevel(-1)).toBe(0);
    expect(shapeLevel(0.1)).toBe(0); // 噪声底以下一律不点亮
    expect(shapeLevel(1)).toBeCloseTo(1, 6); // 满电平仍然顶格
    // 中低电平被压下来：0.6 → ~0.30，0.8 → ~0.61（柱子之间才拉得开）
    expect(shapeLevel(0.6)).toBeCloseTo(Math.pow(0.48 / 0.88, 2), 6);
    expect(shapeLevel(0.6)).toBeLessThan(0.35);
    expect(shapeLevel(0.8)).toBeLessThan(0.65);
    // 单调不减（不会出现"电平更高却更矮"）
    expect(shapeLevel(0.7)).toBeGreaterThan(shapeLevel(0.6));
  });
});

describe('createBarsPainter (QYP3-047)', () => {
  it('lights one LED cell per level step in the three-zone LED colors', () => {
    const { ctx, rects } = fakeCtx();
    const painter = createBarsPainter(ctx, { bars: 1, segments: 8 });
    painter.paint(100, 80, new Uint8Array([255]), 16);
    // 8 段全亮 + 1 条峰值帽；老式功放 LED 的绿/琥珀/红三段分区
    const cells = rects.filter((r) => r.style !== PEAK_COLOR);
    expect(cells.length).toBe(8);
    expect(cells.map((r) => r.style)).toEqual([
      LED_GREEN, LED_GREEN, LED_GREEN, LED_GREEN, LED_GREEN,
      LED_AMBER, LED_AMBER,
      LED_RED,
    ]);
    // 从下往上画：越靠上的格子 y 越小
    const ys = cells.map((r) => r.y);
    expect(ys).toEqual([...ys].sort((a, b) => b - a));
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

  it('auto-ranges quiet material instead of leaving the panel dark (QYP3-068r)', () => {
    // 0.25 的电平（安静曲目）在新 painter 上要顶格点亮——不归一的话 16 格里只亮 4 格
    const { ctx, rects } = fakeCtx();
    const painter = createBarsPainter(ctx, { bars: 1, segments: 8 });
    painter.paint(100, 80, new Uint8Array([64, 64]), 16);
    expect(rects.some((r) => r.style === LED_RED)).toBe(true);
  });

  it('keeps the reference on a recent loud peak instead of following every frame', () => {
    const { ctx, rects } = fakeCtx();
    const painter = createBarsPainter(ctx, { bars: 1, segments: 8 });
    painter.paint(100, 80, new Uint8Array([255]), 16); // 先来一记强拍
    rects.length = 0;
    painter.paint(100, 80, new Uint8Array([64, 64]), 16); // 紧跟着一小节安静
    // 参考电平回落要 2.5s 时间常数：这一帧不该被立刻放大到顶格
    expect(rects.some((r) => r.style === LED_RED)).toBe(false);
    expect(rects.filter((r) => r.style !== PEAK_COLOR).length).toBeLessThan(8);
  });

  it('settled() turns true only after the caps have fallen back (QYP3-059)', () => {
    const { ctx } = fakeCtx();
    const painter = createBarsPainter(ctx, { bars: 1, segments: 8 });
    painter.paint(100, 80, new Uint8Array([255, 255]), 16); // 满电平 → 峰值帽到顶
    expect(painter.settled()).toBe(false);
    // 持续喂零直到峰值帽落底
    for (let i = 0; i < 100 && !painter.settled(); i += 1) {
      painter.paint(100, 80, new Uint8Array([0, 0]), 33);
    }
    expect(painter.settled()).toBe(true);
    // 无数据起步（从未有峰值）：立即落定
    const fresh = createBarsPainter((fakeCtx().ctx), { bars: 1, segments: 8 });
    fresh.paint(100, 80, null, 16);
    expect(fresh.settled()).toBe(true);
  });
});

describe('createSpectrumDecay (QYP3-059)', () => {
  it('caches the live frame while playing, decays it toward zero when paused', () => {
    const decay = createSpectrumDecay(150);
    expect(decay.hasSnapshot()).toBe(false);
    const live = new Uint8Array([255, 128]);
    expect(decay.feed(live, true, 40)).toBe(live); // 播放中原样返回
    expect(decay.hasSnapshot()).toBe(true);

    const d1 = decay.feed(null, false, 40)!;
    expect(d1[0]).toBe(Math.floor(255 * Math.exp(-40 / 150)));
    expect(d1[1]).toBe(Math.floor(128 * Math.exp(-40 / 150)));

    // 播放中传 null 不清缓存；持续衰减到全零后缓存仍保留（"有过数据"的标记）
    expect(decay.feed(null, true, 40)).toBeNull();
    for (let i = 0; i < 100; i += 1) decay.feed(null, false, 40);
    expect(decay.hasSnapshot()).toBe(true);
    expect(decay.feed(null, false, 40)!.every((v) => v === 0)).toBe(true);
  });
});
