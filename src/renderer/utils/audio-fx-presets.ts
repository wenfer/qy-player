/**
 * 音效预设（QYP3-068v v2）。
 *
 * 结构与旧版（QYP3-012a）同键不同形：
 *   旧 `{id, label, gains: number[]}` —— 只能表达 10 段图形 EQ
 *   新 `{v: 2, id, label, fx: AudioFxSettings}` —— 整条音效链
 * 解析时两种都收，旧条目用 `audioFxFromLegacyEq` 升级（读不到新键就没法表达
 * 参量 EQ / 声场，直接丢掉反而让用户以为预设没了）。
 *
 * **键名保持 `playback.eqPresets`**：换键等于把用户已有的自定义预设丢掉，
 * 而配置是 KV 没有 migration 机制（AGENTS.md：只能追加 migration，不删键）。
 */

import {
  AUDIO_FX_DEFAULT,
  audioFxFromLegacyEq,
  sanitizeAudioFx,
  type AudioFxSettings,
} from '../../main/modules/playback-engine/audio-fx';
// 内置预设仍是既有那 7 套（契约住在 equalizer.ts）
import { EQ_PRESETS, type EqPreset } from '../../main/modules/playback-engine/equalizer';

export interface AudioFxPreset {
  id: string;
  label: string;
  fx: AudioFxSettings;
}

export const AUDIO_FX_PRESETS_KEY = 'playback.eqPresets';

/** 内置预设：由既有的 7 套图形 EQ 增益升级而来（同一个键下的老朋友）。 */
export const BUILTIN_FX_PRESETS: readonly AudioFxPreset[] = EQ_PRESETS.map((p: EqPreset) => ({
  id: p.id,
  label: p.label,
  fx: audioFxFromLegacyEq(p.gains),
}));

export function parseFxPresets(raw: unknown): AudioFxPreset[] {
  if (!Array.isArray(raw)) return [];
  const out: AudioFxPreset[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const { id, label } = item as { id?: unknown; label?: unknown };
    if (typeof id !== 'string' || typeof label !== 'string' || !id || !label) continue;
    const rawFx = (item as { fx?: unknown }).fx;
    const rawGains = (item as { gains?: unknown }).gains;
    const fx = rawFx
      ? sanitizeAudioFx(rawFx)
      : Array.isArray(rawGains)
        ? audioFxFromLegacyEq(rawGains.map((v) => Number(v) || 0))
        : AUDIO_FX_DEFAULT;
    out.push({ id, label, fx });
  }
  return out;
}
