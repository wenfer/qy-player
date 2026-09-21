/**
 * 经典风格的弹跳柱状频谱（QYP3-047）：分段 LED 柱 + 峰值帽。
 *
 * 柱体按"格"点亮（不是连续高度的实心条），顶端有一条峰值帽——电平掉下来时
 * 峰值帽**缓慢下落**而不是跟着瞬间归零，这就是经典频谱分析仪的"弹跳"手感。
 * 无数据（mpv 引擎）时上层组件画静态进度线，这里不画任何假跳动。
 */

/** 柱体颜色：由下往上 琥珀 → 橙 → 红（经典分段配色）。 */
export const BAR_COLORS = {
  low: 'rgba(255, 209, 102, 0.95)',
  mid: 'rgba(255, 153, 61, 0.95)',
  high: 'rgba(239, 68, 68, 0.95)',
} as const;

/** 峰值帽颜色（比柱体亮，视觉上"浮"在顶端）。 */
export const PEAK_COLOR = 'rgba(255, 243, 214, 0.9)';

/** 峰值帽下落速度（每秒下落的画面高度比例）。 */
export const FALL_PER_SEC = 0.55;

/** 某一段（0=底，1=顶）的颜色。 */
export function cellColor(t: number): string {
  if (t < 0.55) return BAR_COLORS.low;
  if (t < 0.8) return BAR_COLORS.mid;
  return BAR_COLORS.high;
}

/** 点亮的格数：电平 0..1 → 0..segments（至少 0，最大 segments）。 */
export function litCells(level: number, segments: number): number {
  if (!(level > 0)) return 0;
  return Math.min(segments, Math.round(level * segments));
}

/** 频率快照 → 每组峰值并归一到 0..1（真数据下采样；UI 不关心 FFT 分辨率）。 */
export function downsamplePeaks(data: Uint8Array, bars: number, out: Float32Array): Float32Array {
  if (data.length === 0) {
    out.fill(0);
    return out;
  }
  for (let i = 0; i < bars; i += 1) {
    const start = Math.floor((i * data.length) / bars);
    const end = Math.max(start + 1, Math.floor(((i + 1) * data.length) / bars));
    let peak = 0;
    for (let k = start; k < end && k < data.length; k += 1) {
      if (data[k] > peak) peak = data[k];
    }
    out[i] = peak / 255;
  }
  return out;
}

export interface BarsPainterOptions {
  bars?: number;
  segments?: number;
}

export interface BarsPainter {
  /** w/h 为画布设备像素；dtMs 用于峰值帽下落（时间驱动，掉帧也不跳）。 */
  paint: (w: number, h: number, data: Uint8Array | null, dtMs: number) => void;
  /** 所有峰值帽都已落到底（暂停回落完成后可停帧，QYP3-059）。 */
  settled: () => boolean;
}

export function createBarsPainter(
  ctx: CanvasRenderingContext2D,
  options: BarsPainterOptions = {}
): BarsPainter {
  const bars = Math.max(1, options.bars ?? 48);
  const segments = Math.max(2, options.segments ?? 8);
  const levels = new Float32Array(bars);
  const peaks = new Float32Array(bars);

  return {
    paint(w, h, data, dtMs) {
      if (data && data.length > 0) downsamplePeaks(data, bars, levels);
      else levels.fill(0);
      const fall = (Math.max(0, dtMs) / 1000) * FALL_PER_SEC;
      const barW = w / bars;
      const cellH = h / segments;
      const gap = Math.max(1, cellH * 0.28);
      const capH = Math.max(1, Math.round(cellH * 0.22));

      for (let i = 0; i < bars; i += 1) {
        const level = levels[i];
        peaks[i] = Math.max(level, peaks[i] - fall);
        // 像素对齐（QYP3-068）：LED 格子只有几个像素大，分数坐标会触发
        // canvas 抗锯齿——每条边都摊上半透明过渡像素，小格子上糊成重影。
        // 全部取整后每格落在整数像素上，边缘干脆
        const x = Math.round(i * barW + barW * 0.16);
        const bw = Math.max(1, Math.round(barW * 0.68));

        const lit = litCells(level, segments);
        for (let s = 0; s < lit; s += 1) {
          ctx.fillStyle = cellColor(segments > 1 ? s / (segments - 1) : 0);
          const y = Math.round(h - (s + 1) * cellH + gap / 2);
          ctx.fillRect(x, y, bw, Math.max(1, Math.round(cellH - gap)));
        }

        if (peaks[i] > 0.02) {
          const py = Math.round(Math.min(h - capH, Math.max(0, h - peaks[i] * h - capH)));
          ctx.fillStyle = PEAK_COLOR;
          ctx.fillRect(x, py, bw, capH);
        }
      }
    },
    settled() {
      for (let i = 0; i < bars; i += 1) {
        if (peaks[i] > 0.02) return false;
      }
      return true;
    },
  };
}

/**
 * 暂停回落（QYP3-059）：暂停不能冻结最后一帧——会让人误以为还在出声。
 * 播放中缓存最新一帧频谱；暂停后按指数衰减（τ≈150ms）把缓存喂回 painter，
 * 柱体平滑回落、峰值帽随后落底（painter.settled()），然后调用方停帧不空转。
 */
export interface SpectrumDecay {
  /**
   * 每帧调用：播放中缓存 live 并原样返回（live 为 null 时返回 null）；
   * 暂停中返回衰减后的缓存快照（没有缓存过就返回 null）。
   */
  feed: (live: Uint8Array | null, playing: boolean, dtMs: number) => Uint8Array | null;
  /** 是否缓存过真实数据（决定暂停时走"回落"还是"无数据提示"）。 */
  hasSnapshot: () => boolean;
}

export function createSpectrumDecay(tauMs = 150): SpectrumDecay {
  let buf: Uint8Array | null = null;
  return {
    feed(live, playing, dtMs) {
      if (playing) {
        if (live && live.length > 0) {
          if (!buf || buf.length !== live.length) buf = new Uint8Array(live.length);
          buf.set(live);
          return live;
        }
        return null;
      }
      if (!buf) return null;
      const f = Math.exp(-Math.max(0, dtMs) / tauMs);
      for (let i = 0; i < buf.length; i += 1) {
        buf[i] = Math.floor(buf[i] * f);
      }
      return buf;
    },
    hasSnapshot: () => buf !== null,
  };
}
