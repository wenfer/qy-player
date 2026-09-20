// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SpectrumGraph from '../../../src/renderer/components/SpectrumGraph';

/**
 * 播放频谱图（QYP3-034 / QYP3-047）：真数据只在内置引擎（webaudio）下才有；
 * mpv 引擎必须如实提示"无法显示真实频谱"，绝不画假跳动。
 * QYP3-047 起只有经典弹跳柱状一种（瀑布声谱图与图表持久化已移除）。
 */

beforeEach(() => {
  // jsdom 无 2D 上下文：显式返回 null（组件静默跳过绘制）
  HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as never;
});

describe('SpectrumGraph component (QYP3-034 / QYP3-047)', () => {
  it('shows an honest hint for the mpv engine (no real spectrum)', () => {
    render(
      <SpectrumGraph
        engine="mpv"
        getSpectrum={() => null}
        isPlaying
        title="服务器曲目"
        artist="某歌手"
      />
    );
    expect(screen.getByText(/无法显示真实频谱/)).toBeTruthy();
    // mpv 下绝不画画布（不画假跳动）
    expect(document.querySelector('canvas')).toBeNull();
  });

  it('renders a canvas for the webaudio engine', () => {
    render(
      <SpectrumGraph
        engine="webaudio"
        getSpectrum={() => new Uint8Array(1024)}
        isPlaying
        title="本地曲目"
      />
    );
    expect(document.querySelector('canvas')).toBeTruthy();
    expect(screen.queryByText(/无法显示真实频谱/)).toBeNull();
  });

  it('has no chart switch anymore (bars only, QYP3-047)', () => {
    render(
      <SpectrumGraph
        engine="webaudio"
        getSpectrum={() => new Uint8Array(1024)}
        isPlaying
        title="本地曲目"
      />
    );
    expect(screen.queryByLabelText(/瀑布/)).toBeNull();
    expect(document.querySelectorAll('canvas').length).toBe(1);
  });
});
