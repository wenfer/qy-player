// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import Visualizer, { waveformAmplitude } from '../../../src/renderer/components/Visualizer';

/**
 * 拾音器（QYP3-023）：波形包络是纯函数（无频谱数据时的降级路径），
 * 组件在无 2D 上下文（jsdom/受限环境）时必须静默跳过而不是崩。
 */
describe('visualizer (QYP3-023)', () => {
  // jsdom 无 2D 上下文：显式返回 null（组件静默跳过，且不打印 jsdom 噪音）
  HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as never;

  it('waveform envelope is deterministic and bounded', () => {
    const total = 48;
    const values = Array.from({ length: total }, (_, i) => waveformAmplitude(i, total));
    for (const v of values) {
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    // 同一 index 恒定（不逐帧抖动）
    expect(waveformAmplitude(10, total)).toBe(waveformAmplitude(10, total));
    // 中间高、两端低
    expect(values[Math.floor(total / 2)]).toBeGreaterThan(values[0]);
    expect(values[Math.floor(total / 2)]).toBeGreaterThan(values[total - 1]);
    expect(waveformAmplitude(0, 0)).toBe(0);
  });

  it('renders a canvas without throwing when 2D context is unavailable', () => {
    const { container } = render(
      <Visualizer
        mode="waveform"
        getSpectrum={vi.fn(() => null)}
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

  it('falls back to waveform when spectrum returns all zeros (mpv silent element)', () => {
    const SPECTRUM_COLOR = 'rgba(255, 209, 102, 0.9)';
    const WAVE_UNPLAYED = 'rgba(148, 163, 184, 0.45)';
    const fillStyles: string[] = [];
    const fakeCtx = {
      fillStyle: '',
      clearRect: vi.fn(),
      fillRect: vi.fn(function (this: { fillStyle: string }) {
        fillStyles.push(this.fillStyle);
      }),
    };
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

    try {
      const { container } = render(
        <Visualizer
          mode="spectrum"
          getSpectrum={vi.fn(() => new Uint8Array(1024))}
          isPlaying
          position={0}
          duration={100}
          height={24}
        />
      );
      expect(container.querySelector('canvas')).toBeTruthy();
      // 全 0 频谱绝不能画成静止的 1px 细条（spectrum 色），必须走波形降级
      expect(fillStyles).not.toContain(SPECTRUM_COLOR);
      expect(fillStyles).toContain(WAVE_UNPLAYED);
    } finally {
      HTMLCanvasElement.prototype.getContext = origGetContext;
      globalThis.requestAnimationFrame = origRaf;
    }
  });

  it('draws real spectrum bars when data is non-zero (webaudio engine)', () => {
    const SPECTRUM_COLOR = 'rgba(255, 209, 102, 0.9)';
    const fillStyles: string[] = [];
    const fakeCtx = {
      fillStyle: '',
      clearRect: vi.fn(),
      fillRect: vi.fn(function (this: { fillStyle: string }) {
        fillStyles.push(this.fillStyle);
      }),
    };
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

    try {
      const data = new Uint8Array(1024);
      data.fill(180);
      const { container } = render(
        <Visualizer
          mode="spectrum"
          getSpectrum={vi.fn(() => data)}
          isPlaying
          position={0}
          duration={100}
          height={24}
        />
      );
      expect(container.querySelector('canvas')).toBeTruthy();
      expect(fillStyles).toContain(SPECTRUM_COLOR);
    } finally {
      HTMLCanvasElement.prototype.getContext = origGetContext;
      globalThis.requestAnimationFrame = origRaf;
    }
  });
});
