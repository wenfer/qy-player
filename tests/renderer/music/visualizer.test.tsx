// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Visualizer, { type VisualizerMode } from '../../../src/renderer/components/Visualizer';
import {
  BAR_COLOR,
  PEAK_COLOR,
} from '../../../src/renderer/components/Visualizer/bars-painter';

/**
 * 拾音器（QYP3-023 / QYP3-033）：只有 renderer 内置引擎才有真实波形；
 * mpv/静音源无真实数据时必须画静音底线，绝不能画假跳动的正弦波。
 * 组件在无 2D 上下文（jsdom/受限环境）必须静默跳过而不是崩。
 * QYP3-047：频谱改成经典弹跳柱（分段 LED + 峰值帽），颜色取自 bars-painter。
 * QYP3-059：暂停不再冻结最后一帧——柱体平滑回落、峰值帽落底后停帧。
 */
describe('visualizer (QYP3-023/033)', () => {
  // jsdom 无 2D 上下文：显式返回 null（组件静默跳过，且不打印 jsdom 噪音）
  HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as never;

  const IDLE = 'rgba(148, 163, 184, 0.4)'; // 无数据时的静音底线

  // 假 rAF / 假 2D 上下文全程生效（beforeEach 安装 / afterEach 恢复）。
  // cancel 必须**真删**队列条目，否则暂停后旧播放循环的待执行帧还会继续画
  // 实时数据；getContext 必须跨 rerender 存活，否则暂停后 effect 重跑拿到
  // null 上下文会直接早退、一帧都不画
  let queue: Map<number, (t: number) => void>;
  let nextId: number;
  let tick: number;
  let activeCtx: CanvasRenderingContext2D | null = null;
  let origRaf: typeof globalThis.requestAnimationFrame;
  let origCaf: typeof globalThis.cancelAnimationFrame;
  let origGetContext: typeof HTMLCanvasElement.prototype.getContext;

  beforeEach(() => {
    queue = new Map();
    nextId = 1;
    tick = 0;
    activeCtx = null;
    origRaf = globalThis.requestAnimationFrame;
    origCaf = globalThis.cancelAnimationFrame;
    origGetContext = HTMLCanvasElement.prototype.getContext;
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      const id = nextId;
      nextId += 1;
      queue.set(id, cb);
      return id;
    }) as typeof requestAnimationFrame;
    globalThis.cancelAnimationFrame = ((id: number) => {
      queue.delete(id);
    }) as unknown as typeof cancelAnimationFrame;
    HTMLCanvasElement.prototype.getContext = vi.fn(
      () => activeCtx
    ) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  });

  afterEach(() => {
    globalThis.requestAnimationFrame = origRaf;
    globalThis.cancelAnimationFrame = origCaf;
    HTMLCanvasElement.prototype.getContext = origGetContext;
  });

  /**
   * 假 rAF：cb 进队列不立即执行，由 flush(n) 手动推进（这样才能在"播放中"
   * 与"暂停后"之间 rerender）。frames[i] 是第 i 帧里 fillRect 用到的颜色。
   * 时间戳默认 40ms 一帧（> frameMs≈33ms，每帧都真正落笔）。
   */
  function mount(opts: {
    mode: VisualizerMode;
    getSpectrum: () => Uint8Array | null;
    getWaveform: () => Uint8Array | null;
    isPlaying?: boolean;
    height?: number;
    /** rAF 时间戳序列（ms）；flush 总帧数不能超过序列长度。 */
    timeline?: number[];
    /** mount 时（播放阶段）先跑多少帧。 */
    playFrames?: number;
  }) {
    const captured: string[][] = [];
    let current: string[] = [];
    const fakeCtx = {
      fillStyle: '',
      clearRect: vi.fn(),
      fillRect: vi.fn(function (this: { fillStyle: string }) {
        current.push(this.fillStyle);
      }),
    };
    activeCtx = fakeCtx as unknown as CanvasRenderingContext2D;

    const props = {
      mode: opts.mode,
      getSpectrum: opts.getSpectrum,
      getWaveform: opts.getWaveform,
      isPlaying: opts.isPlaying ?? true,
      height: opts.height ?? 32,
    };
    const view = render(<Visualizer {...props} />);
    const timeline = opts.timeline ?? [40, 80, 120];
    const flush = (n: number): void => {
      for (let i = 0; i < n; i += 1) {
        const first = queue.keys().next();
        if (first.done || tick >= timeline.length) break;
        const cb = queue.get(first.value)!;
        queue.delete(first.value);
        current = [];
        captured.push(current);
        tick += 1;
        cb(timeline[tick - 1]);
      }
    };
    flush(opts.playFrames ?? timeline.length);
    const rerender = (patch: Partial<{ isPlaying: boolean }>): void => {
      view.rerender(<Visualizer {...props} {...patch} />);
    };
    return { frames: captured, rerender, flush };
  }

  it('renders a canvas without throwing when 2D context is unavailable', () => {
    const { container } = render(
      <Visualizer
        mode="waveform"
        getSpectrum={vi.fn(() => null)}
        getWaveform={vi.fn(() => null)}
        isPlaying
        height={24}
      />
    );
    const canvas = container.querySelector('canvas');
    expect(canvas).toBeTruthy();
    expect((canvas as HTMLCanvasElement).style.height).toBe('24px');
  });

  it('draws classic bouncing LED bars when spectrum data is non-zero (webaudio engine)', () => {
    const data = new Uint8Array(1024);
    data.fill(255);
    const { frames } = mount({
      mode: 'spectrum',
      getSpectrum: () => data,
      getWaveform: () => null,
    });
    // 分段 LED：纯琥珀黄（用户偏好，无高度渐变），外加峰值帽
    expect(frames[0]).toContain(BAR_COLOR);
    expect(frames[0]).toContain(PEAK_COLOR);
  });

  it('falls back gradually after pause instead of freezing or vanishing (QYP3-059)', () => {
    const data = new Uint8Array(1024);
    data.fill(255);
    // 播放 3 帧（40/80/120ms）后暂停，再跑 ~2.5s（指数衰减 + 峰值帽落底）
    const { frames, rerender, flush } = mount({
      mode: 'spectrum',
      getSpectrum: () => data,
      getWaveform: () => null,
      timeline: Array.from({ length: 66 }, (_, i) => 40 * (i + 1)),
      playFrames: 3,
    });
    expect(frames[0]).toContain(BAR_COLOR);
    rerender({ isPlaying: false });
    flush(66);

    // 暂停初期柱体仍在（指数衰减刚开始）——是"回落"，不是瞬间清空
    const paused = frames.slice(3);
    expect(paused[0]).toContain(BAR_COLOR);
    // 全程不退化成静音底线（有数据源 ≠ 无数据源）
    expect(paused.every((f) => !f.includes(IDLE))).toBe(true);
    // 落定：最后一帧既无柱体也无峰值帽（rAF 已停，帧数不再增长）
    const last = paused[paused.length - 1];
    expect(last).not.toContain(BAR_COLOR);
    expect(last).not.toContain(PEAK_COLOR);
    expect(last.length).toBe(0);
  });

  it('shows the idle line when paused before any playback (nothing to fall back)', () => {
    const data = new Uint8Array(1024);
    data.fill(255);
    const { frames } = mount({
      mode: 'spectrum',
      getSpectrum: () => data,
      getWaveform: () => null,
      isPlaying: false, // 未起播就暂停：没有缓存过真实数据
    });
    expect(frames[0]).toContain(IDLE);
    expect(frames[0]).not.toContain(BAR_COLOR);
  });

  it('falls back to silence after pause in waveform mode too (QYP3-059)', () => {
    // 非静音：在 60/200 间摆动（偏离 128 > 3），触发真实波形绘制
    const wave = new Uint8Array(2048);
    for (let i = 0; i < wave.length; i += 1) wave[i] = i % 2 === 0 ? 60 : 200;
    const { frames, rerender, flush } = mount({
      mode: 'waveform',
      getSpectrum: () => null,
      getWaveform: () => wave,
      timeline: Array.from({ length: 40 }, (_, i) => 40 * (i + 1)),
      playFrames: 3,
    });
    expect(frames[0]).toContain('rgba(255, 209, 102, 0.9)');
    rerender({ isPlaying: false });
    flush(40);
    const paused = frames.slice(3);
    // 暂停初期柱体仍在（回落中），最终全部归零
    expect(paused[0]).toContain('rgba(255, 209, 102, 0.9)');
    const last = paused[paused.length - 1];
    expect(last).not.toContain('rgba(255, 209, 102, 0.9)');
    expect(last.length).toBe(0);
  });

  it('draws only an idle line when spectrum is all zeros (mpv silent element)', () => {
    const SPECTRUM_COLOR = 'rgba(255, 209, 102, 0.9)';
    const captured = mount({
      mode: 'spectrum',
      getSpectrum: () => new Uint8Array(1024), // 全 0 → 无真实数据
      getWaveform: () => null,
    });
    // 无真实数据：绝不画假频谱条，也不画进度（进度归播放条），只有一根静音底线
    expect(captured.frames[0]).not.toContain(SPECTRUM_COLOR);
    expect(captured.frames[0]).toContain(IDLE);
  });

  it('draws real waveform bars when time-domain data is non-flat (webaudio engine)', () => {
    const SPECTRUM_COLOR = 'rgba(255, 209, 102, 0.9)';
    // 非静音：在 60/200 间摆动（偏离 128 > 3），触发真实波形绘制
    const wave = new Uint8Array(2048);
    for (let i = 0; i < wave.length; i += 1) wave[i] = i % 2 === 0 ? 60 : 200;
    const { frames } = mount({
      mode: 'waveform',
      getSpectrum: () => null,
      getWaveform: () => wave,
    });
    // 真实波形条（居中镜像，幅度由采样驱动）必然画出琥珀色
    expect(frames[0]).toContain(SPECTRUM_COLOR);
  });

  it('draws only an idle line when no real waveform is available (mpv source)', () => {
    const SPECTRUM_COLOR = 'rgba(255, 209, 102, 0.9)';
    const captured = mount({
      mode: 'waveform',
      getSpectrum: () => null,
      getWaveform: () => null, // 无真实波形（mpv 源）
    });
    // 无真实波形：不画假跳动，也不画进度（进度归播放条），只有一根静音底线
    expect(captured.frames[0]).not.toContain(SPECTRUM_COLOR);
    expect(captured.frames[0]).toContain(IDLE);
  });
});
