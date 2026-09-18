import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Activity, BarChart3, Waves } from 'lucide-react';

/**
 * 播放频谱图（QYP3-034）：音乐页顶部内嵌，播放音乐时常驻，随音调实时跳动。
 *
 * 真实频谱只有 renderer 内置引擎（Web Audio）解码的音轨才有；mpv 引擎
 * （服务器 / WebDAV / CUE / 冷门格式，以及兜底到 mpv 的本地 FLAC）在 mpv 0.32
 * 下没有暴露实时频谱的 IPC 接口（`audio-fft` 是 0.34+ 才有，升级会破坏老系统
 * 兼容）→ 面板如实提示"无法显示真实频谱"，**绝不画假跳动**。
 *
 * 两种图表：柱状（实时频率分布）/ 瀑布（频率随时间的滚动热力图）。
 * 帧率 ≤30fps（老机预算）；图表选择持久化到 `playback.spectrumChart`。
 */

export type SpectrumChart = 'bars' | 'waterfall';

const BARS = 64;
const BINS = 96;
const FRAME_MS = 1000 / 30;
/** 瀑布每帧左移的列宽（canvas px）。 */
const COL_W = 2;
const BARS_COLOR = 'rgba(255, 209, 102, 0.92)';
const WATERFALL_BG = '#0b1018';

/** 频率快照 → bins 组峰值（真数据下采样；UI 不关心 FFT 分辨率）。 */
export function downsampleSpectrum(data: Uint8Array, bins: number): Uint8Array {
  const out = new Uint8Array(Math.max(0, bins));
  if (data.length === 0 || bins <= 0) return out;
  for (let i = 0; i < bins; i += 1) {
    const start = Math.floor((i * data.length) / bins);
    const end = Math.max(start + 1, Math.floor(((i + 1) * data.length) / bins));
    let peak = 0;
    for (let k = start; k < end && k < data.length; k += 1) {
      if (data[k] > peak) peak = data[k];
    }
    out[i] = peak;
  }
  return out;
}

/** 强度 0..255 → 热力图颜色（暗 → 蓝 → 青 → 黄 → 红）。 */
export function heatColor(value: number): string {
  const t = Math.max(0, Math.min(1, value / 255));
  const stops: Array<[number, number[]]> = [
    [0.0, [12, 16, 28]],
    [0.25, [34, 76, 170]],
    [0.5, [46, 186, 178]],
    [0.75, [242, 201, 76]],
    [1.0, [232, 72, 60]],
  ];
  for (let i = 0; i < stops.length - 1; i += 1) {
    const [t0, c0] = stops[i];
    const [t1, c1] = stops[i + 1];
    if (t <= t1) {
      const f = t1 === t0 ? 0 : (t - t0) / (t1 - t0);
      const r = Math.round(c0[0] + (c1[0] - c0[0]) * f);
      const g = Math.round(c0[1] + (c1[1] - c0[1]) * f);
      const b = Math.round(c0[2] + (c1[2] - c0[2]) * f);
      return `rgb(${r}, ${g}, ${b})`;
    }
  }
  return 'rgb(232, 72, 60)';
}

interface SpectrumGraphProps {
  engine: 'webaudio' | 'mpv' | null;
  getSpectrum: () => Uint8Array | null;
  isPlaying: boolean;
  title: string;
  artist?: string | null;
  height?: number;
  /** 头部右侧额外内容（如精简模式的还原按钮），渲染在图表切换按钮之前。 */
  headerExtra?: ReactNode;
}

export default function SpectrumGraph({
  engine,
  getSpectrum,
  isPlaying,
  title,
  artist,
  height = 168,
  headerExtra,
}: SpectrumGraphProps) {
  const [chart, setChart] = useState<SpectrumChart>('bars');
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // 图表选择持久化（读回设置；SETTINGS.GET/SET 是 JSON 对称契约）
  useEffect(() => {
    const api = window.electronAPI;
    void Promise.resolve(api.getSettings?.('playback.spectrumChart'))
      .then((res) => {
        const v = (res as { data?: unknown } | undefined)?.data;
        if (v === 'bars' || v === 'waterfall') setChart(v);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    // mpv 无真实频谱：不画（面板显示提示）；暂停时冻结上一帧
    if (engine !== 'webaudio' || !isPlaying) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return; // jsdom / 无 2D 上下文：静默跳过

    const dpr = Math.min(2, typeof devicePixelRatio === 'number' ? devicePixelRatio : 1);
    // 瀑布需要一个离屏画布做整体左移（自画自的 drawImage 优化不稳）
    const off = document.createElement('canvas');
    const offCtx = off.getContext('2d');
    if (!offCtx) return;

    const resize = (): void => {
      canvas.width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
      canvas.height = Math.max(1, Math.floor(height * dpr));
      off.width = canvas.width;
      off.height = canvas.height;
    };
    resize();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
    ro?.observe(canvas);

    const drawBars = (w: number, h: number): void => {
      ctx.clearRect(0, 0, w, h);
      const data = getSpectrum();
      const bars = data && data.length > 0 ? downsampleSpectrum(data, BARS) : null;
      const barW = w / BARS;
      ctx.fillStyle = BARS_COLOR;
      for (let i = 0; i < BARS; i += 1) {
        const v = bars ? bars[i] : 0;
        const barH = Math.max(1, (v / 255) * h);
        ctx.fillRect(i * barW + barW * 0.15, h - barH, barW * 0.7, barH);
      }
    };

    const drawWaterfall = (w: number, h: number): void => {
      // 先把上一帧拷到离屏，再把离屏整体左移 COL_W，右侧留出写新列的位置
      offCtx.clearRect(0, 0, w, h);
      offCtx.drawImage(canvas, 0, 0);
      ctx.fillStyle = WATERFALL_BG;
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(off, -COL_W, 0);
      const data = getSpectrum();
      const col = data && data.length > 0 ? downsampleSpectrum(data, BINS) : new Uint8Array(BINS);
      const binH = h / BINS;
      const x = w - COL_W;
      for (let b = 0; b < BINS; b += 1) {
        ctx.fillStyle = heatColor(col[b]);
        // 低频在下、高频在上（声谱图惯例）
        ctx.fillRect(x, h - (b + 1) * binH, COL_W, binH);
      }
    };

    let raf = 0;
    let last = 0;
    const draw = (now: number): void => {
      raf = requestAnimationFrame(draw);
      if (now - last < FRAME_MS) return; // ≤30fps
      last = now;
      const w = canvas.width;
      const h = canvas.height;
      if (chart === 'bars') drawBars(w, h);
      else drawWaterfall(w, h);
    };

    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      ro?.disconnect();
    };
  }, [engine, isPlaying, chart, getSpectrum, height]);

  const changeChart = (next: SpectrumChart): void => {
    setChart(next);
    void Promise.resolve(window.electronAPI.setSettings?.('playback.spectrumChart', next)).catch(
      () => undefined
    );
  };

  const tabClass = (active: boolean): string =>
    `px-2 py-1 rounded-lg text-[11px] flex items-center gap-1 focus-ring transition-colors ${
      active ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
    }`;

  return (
    <div className="mb-6 rounded-xl border border-border bg-card/60 overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border">
        <Activity size={14} className="text-muted-foreground flex-shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-xs truncate">
            {title}
            {artist ? <span className="text-muted-foreground"> · {artist}</span> : null}
          </p>
          <p className="text-[10px] text-muted-foreground">频谱图</p>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {headerExtra}
          <button
            type="button"
            onClick={() => changeChart('bars')}
            aria-pressed={chart === 'bars'}
            aria-label="柱状频谱"
            className={tabClass(chart === 'bars')}
          >
            <BarChart3 size={12} /> 柱状
          </button>
          <button
            type="button"
            onClick={() => changeChart('waterfall')}
            aria-pressed={chart === 'waterfall'}
            aria-label="瀑布声谱图"
            className={tabClass(chart === 'waterfall')}
          >
            <Waves size={12} /> 瀑布
          </button>
        </div>
      </div>

      {engine === 'webaudio' ? (
        <canvas ref={canvasRef} aria-hidden className="w-full block" style={{ height }} />
      ) : (
        <div className="flex items-center justify-center px-4 text-center" style={{ height }}>
          <p className="text-[11px] text-muted-foreground max-w-md">
            此音源经 mpv 解码，mpv 0.32 没有实时频谱接口，无法显示真实频谱。
          </p>
        </div>
      )}
    </div>
  );
}
