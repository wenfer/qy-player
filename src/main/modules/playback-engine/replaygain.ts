/**
 * ReplayGain 高级契约（P2，计划 §7）：模式之外还有三个 mpv 属性——
 * `replaygain-preamp`（整体增益）、`replaygain-fallback`（无 RG 标签文件
 * 的兜底增益）、`replaygain-clip`（削波保护）。
 *
 * 已按目标 mpv 二进制核实存在这三个选项（`strings` 提取：
 * replaygain-preamp / replaygain-fallback / replaygain-clip），
 * 因此不依赖版本探测。
 *
 * 单一来源：设置值在这里限幅归一，主进程按结果 set_property；脏配置
 * （手改数据库、旧版本残留）不得直接进 mpv。
 */

export type ReplayGainMode = 'off' | 'track' | 'album';

export interface ReplayGainChain {
  mode: ReplayGainMode;
  /** 整体预增益 dB。 */
  preamp: number;
  /** 无 ReplayGain 标签文件的兜底增益 dB。 */
  fallback: number;
  /** 削波保护。 */
  clip: boolean;
}

export const REPLAYGAIN_MIN_DB = -15;
export const REPLAYGAIN_MAX_DB = 15;
export const REPLAYGAIN_DEFAULT: ReplayGainChain = {
  mode: 'off',
  preamp: 0,
  fallback: 0,
  clip: false,
};

const clampDb = (v: unknown): number => {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(REPLAYGAIN_MAX_DB, Math.max(REPLAYGAIN_MIN_DB, n));
};

export function normalizeReplayGainMode(raw: unknown): ReplayGainMode {
  return raw === 'track' || raw === 'album' ? raw : 'off';
}

/**
 * 渲染进程传来的音频链片段 → 归一后的 ReplayGain 参数。
 * mode 为 off 时返回 null（= 不设置任何 RG 属性，等价关闭）。
 *
 * ⚠️ 三个高级项**两种键名都要收**：渲染层的 LOAD_FILE payload 是扁平对象
 * `{ fx, replaygain, replaygainPreamp, replaygainFallback, replaygainClip }`
 * （键名跟配置键 `playback.replaygainPreamp` 一致），而本模块起初按
 * `{ preamp, fallback, clip }` 读——结果只有 mode 生效，预增益/兜底增益/
 * 削波保护全被静默吃掉（`undefined` → clampDb 兜成 0 / `=== true` 为假）。
 * 单测当时直接喂 `preamp`，正好绕过了真实 payload，所以一直绿。
 * 归一化是本模块的唯一职责，键名差异就在这里吸收，不要推给调用方。
 */
export function normalizeReplayGain(raw: unknown): ReplayGainChain | null {
  const input = (raw ?? {}) as Record<string, unknown>;
  const mode = normalizeReplayGainMode(input.mode ?? input.replaygain);
  if (mode === 'off') return null;
  const pick = (short: string, prefixed: string): unknown =>
    input[short] !== undefined ? input[short] : input[prefixed];
  return {
    mode,
    preamp: clampDb(pick('preamp', 'replaygainPreamp')),
    fallback: clampDb(pick('fallback', 'replaygainFallback')),
    clip: pick('clip', 'replaygainClip') === true || pick('clip', 'replaygainClip') === 'true',
  };
}
