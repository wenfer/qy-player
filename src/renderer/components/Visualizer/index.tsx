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
 *
 * QYP3-049：暂停不等于"没数据"。此前暂停时 `isPlaying=false` 直接走静态进度线，
 * 频谱凭空消失；现在暂停会把最后一帧真实数据**冻结**在画布上（只画一次），
 * 进度交给播放条自己的那一行。
 */

export type VisualizerMode = 'spectrum' | 'waveform';

/**
 * 冻结帧（QYP3-049）：暂停后音源不再出新数据，画面要**停在最后一帧**，
 * 而不是退化成进度条——进度是进度条自己的一行，二者同时显示、互不替代。
 * `painted` 记的是"已经画进画布的那一帧"，避免暂停后还空转 rAF 重画。
 */
interface FrozenFrame {
  spec: Uint8Array | null;
  wave: Uint8Array | null;
  painted: Uint8Array | null;
}

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
  // 峰值帽与冻结帧必须跨 effect 重跑存活（QYP3-049）：否则进度每走一秒 effect
  // 就重建一次，峰值被打回当前电平、暂停时冻不住画面
  const painterRef = useRef<BarsPainter | null>(null);
  const frozenRef = useRef<FrozenFrame>({ spec: null, wave: null, painted: null });

  useEffect(() => {
    // 换模式 / 换高度：柱数与段数变了，painter 与"已画过冻结帧"的标记都作废
    painterRef.current = null;
    frozenRef.current.painted = null;
  }, [mode, height]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return; // jsdom / 无 2D 上下文：静默跳过

    const frozen = frozenRef.current;
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
      frozen.painted = null; // 改 canvas.width 会清空画布，冻结帧得重画
    };
    resize();

    const draw = (now: number): void => {
      raf = requestAnimationFrame(draw);
      if (now - last < frameMs) return; // ≤30fps（性能保护下更低）
      const dt = now - last; // 先算 dt 再推进 last，否则峰值帽永远不落
      last = now;
      const w = canvas.width;
      const h = canvas.height;

      if (mode === 'spectrum') {
        const live = getSpectrum();
        if (live && live.length > 0 && !isAllZero(live)) {
          frozen.spec = keep(frozen.spec, live);
        }
        const data = isPlaying ? live : (frozen.spec ?? live);
        if (data && data.length > 0 && !isAllZero(data)) {
          // 冻结帧只画一次：画布内容还在，别清了又不画（暂停时不必空转 rAF）
          if (!isPlaying && data === frozen.spec && frozen.painted === frozen.spec) return;
          frozen.painted = frozen.spec;
          ctx.clearRect(0, 0, w, h);
          // 经典弹跳柱（QYP3-047）：分段 LED + 峰值帽，dt 驱动峰值下落
          painterRef.current ??= createBarsPainter(ctx, { bars: BARS, segments: SEGMENTS });
          painterRef.current.paint(w, h, data, isPlaying ? dt : 0);
          return;
        }
        // 无真实频谱（mpv 静音元素全 0 / 未起播）→ 静态进度线
        ctx.clearRect(0, 0, w, h);
        drawIdleLine(ctx, w, h);
        return;
      }

      // waveform：真实时域波形（居中镜像，幅度由实际采样驱动）
      const liveWave = getWaveform();
      if (liveWave && liveWave.length > 0 && !isFlatTimeDomain(liveWave)) {
        frozen.wave = keep(frozen.wave, liveWave);
      }
      const wave = isPlaying ? liveWave : (frozen.wave ?? liveWave);
      if (wave && wave.length > 0 && !isFlatTimeDomain(wave)) {
        if (!isPlaying && wave === frozen.wave && frozen.painted === frozen.wave) return;
        frozen.painted = frozen.wave;
        ctx.clearRect(0, 0, w, h);
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
