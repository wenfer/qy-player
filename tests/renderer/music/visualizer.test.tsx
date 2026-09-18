// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import Visualizer from '../../../src/renderer/components/Visualizer';

/**
 * 拾音器（QYP3-023 / QYP3-033）：只有 renderer 内置引擎才有真实波形；
 * mpv/静音源无真实数据时必须画静态进度线，绝不能画假跳动的正弦波。
 * 组件在无 2D 上下文（jsdom/受限环境）必须静默跳过而不是崩。
 */
describe('visualizer (QYP3-023/033)', () => {
  // jsdom 无 2D 上下文：显式返回 null（组件静默跳过，且不打印 jsdom 噪音）
  HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as never;

  function fakeCtx2D(): {
    fillStyle: string;
    clearRect: ReturnType<typeof vi.fn>;
    fillRect: ReturnType<typeof vi.fn>;
    captured: string[];
  } {
    const captured: string[] = [];
    return {
      fillStyle: '',
      clearRect: vi.fn(),
      fillRect: vi.fn(function (this: { fillStyle: string }) {
        captured.push(this.fillStyle);
      }),
      captured,
    };
  }

  function mount(
    opts: { mode: 'spectrum' | 'waveform'; getSpectrum: () => Uint8Array | null; getWaveform: () => Uint8Array | null; isPlaying?: boolean; position?: number; duration?: number; height?: number },
  ) {
    const fakeCtx = fakeCtx2D();
    const origGetContext = HTMLCanvasElement.prototype.getContext;
    const origRaf = globalThis.requestAnimationFrame;
    let rafCount = 0;
    HTMLCanvasElement.prototype.getContext = vi.fn(() => fakeCtx) as unknown as typeof HTMLCanvasElement.prototype.getContext;
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      if (rafCount < 3) {
        rafCount += 1;
        cb(rafCount * 16);
      }
      return rafCount;
    }) as typeof requestAnimationFrame;
    const { container } = render(
      <Visualizer
        mode={opts.mode}
        getSpectrum={opts.getSpectrum}
        getWaveform={opts.getWaveform}
        isPlaying={opts.isPlaying ?? true}
        position={opts.position ?? 0}
        duration={opts.duration ?? 100}
        height={opts.height ?? 24}
      />
    );
    void container;
    HTMLCanvasElement.prototype.getContext = origGetContext;
    globalThis.requestAnimationFrame = origRaf;
    return fakeCtx.captured;
  }

  it('renders a canvas without throwing when 2D context is unavailable', () => {
    const { container } = render(
      <Visualizer
        mode="waveform"
        getSpectrum={vi.fn(() => null)}
        getWaveform={vi.fn(() => null)}
        isPlaying
        position={10}
        duration={100}
        height={24}
      />
    );
    const canvas = container.querySelector('canvas');
    expect(canvas).toBeTruthy();
    expect((canvas as HTMLCanvasElement).style.height).toBe('24px');
  });

  it('draws real spectrum bars when spectrum data is non-zero (webaudio engine)', () => {
    const SPECTRUM_COLOR = 'rgba(255, 209, 102, 0.9)';
    const data = new Uint8Array(1024);
    data.fill(180);
    const captured = mount({
      mode: 'spectrum',
      getSpectrum: () => data,
      getWaveform: () => null,
    });
    expect(captured).toContain(SPECTRUM_COLOR);
  });

  it('draws only a static progress line when spectrum is all zeros (mpv silent element)', () => {
    const SPECTRUM_COLOR = 'rgba(255, 209, 102, 0.9)';
    const IDLE = 'rgba(148, 163, 184, 0.4)';
    const captured = mount({
      mode: 'spectrum',
      getSpectrum: () => new Uint8Array(1024), // 全 0 → 无真实数据
      getWaveform: () => null,
      position: 0,
      duration: 100,
    });
    // 无真实数据：绝不画假频谱条；只画一条静态进度线（position=0 无播放段）
    expect(captured).not.toContain(SPECTRUM_COLOR);
    expect(captured).toContain(IDLE);
  });

  it('draws real waveform bars when time-domain data is non-flat (webaudio engine)', () => {
    const SPECTRUM_COLOR = 'rgba(255, 209, 102, 0.9)';
    // 非静音：在 60/200 间摆动（偏离 128 > 3），触发真实波形绘制
    const wave = new Uint8Array(2048);
    for (let i = 0; i < wave.length; i += 1) wave[i] = i % 2 === 0 ? 60 : 200;
    const captured = mount({
      mode: 'waveform',
      getSpectrum: () => null,
      getWaveform: () => wave,
      position: 0,
      duration: 100,
    });
    // 真实波形条（居中镜像，幅度由采样驱动）必然画出琥珀色
    expect(captured).toContain(SPECTRUM_COLOR);
  });

  it('draws a static progress line (played + idle) when no real waveform is available', () => {
    const SPECTRUM_COLOR = 'rgba(255, 209, 102, 0.9)';
    const IDLE = 'rgba(148, 163, 184, 0.4)';
    const captured = mount({
      mode: 'waveform',
      getSpectrum: () => null,
      getWaveform: () => null, // 无真实波形（mpv 源）
      position: 50,
      duration: 100,
    });
    // 静态进度线：播放段琥珀 + 未播段灰
    expect(captured).toContain(SPECTRUM_COLOR);
    expect(captured).toContain(IDLE);
  });
});
