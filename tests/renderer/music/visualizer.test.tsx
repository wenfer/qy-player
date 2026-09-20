// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import Visualizer from '../../../src/renderer/components/Visualizer';
import {
  BAR_COLORS,
  PEAK_COLOR,
} from '../../../src/renderer/components/Visualizer/bars-painter';

/**
 * 拾音器（QYP3-023 / QYP3-033）：只有 renderer 内置引擎才有真实波形；
 * mpv/静音源无真实数据时必须画静态进度线，绝不能画假跳动的正弦波。
 * 组件在无 2D 上下文（jsdom/受限环境）必须静默跳过而不是崩。
 * QYP3-047：频谱改成经典弹跳柱（分段 LED + 峰值帽），颜色取自 bars-painter。
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
    opts: { mode: 'spectrum' | 'waveform'; getSpectrum: () => Uint8Array | null; getWaveform: () => Uint8Array | null; isPlaying?: boolean; height?: number },
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
        height={opts.height ?? 32}
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
    const captured = mount({
      mode: 'spectrum',
      getSpectrum: () => data,
      getWaveform: () => null,
    });
    // 分段 LED：底段琥珀、顶段红，外加峰值帽
    expect(captured).toContain(BAR_COLORS.low);
    expect(captured).toContain(BAR_COLORS.high);
    expect(captured).toContain(PEAK_COLOR);
  });

  it('freezes the last real frame when paused instead of falling back to an idle line', () => {
    const IDLE = 'rgba(148, 163, 184, 0.4)'; // 无数据时的静音底线
    const data = new Uint8Array(1024);
    data.fill(255);
    const captured = mount({
      mode: 'spectrum',
      getSpectrum: () => data,
      getWaveform: () => null,
      isPlaying: false, // 暂停：频谱不该消失（进度是播放条自己的一行）
    });
    expect(captured).toContain(BAR_COLORS.low);
    expect(captured).not.toContain(IDLE);
  });

  it('draws only an idle line when spectrum is all zeros (mpv silent element)', () => {
    const SPECTRUM_COLOR = 'rgba(255, 209, 102, 0.9)';
    const IDLE = 'rgba(148, 163, 184, 0.4)';
    const captured = mount({
      mode: 'spectrum',
      getSpectrum: () => new Uint8Array(1024), // 全 0 → 无真实数据
      getWaveform: () => null,
    });
    // 无真实数据：绝不画假频谱条，也不画进度（进度归播放条），只有一根静音底线
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
    });
    // 真实波形条（居中镜像，幅度由采样驱动）必然画出琥珀色
    expect(captured).toContain(SPECTRUM_COLOR);
  });

  it('draws only an idle line when no real waveform is available (mpv source)', () => {
    const SPECTRUM_COLOR = 'rgba(255, 209, 102, 0.9)';
    const IDLE = 'rgba(148, 163, 184, 0.4)';
    const captured = mount({
      mode: 'waveform',
      getSpectrum: () => null,
      getWaveform: () => null, // 无真实波形（mpv 源）
    });
    // 无真实波形：不画假跳动，也不画进度（进度归播放条），只有一根静音底线
    expect(captured).not.toContain(SPECTRUM_COLOR);
    expect(captured).toContain(IDLE);
  });
});
