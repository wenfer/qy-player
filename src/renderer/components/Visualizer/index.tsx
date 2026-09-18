import { useEffect, useRef } from 'react';

/**
 * 拾音器（QYP3-023）：双模式可视化，帧率上限 30fps（老机预算）。
 * - spectrum：renderer 引擎 AnalyserNode 实时频谱（fftSize 2048）；
 * - waveform：mpv 引擎或无频谱数据时的播放波形——按 时长+进度 绘制
 *   （离线频谱 spike 失败后的降级路径，无需任何缓存/外部依赖）。
 */

export type VisualizerMode = 'spectrum' | 'waveform';

/** 波形振幅（确定性伪包络：同一 index 恒定，避免逐帧抖动）。 */
export function waveformAmplitude(index: number, total: number): number {
  if (total <= 0) return 0;
  const t = index / total;
  const envelope = Math.sin(Math.PI * t) * 0.7 + 0.3; // 两端低、中间高
  const ripple = 0.5 + 0.5 * Math.sin(index * 1.7) * Math.cos(index * 0.6);
  return Math.max(0.08, Math.min(1, envelope * (0.55 + 0.45 * ripple)));
}

/** 频谱全 0（mpv 引擎下渲染层 AnalyserNode 只接到静音元素）视为无数据。 */
function isAllZero(data: Uint8Array): boolean {
  for (let i = 0; i < data.length; i += 1) {
    if (data[i] !== 0) return false;
  }
  return true;
}

interface VisualizerProps {
  mode: VisualizerMode;
  /** 频谱数据源（renderer 引擎快照；无则自动画波形）。 */
  getSpectrum: () => Uint8Array | null;
  isPlaying: boolean;
  position: number;
  duration: number;
  height?: number;
  className?: string;
}

const BARS = 48;
const FRAME_MS = 1000 / 30;

export default function Visualizer({
  mode,
  getSpectrum,
  isPlaying,
  position,
  duration,
  height = 28,
  className = '',
}: VisualizerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return; // jsdom / 无 2D 上下文：静默跳过

    let raf = 0;
    let last = 0;
    const dpr = Math.min(2, typeof devicePixelRatio === 'number' ? devicePixelRatio : 1);
    const resize = (): void => {
      canvas.width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
      canvas.height = Math.max(1, Math.floor(height * dpr));
    };
    resize();

    const draw = (now: number): void => {
      raf = requestAnimationFrame(draw);
      if (now - last < FRAME_MS) return; // ≤30fps
      last = now;
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);

      if (mode === 'spectrum') {
        const data = isPlaying ? getSpectrum() : null;
        if (data && data.length > 0 && !isAllZero(data)) {
          const step = Math.max(1, Math.floor(data.length / BARS));
          const barW = w / BARS;
          for (let i = 0; i < BARS; i += 1) {
            let peak = 0;
            for (let k = 0; k < step; k += 1) {
              const v = data[i * step + k] ?? 0;
              if (v > peak) peak = v;
            }
            const barH = Math.max(1, (peak / 255) * h);
            ctx.fillStyle = 'rgba(255, 209, 102, 0.9)';
            ctx.fillRect(i * barW + barW * 0.2, h - barH, barW * 0.6, barH);
          }
          return;
        }
        // 无频谱数据（mpv 引擎静音元素全 0 / 未起播）→ 退化成波形，绝不空白闪烁
      }

      const progress = duration > 0 ? Math.min(1, Math.max(0, position / duration)) : 0;
      const barW = w / BARS;
      for (let i = 0; i < BARS; i += 1) {
        // 播放中按时间相位轻微起伏，让降级波形“活”起来（非真实频谱，仅供
        // mpv / 降级观感；真实音调频谱只在 webaudio 引擎下由 AnalyserNode 提供）。
        const lively = isPlaying ? 0.6 + 0.4 * Math.sin(now / 170 + i * 0.55) : 1;
        const amp = waveformAmplitude(i, BARS) * lively;
        const barH = Math.max(1, amp * h * 0.9);
        const played = i / BARS <= progress;
        ctx.fillStyle = played ? 'rgba(255, 209, 102, 0.95)' : 'rgba(148, 163, 184, 0.45)';
        ctx.fillRect(i * barW + barW * 0.2, (h - barH) / 2, barW * 0.6, barH);
      }
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [mode, getSpectrum, isPlaying, position, duration, height]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className={`w-full block ${className}`}
      style={{ height }}
    />
  );
}
