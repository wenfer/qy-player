import { useEffect, useRef } from 'react';
import { useVisualizerFps } from '../../stores/resource-store';
import {
  createBarsPainter,
  createSpectrumDecay,
  FALL_PER_SEC,
  type BarsPainter,
  type SpectrumDecay,
} from './bars-painter';

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
 * **静音底线**（绝不画假跳动的正弦波）——诚实呈现"此源无真实波形"。
 *
 * QYP3-049：暂停不等于"没数据"——无真实数据的音源（mpv）画静音底线，
 * 有真实数据的音源画真实画面，二者不混用。
 * QYP3-059：暂停时频谱**整体回落**——不再冻结最后一帧（冻结会让人误以为
 * 还在出声）：柱体按指数衰减平滑回落、峰值帽随后落底，落定后停掉 rAF
 * 不空转；重新播放时从活数据立即恢复。
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
  /** 频谱数据源（renderer 引擎频域快照；无则静音底线）。 */
  getSpectrum: () => Uint8Array | null;
  /** 波形数据源（renderer 引擎时域快照；无/静音则静音底线）。 */
  getWaveform: () => Uint8Array | null;
  isPlaying: boolean;
  height?: number;
  className?: string;
}

const BARS = 48;
/** 拾音器 32px 高，8 段 LED 已经够密。 */
const SEGMENTS = 8;
const SPECTRUM_COLOR = 'rgba(255, 209, 102, 0.9)';
const IDLE_LINE = 'rgba(148, 163, 184, 0.4)';

/**
 * 拿不到真实数据时画一条**静音底线**（QYP3-049：只是一根灰线，不再画进度——
 * 进度是播放条自己的一行，画在上面既重复又没用）。绝不假跳动。
 */
function drawIdleLine(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const barH = Math.max(2, Math.round(h * 0.14));
  const y = Math.round((h - barH) / 2);
  ctx.fillStyle = IDLE_LINE;
  ctx.fillRect(0, y, w, barH);
}

export default function Visualizer({
  mode,
  getSpectrum,
  getWaveform,
  isPlaying,
  height = 28,
  className = '',
}: VisualizerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // 性能保护（QYP3-036）：CPU 紧张时降帧，优先保证播放不卡
  const frameMs = 1000 / Math.max(1, useVisualizerFps(30));
  // painter / 暂停回落缓存 / 波形柱高必须跨 effect 重跑存活（effect 依赖里有
  // isPlaying，暂停/恢复都会重建 effect；换曲快照由新数据自然覆盖）
  const painterRef = useRef<BarsPainter | null>(null);
  const decayRef = useRef<SpectrumDecay | null>(null);
  const frozenWaveRef = useRef<Uint8Array | null>(null);
  const waveHeadsRef = useRef<Float32Array | null>(null);

  useEffect(() => {
    // 换模式 / 换高度：柱数与段数变了，painter、回落缓存与波形柱高都作废
    painterRef.current = null;
    decayRef.current = null;
    frozenWaveRef.current = null;
    waveHeadsRef.current = null;
  }, [mode, height]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return; // jsdom / 无 2D 上下文：静默跳过

    let raf = 0;
    let last = 0;
    /** 复用缓冲区：每帧新建数组在 30fps 下是没必要的 GC 压力。 */
    const keep = (buf: Uint8Array | null, src: Uint8Array): Uint8Array => {
      const out = buf && buf.length === src.length ? buf : new Uint8Array(src.length);
      out.set(src);
      return out;
    };
    const dpr = Math.min(2, typeof devicePixelRatio === 'number' ? devicePixelRatio : 1);
    const resize = (): void => {
      canvas.width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
      canvas.height = Math.max(1, Math.floor(height * dpr));
    };
    resize();

    const draw = (now: number): void => {
      raf = requestAnimationFrame(draw);
      if (now - last < frameMs) return; // ≤30fps（性能保护下更低）
      // 先算 dt 再推进 last，否则峰值帽永远不落。钳到 100ms：effect 重跑
      // （暂停/恢复）后 last 从 0 起算，首帧 dt 会是页面运行时长——不钳的话
      // 暂停回落快照会被一帧清空（QYP3-059）
      const dt = Math.min(now - last, 100);
      last = now;
      const w = canvas.width;
      const h = canvas.height;

      if (mode === 'spectrum') {
        const live = getSpectrum();
        const liveOk = Boolean(live && live.length > 0 && !isAllZero(live));
        decayRef.current ??= createSpectrumDecay();
        const decay = decayRef.current;
        // 播放中画真实数据；暂停（QYP3-059）喂指数衰减的快照——柱体平滑回落、
        // 峰值帽随后落底，落定后停帧，绝不冻结最后一帧（会让人误以为还在出声）
        if (isPlaying ? liveOk : decay.hasSnapshot()) {
          const feed = decay.feed(liveOk ? live : null, isPlaying, dt);
          painterRef.current ??= createBarsPainter(ctx, { bars: BARS, segments: SEGMENTS });
          ctx.clearRect(0, 0, w, h);
          painterRef.current.paint(w, h, feed, dt);
          if (!isPlaying && painterRef.current.settled()) {
            cancelAnimationFrame(raf);
            raf = 0;
          }
          return;
        }
        // 无真实频谱（mpv 静音元素全 0 / 未起播）→ 静音底线
        ctx.clearRect(0, 0, w, h);
        drawIdleLine(ctx, w, h);
        return;
      }

      // waveform：真实时域波形（居中镜像，幅度由实际采样驱动）。
      // 暂停（QYP3-059）柱高按峰值帽同款速率线性回落，落定后停帧
      const liveWave = getWaveform();
      const liveOk = Boolean(liveWave && liveWave.length > 0 && !isFlatTimeDomain(liveWave));
      if (isPlaying ? liveOk : frozenWaveRef.current !== null) {
        if (isPlaying && liveWave) frozenWaveRef.current = keep(frozenWaveRef.current, liveWave);
        const heads =
          waveHeadsRef.current && waveHeadsRef.current.length === BARS
            ? waveHeadsRef.current
            : (waveHeadsRef.current = new Float32Array(BARS));
        const fall = (dt / 1000) * FALL_PER_SEC;
        let anyLit = false;
        for (let i = 0; i < BARS; i += 1) {
          if (isPlaying && liveWave) {
            const step = Math.max(1, Math.floor(liveWave.length / BARS));
            let peak = 0;
            for (let k = i * step; k < (i + 1) * step && k < liveWave.length; k += 1) {
              const dev = Math.abs((liveWave[k] ?? 128) - 128);
              if (dev > peak) peak = dev;
            }
            heads[i] = peak / 128;
          } else {
            heads[i] = Math.max(0, heads[i] - fall);
          }
          if (heads[i] > 0.01) anyLit = true;
        }
        ctx.clearRect(0, 0, w, h);
        if (anyLit) {
          ctx.fillStyle = SPECTRUM_COLOR;
          const barW = w / BARS;
          for (let i = 0; i < BARS; i += 1) {
            if (heads[i] <= 0.01) continue;
            const barH = Math.max(1, heads[i] * h * 0.9);
            // 像素对齐（QYP3-068）：同 bars-painter，分数坐标的抗锯齿边让小柱发糊
            const x = Math.round(i * barW + barW * 0.2);
            const bw = Math.max(1, Math.round(barW * 0.6));
            ctx.fillRect(x, Math.round((h - barH) / 2), bw, Math.max(1, Math.round(barH)));
          }
        }
        if (!isPlaying && !anyLit) {
          cancelAnimationFrame(raf);
          raf = 0;
        }
        return;
      }
      // 无真实波形（mpv 静音元素全 128 / 未起播）→ 静音底线
      ctx.clearRect(0, 0, w, h);
      drawIdleLine(ctx, w, h);
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [mode, getSpectrum, getWaveform, isPlaying, height, frameMs]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className={`w-full block ${className}`}
      style={{ height }}
    />
  );
}
