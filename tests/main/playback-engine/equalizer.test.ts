import { describe, expect, it } from 'vitest';
import {
  EQ_PRESETS,
  sanitizeEqGains,
  isFlatEq,
  mpvAudioFilterFromEq,
} from '../../../src/main/modules/playback-engine/equalizer';

describe('equalizer contract (QYP3-012)', () => {
  it('sanitizes dirty input into 10 clamped bands', () => {
    expect(sanitizeEqGains([100, 'x', null, undefined, 1, 2, 3, 4, 5, 6, 7, 8])).toEqual([
      12, 0, 0, 0, 1, 2, 3, 4, 5, 6,
    ]);
    expect(sanitizeEqGains([-99])).toEqual([-12, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(sanitizeEqGains('junk')).toEqual(new Array(10).fill(0));
  });

  it('presets are 10-band and within range', () => {
    for (const p of EQ_PRESETS) {
      expect(p.gains).toHaveLength(10);
      for (const g of p.gains) {
        expect(g).toBeGreaterThanOrEqual(-12);
        expect(g).toBeLessThanOrEqual(12);
      }
    }
  });

  it('flat gains produce no mpv filter (CPU saving)', () => {
    expect(mpvAudioFilterFromEq(new Array(10).fill(0))).toBeUndefined();
    expect(mpvAudioFilterFromEq([0.001, 0, 0, 0, 0, 0, 0, 0, 0, 0])).toBeUndefined();
  });

  it('maps bands to lavfi equalizer chain with shelf/peaking types', () => {
    const af = mpvAudioFilterFromEq([6, 0, -2, 0, 0, 0, 0, 0, 4, 3]);
    expect(af).toBe(
      'lavfi=[equalizer=f=60:t=lowshelf:g=6,equalizer=f=350:t=lowshelf:g=-2,equalizer=f=14000:t=highshelf:g=4,equalizer=f=16000:t=highshelf:g=3]'
    );
  });

  it('isFlatEq and sanitize round-trip', () => {
    const gains = sanitizeEqGains([3, -3, 0, 0, 0, 0, 0, 0, 0, 1]);
    expect(isFlatEq(gains)).toBe(false);
    expect(isFlatEq(sanitizeEqGains([]))).toBe(true);
  });
});
