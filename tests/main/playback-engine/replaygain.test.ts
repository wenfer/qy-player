import { describe, expect, it } from 'vitest';
import {
  normalizeReplayGain,
  normalizeReplayGainMode,
  REPLAYGAIN_DEFAULT,
} from '../../../src/main/modules/playback-engine/replaygain';

/**
 * ReplayGain 高级项归一（P2）：模式 + 预增益 + 兜底增益 + 削波保护。
 * 脏配置（手改库、旧版本残留）不得直接进 mpv。
 * 三个属性已按目标 mpv 二进制核实存在（replaygain-preamp/-fallback/-clip）。
 */

describe('replaygain contract (P2)', () => {
  it('defaults to off', () => {
    expect(REPLAYGAIN_DEFAULT).toEqual({ mode: 'off', preamp: 0, fallback: 0, clip: false });
    expect(normalizeReplayGainMode(undefined)).toBe('off');
    expect(normalizeReplayGainMode('nonsense')).toBe('off');
    expect(normalizeReplayGainMode('track')).toBe('track');
    expect(normalizeReplayGainMode('album')).toBe('album');
  });

  it('returns null when the mode is off (no properties are set)', () => {
    expect(normalizeReplayGain(null)).toBeNull();
    expect(normalizeReplayGain({})).toBeNull();
    expect(normalizeReplayGain({ replaygain: 'off', preamp: 5 })).toBeNull();
  });

  it('accepts the mode from either key shape', () => {
    expect(normalizeReplayGain({ replaygain: 'track' })?.mode).toBe('track');
    expect(normalizeReplayGain({ mode: 'album' })?.mode).toBe('album');
    // mode 优先于 replaygain
    expect(normalizeReplayGain({ mode: 'album', replaygain: 'track' })?.mode).toBe('album');
  });

  it('clamps dB values and degrades non-finite input to 0', () => {
    const chain = normalizeReplayGain({
      mode: 'track',
      preamp: 100,
      fallback: -100,
    });
    expect(chain).toEqual({ mode: 'track', preamp: 15, fallback: -15, clip: false });

    const dirty = normalizeReplayGain({
      mode: 'track',
      preamp: Number.NaN,
      fallback: '不是数字',
      clip: 'yes',
    });
    // 脏值 → 0；clip 只认严格 true（字符串 'yes' 不算）
    expect(dirty).toEqual({ mode: 'track', preamp: 0, fallback: 0, clip: false });
  });

  it('keeps an in-range preamp untouched and honours clip=true', () => {
    expect(normalizeReplayGain({ mode: 'album', preamp: -6.5, fallback: 2, clip: true })).toEqual({
      mode: 'album',
      preamp: -6.5,
      fallback: 2,
      clip: true,
    });
  });
});
