/**
 * 旧图形 EQ 契约（QYP3-012，计划 §6/§7）：固定 10 段 + 预设。
 *
 * **兼容层**：QYP3-068v 起音效链由 `audio-fx.ts` 承载（参量段），这里只留着
 * ①`playback.eqGains` 老配置 → 音效链的迁移源 ②内置的 7 套预设（升级成
 * 音效链预设，见 `utils/audio-fx-presets.ts`）③老配置下 mpv 的 10 段映射。
 * 频段表与 Q 值都从 audio-fx 取，别再抄一份（`EQ_DEFAULT_FREQS` 是唯一来源）。
 *
 * 注意 mpv 侧 lowshelf/highshelf/peaking 是**三个不同滤镜**，见
 * `mpvAudioFilterFromEq` 的注释。
 */

import { EQ_DEFAULT_FREQS, EQ_DEFAULT_Q } from './audio-fx';

export interface EqPreset {
  id: string;
  label: string;
  gains: number[];
}

/** dB 限幅（防配置脏值直接进 mpv/滤镜链）。 */
export const EQ_MIN_DB = -12;
export const EQ_MAX_DB = 12;
/** 段数由频段表决定（audio-fx 是唯一来源）。 */
export const EQ_BAND_COUNT = EQ_DEFAULT_FREQS.length;

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
export function mpvAudioFilterFromEq(gains: number[]): string | undefined {
  if (isFlatEq(gains)) return undefined; // 平直 = 不挂滤镜（省 CPU）
  const parts: string[] = [];
  for (let i = 0; i < EQ_BAND_COUNT; i++) {
    const db = gains[i];
    if (Math.abs(db) < 0.01) continue;
    const freq = EQ_DEFAULT_FREQS[i];
    // shelf 段必须是 bass / treble —— `equalizer` 只做 peaking，把
    // lowshelf/highshelf 塞给它的 `t` 会解析失败、整条 af 链报废。
    const filter = freq <= 350 ? 'bass' : freq >= 9000 ? 'treble' : 'equalizer';
    parts.push(`${filter}=f=${freq}:t=q:w=${EQ_DEFAULT_Q}:g=${db}`);
  }
  if (parts.length === 0) return undefined;
  return `lavfi=[${parts.join(',')}]`;
}
