// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import Visualizer, { waveformAmplitude } from '../../../src/renderer/components/Visualizer';

/**
 * 拾音器（QYP3-023）：波形包络是纯函数（无频谱数据时的降级路径），
 * 组件在无 2D 上下文（jsdom/受限环境）时必须静默跳过而不是崩。
 */
describe('visualizer (QYP3-023)', () => {
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
});
