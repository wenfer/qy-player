/**
 * 经典风格的弹跳柱状频谱（QYP3-047）：分段 LED 柱 + 峰值帽。
 *
 * 柱体按"格"点亮（不是连续高度的实心条），顶端有一条峰值帽——电平掉下来时
 * 峰值帽**缓慢下落**而不是跟着瞬间归零，这就是经典频谱分析仪的"弹跳"手感。
 * 无数据（mpv 引擎）时上层组件画静态进度线，这里不画任何假跳动。
 *
 * QYP3-068r 起按老式功放 LED 面板的路子做两件事：①配色是**整格换色**的三段
 * 分区（绿 → 琥珀 → 红），不是沿着柱子的连续渐变——EL/LED 面板就是一行行
 * 定色的灯珠；②电平先整形再点亮（见 shapeLevel）——线性映射下真实音乐几乎
 * 每个频带都在满格附近，整块面板会糊成一堵色墙，看不出"跳"。
 */

/** 老式功放 LED 面板的三段分区（从下往上）。 */
export const LED_GREEN = 'rgba(52, 224, 122, 0.95)';
export const LED_AMBER = 'rgba(255, 196, 60, 0.95)';
export const LED_RED = 'rgba(255, 64, 48, 0.95)';

/** 分区边界（柱高比例）。按**格子中心**取，各段格数才不会随段数抖动。 */
const AMBER_FROM = 0.6;
const RED_FROM = 0.85;

/**
 * 第 s 格（0 = 最底一格）的颜色。
 * 整格同色，不做逐格插值——真实 LED 面板是"到哪一段换哪种灯珠"。
 */
export function segmentColor(s: number, segments: number): string {
  const ratio = (s + 0.5) / segments;
  if (ratio >= RED_FROM) return LED_RED;
  if (ratio >= AMBER_FROM) return LED_AMBER;
  return LED_GREEN;
}

/** 峰值帽颜色：中性亮白，压在三段分区的任何一种上都清楚。 */
export const PEAK_COLOR = 'rgba(255, 255, 255, 0.92)';

/** 峰值帽下落速度（每秒下落的画面高度比例）。 */
export const FALL_PER_SEC = 0.55;

/** 噪声底：低于它的电平一律当作"没有信号"（音乐里的底噪不该点亮灯珠）。 */
export const LEVEL_FLOOR = 0.12;
/** 显示曲线指数（γ > 1：字节刻度本身是对数的，但落进 16 格仍挤在高位）。 */
export const LEVEL_GAMMA = 2;

/**
 * 电平整形（QYP3-068r）：先扣噪声底，再按 γ 压中低电平。
 *
 * 字节刻度已经是 dB，可音乐的能量仍集中在高位——实测同一批文件里，人声流行
 * 的 p50 是 0.58、峰值 0.90，安静些的 FLAC p50 只有 0.27。不压的话一屏柱子
 * 全在 8~12 格（"一堵墙"），压完 0.6→0.36、0.8→0.64，柱子之间才拉得开。
 *
 * 注意：**调用方必须先做自动量程**（见 paint 里的 AGC）——固定刻度没法同时
 * 照顾响度差 10dB 的不同曲目。
 */
export function shapeLevel(level: number): number {
  if (!(level > 0)) return 0;
  const v = (level - LEVEL_FLOOR) / (1 - LEVEL_FLOOR);
  return v <= 0 ? 0 : Math.pow(v, LEVEL_GAMMA);
}

/**
 * 自动量程（QYP3-068r）。整库响度不齐——实测 live 版 mp3 的带峰值（0.90）比
 * 安静 FLAC（0.51）高一倍，固定刻度只能二选一：要么把安静的歌压成一排黑，
 * 要么把响的歌顶成一片。这里按"最近的参考电平"归一：参考值**立刻跟上**新峰值
 * （保住峰值指示），回落慢（τ≈2.5s，段落之间不来回抽气），并夹一个下限
 * （≈ -82dB）免得把底噪当成音乐放大。
 */
export const AGC_RELEASE_MS = 2500;
export const AGC_MIN_REF = 0.25;

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
  /** 自动量程的参考电平（见 AGC_RELEASE_MS 注释）。 */
  let ref = 0;

  return {
    paint(w, h, data, dtMs) {
      if (data && data.length > 0) {
        downsamplePeaks(data, bars, levels);
        // 自动量程（QYP3-068r）：先按参考电平归一，再过显示曲线
        let framePeak = 0;
        for (let i = 0; i < bars; i += 1) {
          if (levels[i] > framePeak) framePeak = levels[i];
        }
        ref = Math.max(
          framePeak,
          ref * Math.exp(-Math.max(0, dtMs) / AGC_RELEASE_MS),
          AGC_MIN_REF
        );
        const gain = 1 / ref;
        for (let i = 0; i < bars; i += 1) levels[i] = shapeLevel(levels[i] * gain);
      } else {
        levels.fill(0);
      }
      const fall = (Math.max(0, dtMs) / 1000) * FALL_PER_SEC;
      const barW = w / bars;
      const cellH = h / segments;
      // 段间距（QYP3-068r：0.28 → 0.34）：格子之间留得开，一排排灯珠才数得清
      const gap = Math.max(1, cellH * 0.34);
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
          // 整格换色：绿 → 琥珀 → 红（老式 LED 面板的分段，不做逐格渐变）
          ctx.fillStyle = segmentColor(s, segments);
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
 * 播放中缓存最新一帧频谱；暂停后按指数衰减把缓存喂回 painter，
 * 柱体平滑回落、峰值帽随后落底（painter.settled()），然后调用方停帧不空转。
 *
 * τ 默认 450ms（QYP3-068r 从 150ms 调大）：衰减作用在**原始字节**上，之后还要
 * 过一遍 γ 曲线（等效于视觉上再平方一次），150ms 会让暂停的柱子"啪"一下塌掉。
 * 450ms 之后视觉半衰期与加重整形前基本一致（≈100ms），仍是平滑回落。
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

export function createSpectrumDecay(tauMs = 450): SpectrumDecay {
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
