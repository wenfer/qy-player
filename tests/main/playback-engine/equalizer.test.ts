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

  it('maps bands to a lavfi chain mpv actually accepts (QYP3-068v)', () => {
    // shelf 段走独立滤镜 bass/treble、peaking 段走 equalizer，全部用 t=q:w=
    // —— 历史上写成 t=lowshelf/t=peaking（`t` 其实是 width_type），任何非空
    // 增益都会让整条 af 链初始化失败，而 mpv 静默吞错 → EQ 从未生效过。
    const af = mpvAudioFilterFromEq([6, 0, -2, 0, 0, 0, 0, 0, 4, 3]);
    expect(af).toBe(
      'lavfi=[bass=f=60:t=q:w=0.7:g=6,bass=f=350:t=q:w=0.7:g=-2,treble=f=14000:t=q:w=0.7:g=4,treble=f=16000:t=q:w=0.7:g=3]'
    );
    // 中间段（600..9000Hz 以下）是真正的 peaking
    expect(mpvAudioFilterFromEq([0, 0, 0, 5, 0, 0, 0, 0, 0, 0])).toBe(
      'lavfi=[equalizer=f=1000:t=q:w=0.7:g=5]'
    );
  });

  it('never emits a nonexistent filter type (the <t> trap)', () => {
    // 元断言：`t=` 之后只能是 FFmpeg 的 width_type（h/q/o/s/k）。写类名进去
    // （t=lowshelf / t=peaking / t=highshelf）mpv 会整链解析失败却不报错。
    for (const preset of EQ_PRESETS) {
      const af = mpvAudioFilterFromEq(preset.gains);
      if (!af) continue;
      for (const part of af.slice('lavfi=['.length, -1).split(',')) {
        const t = /:t=([^:]+)/.exec(part);
        expect(t, `未写成 width_type：${part}`).not.toBeNull();
        expect(['h', 'q', 'o', 's', 'k']).toContain(t![1]);
        // shelf 类名只能作为滤镜名出现
        expect(part).not.toMatch(/^equalizer=.*(lowshelf|highshelf)/);
      }
    }
  });

  it('isFlatEq and sanitize round-trip', () => {
    const gains = sanitizeEqGains([3, -3, 0, 0, 0, 0, 0, 0, 0, 1]);
    expect(isFlatEq(gains)).toBe(false);
    expect(isFlatEq(sanitizeEqGains([]))).toBe(true);
  });
});
