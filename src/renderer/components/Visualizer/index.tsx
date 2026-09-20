import { useEffect, useRef } from 'react';
import { useVisualizerFps } from '../../stores/resource-store';
import { createBarsPainter, type BarsPainter } from './bars-painter';

/**
 * 拾音器（QYP3-023 / QYP3-033）：双模式可视化，帧率上限 30fps（老机预算）。
 *
 * 真实数据只有「renderer 内置引擎（Web Audio）」解码的音轨才有——
 * AnalyserNode 同时提供频域（getSpectrum）与时域（getWaveform）。
 * mpv 引擎（服务器/WebDAV/CUE，以及因非法封面兜底到 mpv 的本地 FLAC）
 * 在 mpv 0.32 下无法暴露实时频谱/波形（audio-fft 是 0.34+ 才有），渲染层
 * 拿到的 AnalyserNode 只接到静音元素 → 全 0 / 全 128。
 *
 * 因此：有真实数据就画真实频谱/波形；拿不到真实数据（mpv 或静音）则画一条
 * **静态进度线**（绝不画假跳动的正弦波）——诚实呈现"此源无真实波形"。
 */

export type VisualizerMode = 'spectrum' | 'waveform';

/** 频谱全 0（mpv 引擎下渲染层 AnalyserNode 只接到静音元素）视为无数据。 */
function isAllZero(data: Uint8Array): boolean {
  for (let i = 0; i < data.length; i += 1) {
    if (data[i] !== 0) return false;
  }
  return true;
}

/** 时域波形全在 128 附近（±3）→ 静音/无信号，视为无真实数据。 */
function isFlatTimeDomain(data: Uint8Array): boolean {
  for (let i = 0; i < data.length; i += 1) {
    const v = data[i];
    if (v < 125 || v > 131) return false;
  }
  return true;
}

interface VisualizerProps {
  mode: VisualizerMode;
  /** 频谱数据源（renderer 引擎频域快照；无则静态进度线）。 */
  getSpectrum: () => Uint8Array | null;
  /** 波形数据源（renderer 引擎时域快照；无/静音则静态进度线）。 */
  getWaveform: () => Uint8Array | null;
  isPlaying: boolean;
  position: number;
  duration: number;
  height?: number;
  className?: string;
}

const BARS = 48;
/** 拾音器只有 24px 高，8 段 LED 已经够密。 */
const SEGMENTS = 8;
const SPECTRUM_COLOR = 'rgba(255, 209, 102, 0.9)';
const PROGRESS_PLAYED = 'rgba(255, 209, 102, 0.9)';
const PROGRESS_IDLE = 'rgba(148, 163, 184, 0.4)';

/** 无真实数据时画一条静态进度线（播放段琥珀、未播段灰），绝不假跳动。 */
function drawStaticProgress(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  progress: number
): void {
  const barH = Math.max(2, Math.round(h * 0.14));
  const y = Math.round((h - barH) / 2);
  ctx.fillStyle = PROGRESS_IDLE;
  ctx.fillRect(0, y, w, barH);
  if (progress > 0) {
    ctx.fillStyle = PROGRESS_PLAYED;
    ctx.fillRect(0, y, w * progress, barH);
  }
}

export default function Visualizer({
  mode,
  getSpectrum,
  getWaveform,
  isPlaying,
  position,
  duration,
  height = 28,
  className = '',
}: VisualizerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // 性能保护（QYP3-036）：CPU 紧张时降帧，优先保证播放不卡
  const frameMs = 1000 / Math.max(1, useVisualizerFps(30));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return; // jsdom / 无 2D 上下文：静默跳过

    let raf = 0;
    let last = 0;
    let painter: BarsPainter | null = null;
    const dpr = Math.min(2, typeof devicePixelRatio === 'number' ? devicePixelRatio : 1);
    const resize = (): void => {
      canvas.width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
      canvas.height = Math.max(1, Math.floor(height * dpr));
    };
    resize();

    const draw = (now: number): void => {
      raf = requestAnimationFrame(draw);
      if (now - last < frameMs) return; // ≤30fps（性能保护下更低）
      const dt = now - last; // 先算 dt 再推进 last，否则峰值帽永远不落
      last = now;
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);

      const progress = duration > 0 ? Math.min(1, Math.max(0, position / duration)) : 0;

      if (mode === 'spectrum') {
        const data = isPlaying ? getSpectrum() : null;
        if (data && data.length > 0 && !isAllZero(data)) {
          // 经典弹跳柱（QYP3-047）：分段 LED + 峰值帽，dt 驱动峰值下落
          painter ??= createBarsPainter(ctx, { bars: BARS, segments: SEGMENTS });
          painter.paint(w, h, data, dt);
          return;
        }
        // 无真实频谱（mpv 静音元素全 0 / 未起播）→ 静态进度线
        drawStaticProgress(ctx, w, h, progress);
        return;
      }

      // waveform：真实时域波形（居中镜像，幅度由实际采样驱动）
      const wave = isPlaying ? getWaveform() : null;
      if (wave && wave.length > 0 && !isFlatTimeDomain(wave)) {
        const step = Math.max(1, Math.floor(wave.length / BARS));
        const barW = w / BARS;
        for (let i = 0; i < BARS; i += 1) {
          let peak = 0;
          for (let k = 0; k < step; k += 1) {
            const v = wave[i * step + k] ?? 128;
            const dev = Math.abs(v - 128);
            if (dev > peak) peak = dev;
          }
          const norm = peak / 128;
          const barH = Math.max(1, norm * h * 0.9);
          ctx.fillStyle = SPECTRUM_COLOR;
          ctx.fillRect(i * barW + barW * 0.2, (h - barH) / 2, barW * 0.6, barH);
        }
        return;
      }
      // 无真实波形（mpv 静音元素全 128 / 未起播）→ 静态进度线
      drawStaticProgress(ctx, w, h, progress);
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [mode, getSpectrum, getWaveform, isPlaying, position, duration, height, frameMs]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className={`w-full block ${className}`}
      style={{ height }}
    />
  );
}
