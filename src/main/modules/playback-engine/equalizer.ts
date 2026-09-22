/**
 * 均衡器契约（QYP3-012，计划 §6/§7）：10 频段、预设、双引擎参数映射。
 *
 * 单一来源：renderer 引擎（BiquadFilter dB）与 mpv 引擎（af=lavfi 链）
 * 各消费一份映射，这里只产参数，不做 IO。
 * 频段与 renderer/player/web-audio-engine.ts 的 EQ_BANDS 保持一致
 *（60..16k，10 段；对应 filter 类型：≤350 lowshelf / ≥9k highshelf /
 * 中间 peaking）。注意 mpv 侧这三个 "类型" 是**三个不同滤镜**，见
 * `mpvAudioFilterFromEq` 的注释。
 */

export interface EqPreset {
  id: string;
  label: string;
  gains: number[];
}

/** dB 限幅（防配置脏值直接进 mpv/滤镜链）。 */
export const EQ_MIN_DB = -12;
export const EQ_MAX_DB = 12;
export const EQ_BAND_COUNT = 10;

const clamp = (v: number): number => Math.min(EQ_MAX_DB, Math.max(EQ_MIN_DB, Number.isFinite(v) ? v : 0));

export function sanitizeEqGains(raw: unknown): number[] {
  const arr = Array.isArray(raw) ? raw : [];
  const out: number[] = [];
  for (let i = 0; i < EQ_BAND_COUNT; i++) {
    out.push(clamp(Number(arr[i] ?? 0)));
  }
  return out;
}

export function isFlatEq(gains: number[]): boolean {
  return gains.every((g) => Math.abs(g) < 0.01);
}

/** 预设（dB）；flat 的「关闭」也做成预设方便 UI。 */
export const EQ_PRESETS: readonly EqPreset[] = [
  { id: 'flat', label: '平直', gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { id: 'bass', label: '重低音', gains: [7, 6, 4, 2, 0, 0, 0, 0, 1, 2] },
  { id: 'vocal', label: '人声', gains: [-3, -1, 2, 4, 4, 3, 1, 0, -1, -2] },
  { id: 'treble', label: '高亮', gains: [-2, -1, 0, 0, 0, 2, 4, 6, 7, 7] },
  { id: 'electronic', label: '电子', gains: [5, 4, 1, 0, -2, 0, 1, 3, 5, 6] },
  { id: 'classical', label: '古典', gains: [4, 3, 1, 0, 0, 0, 1, 2, 4, 3] },
  { id: 'rock', label: '摇滚', gains: [5, 4, 2, 0, -1, 0, 1, 3, 4, 5] },
];

/**
 * mpv 引擎参数映射（纯函数）：10 段 → af=lavfi 链。
 *
 * **滤镜写法已被 mpv 0.32 实机核实**（QYP3-068v 修 bug：此前写 `t=lowshelf`
 * / `t=peaking`，而 `equalizer` 的 `t` 是 **width_type**（合法值 h/q/o/s/k）
 * 不是 filter type —— 任何非空增益都会让整条链初始化失败，而 set_property
 * 静默吞错，mpv 引擎的 EQ 事实上从未生效过）：
 *   - peaking 段走 `equalizer=f=F:t=q:w=Q:g=G`
 *   - shelf 段走**独立滤镜** `bass` / `treble`（`lowshelf`/`highshelf` 是它们
 *     的别名，不是 `equalizer` 的取值）
 * `t=q` 让 `w` 就是 **Q 因子**，与 renderer 侧 BiquadFilter 的 Q 语义直接对齐，
 * 无需换算。改动前请用本机 mpv（即目标版本）跑一遍：
 *   `mpv --af="lavfi=[<chain>]" --ao=null --vo=null --frames=2 <wav>`
 */
/**
 * 固定 10 段图形 EQ 的段宽（Q 因子）。`t=q:w=` 与 renderer 侧 BiquadFilter
 * 的 Q 同义，所以这里选的值两边一致。
 */
export const EQ_DEFAULT_Q = 0.7;

export function mpvAudioFilterFromEq(gains: number[]): string | undefined {
  if (isFlatEq(gains)) return undefined; // 平直 = 不挂滤镜（省 CPU）
  const freqs = [60, 170, 350, 1000, 3500, 6000, 9000, 12000, 14000, 16000];
  const parts: string[] = [];
  for (let i = 0; i < EQ_BAND_COUNT; i++) {
    const db = gains[i];
    if (Math.abs(db) < 0.01) continue;
    // shelf 段必须是 bass / treble —— `equalizer` 只做 peaking，把
    // lowshelf/highshelf 塞给它的 `t` 会解析失败、整条 af 链报废。
    const filter = freqs[i] <= 350 ? 'bass' : freqs[i] >= 9000 ? 'treble' : 'equalizer';
    parts.push(`${filter}=f=${freqs[i]}:t=q:w=${EQ_DEFAULT_Q}:g=${db}`);
  }
  if (parts.length === 0) return undefined;
  return `lavfi=[${parts.join(',')}]`;
}

/** renderer 引擎消费的就是 10 段 dB 数组（sanitize 后）。 */
export function normalizeEqInput(raw: unknown): number[] {
  return sanitizeEqGains(raw);
}
