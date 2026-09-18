// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SpectrumGraph, {
  downsampleSpectrum,
  heatColor,
} from '../../../src/renderer/components/SpectrumGraph';

/**
 * 播放频谱图（QYP3-034）：真数据只在内置引擎（webaudio）下才有；mpv 引擎必须
 * 如实提示"无法显示真实频谱"，绝不画假跳动。图表选择持久化到
 * playback.spectrumChart（SETTINGS.GET/SET 对称）。
 */

const api = {
  getSettings: vi.fn((): Promise<{ ok: boolean; data: unknown }> => Promise.resolve({ ok: true, data: null })),
  setSettings: vi.fn(() => Promise.resolve({ ok: true })),
};

vi.stubGlobal('electronAPI', api);

beforeEach(() => {
  vi.clearAllMocks();
  api.getSettings.mockResolvedValue({ ok: true, data: null });
  // jsdom 无 2D 上下文：显式返回 null（组件静默跳过绘制）
  HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as never;
});

describe('SpectrumGraph helpers (QYP3-034)', () => {
  it('downsampleSpectrum groups by peak', () => {
    const data = new Uint8Array([0, 10, 20, 30, 40, 50, 60, 70]);
    expect(Array.from(downsampleSpectrum(data, 4))).toEqual([10, 30, 50, 70]);
  });

  it('downsampleSpectrum is empty-safe', () => {
    expect(Array.from(downsampleSpectrum(new Uint8Array(0), 4))).toEqual([0, 0, 0, 0]);
    expect(downsampleSpectrum(new Uint8Array([1, 2, 3]), 0).length).toBe(0);
  });

  it('heatColor clamps out-of-range and returns rgb strings', () => {
    expect(heatColor(0)).toBe('rgb(12, 16, 28)');
    expect(heatColor(255)).toBe('rgb(232, 72, 60)');
    expect(heatColor(-5)).toBe('rgb(12, 16, 28)');
    expect(heatColor(999)).toBe('rgb(232, 72, 60)');
    expect(heatColor(128)).toMatch(/^rgb\(\d+, \d+, \d+\)$/);
  });
});

describe('SpectrumGraph component (QYP3-034)', () => {
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

  it('persists the chart choice when toggling to waterfall', async () => {
    render(
      <SpectrumGraph
        engine="webaudio"
        getSpectrum={() => new Uint8Array(1024)}
        isPlaying
        title="本地曲目"
      />
    );
    fireEvent.click(screen.getByLabelText('瀑布声谱图'));
    await waitFor(() =>
      expect(api.setSettings).toHaveBeenCalledWith('playback.spectrumChart', 'waterfall')
    );
  });

  it('loads the persisted chart choice', async () => {
    api.getSettings.mockResolvedValue({ ok: true, data: 'waterfall' });
    render(
      <SpectrumGraph
        engine="webaudio"
        getSpectrum={() => new Uint8Array(1024)}
        isPlaying
        title="本地曲目"
      />
    );
    await waitFor(() =>
      expect(screen.getByLabelText('瀑布声谱图').getAttribute('aria-pressed')).toBe('true')
    );
  });
});
