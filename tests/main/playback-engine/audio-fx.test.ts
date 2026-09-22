import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AUDIO_FX_DEFAULT,
  AUDIO_FX_MAX_BANDS,
  audioFxFromLegacyEq,
  isIdentityAudioFx,
  limiterLimitDbToLinear,
  mpvAudioChainFromFx,
  sanitizeAudioFx,
  widthBalanceMatrix,
  type AudioFxSettings,
} from '../../../src/main/modules/playback-engine/audio-fx';

/**
 * 高级音效链契约（QYP3-068v）。
 *
 * 这里刻意**不照着实现逐字符复述**——上一版 mpv EQ 就是因为断言写成"实现
 * 产出什么就断言什么"，从未验证 mpv 真的接受，才让 t=lowshelf 这种非法参数
 * 活到上线（表现为 mpv 音源上调均衡器毫无反应）。除了具体串，另有一条
 * **元断言**钉住：生成的每个滤镜名都必须落在已实机核实的清单里。
 */

/** 已用目标版本 mpv（0.32.0）实跑通过的滤镜名。改这个清单 = 显式的新滤镜决策。 */
const VERIFIED_MPV_FILTERS = ['volume', 'equalizer', 'bass', 'treble', 'pan', 'crossfeed', 'alimiter'];

const base: AudioFxSettings = {
  ...AUDIO_FX_DEFAULT,
  eq: { enabled: true, bands: [], preamp: 0 },
  limiter: { enabled: false, ceiling: -1 },
};

describe('audio-fx sanitize (QYP3-068v)', () => {
  it('falls back to defaults for junk input', () => {
    expect(sanitizeAudioFx('junk')).toEqual(AUDIO_FX_DEFAULT);
    expect(sanitizeAudioFx(null)).toEqual(AUDIO_FX_DEFAULT);
  });

  it('clamps every field into its legal range', () => {
    const fx = sanitizeAudioFx({
      eq: {
        bands: [
          { freq: 1, gain: 99, q: 0, type: 'bogus' },
          { freq: 999999, gain: -99, q: 999 },
        ],
        preamp: 99,
      },
      limiter: { ceiling: -99 },
      width: 99,
      balance: -99,
      crossfeed: 99,
    });
    expect(fx.eq.bands[0]).toEqual({ freq: 20, gain: 12, q: 0.3, type: 'lowshelf' });
    expect(fx.eq.bands[1]).toEqual({ freq: 20000, gain: -12, q: 12, type: 'highshelf' });
    expect(fx.eq.preamp).toBe(12);
    expect(fx.limiter.ceiling).toBe(-6);
    expect(fx.width).toBe(2);
    expect(fx.balance).toBe(-1);
    expect(fx.crossfeed).toBe(1);
  });

  it('caps the band count (nodes are permanent)', () => {
    const bands = new Array(AUDIO_FX_MAX_BANDS + 5).fill({ freq: 1000, gain: 1, q: 1 });
    expect(sanitizeAudioFx({ eq: { bands } }).eq.bands).toHaveLength(AUDIO_FX_MAX_BANDS);
  });

  it('derives the band type from frequency when omitted', () => {
    const fx = sanitizeAudioFx({
      eq: { bands: [{ freq: 100 }, { freq: 3000 }, { freq: 15000 }] },
    });
    expect(fx.eq.bands.map((b) => b.type)).toEqual(['lowshelf', 'peaking', 'highshelf']);
  });
});

describe('audio-fx identity (QYP3-068v)', () => {
  it('reports untouched settings as identity (no mpv filter chain)', () => {
    expect(isIdentityAudioFx(AUDIO_FX_DEFAULT)).toBe(true);
    expect(mpvAudioChainFromFx(AUDIO_FX_DEFAULT)).toBeUndefined();
  });

  it('disabled master switch is identity even with dialed-in values', () => {
    expect(isIdentityAudioFx({ ...base, enabled: false, crossfeed: 0.8 })).toBe(true);
  });

  it('non-flat gains break identity', () => {
    const fx = { ...base, eq: { ...base.eq, bands: [{ freq: 100, gain: 6, q: 1, type: 'peaking' as const }] } };
    expect(isIdentityAudioFx(fx)).toBe(false);
  });
});

describe('width / balance matrix (QYP3-068v)', () => {
  it('is null at the unity point (no pan filter needed)', () => {
    expect(widthBalanceMatrix(1, 0)).toBeNull();
  });

  it('width 0 collapses to mono and width 2 widens (a+b=1 keeps gain)', () => {
    const mono = widthBalanceMatrix(0, 0)!;
    // L' = R' = 0.5L + 0.5R —— 两条声道都变成同样的中置信号
    expect(mono.a0).toBeCloseTo(0.5, 6);
    expect(mono.b0).toBeCloseTo(0.5, 6);
    expect(mono.b1).toBeCloseTo(0.5, 6);
    expect(mono.a1).toBeCloseTo(0.5, 6);

    const wide = widthBalanceMatrix(2, 0)!;
    expect(wide.a0).toBeCloseTo(1.5, 6);
    expect(wide.b0).toBeCloseTo(-0.5, 6);
  });

  it('balance mutes one side without touching the other', () => {
    const right = widthBalanceMatrix(1, 1)!;
    expect(right.a0).toBe(0); // 左声道全压掉
    expect(right.a1).toBe(1); // 右声道保持

    const left = widthBalanceMatrix(1, -1)!;
    expect(left.a0).toBe(1);
    expect(left.a1).toBe(0);
  });
});

describe('limiter mapping (QYP3-068v)', () => {
  it('converts ceiling dB to the linear limit alimiter expects', () => {
    expect(limiterLimitDbToLinear(0)).toBeCloseTo(1, 6);
    expect(limiterLimitDbToLinear(-1)).toBeCloseTo(0.8913, 4);
    expect(limiterLimitDbToLinear(-6)).toBeCloseTo(0.5012, 4);
    // mpv 拒绝 >1 的 limit，源正是 Mike 的?
    expect(limiterLimitDbToLinear(99)).toBeLessThanOrEqual(1);
  });
});

describe('mpv audio chain (QYP3-068v)', () => {
  it('emits preamp → EQ → pan → crossfeed → limiter in graph order', () => {
    const fx: AudioFxSettings = {
      ...base,
      eq: {
        enabled: true,
        preamp: 3,
        bands: [
          { freq: 60, gain: 6, q: 0.7, type: 'lowshelf' },
          { freq: 1000, gain: -3, q: 1.4, type: 'peaking' },
          { freq: 14000, gain: 2, q: 0.7, type: 'highshelf' },
        ],
      },
      limiter: { enabled: true, ceiling: -1 },
      width: 1.5,
      crossfeed: 0.4,
    };
    expect(mpvAudioChainFromFx(fx)).toBe(
      'lavfi=[' +
        [
          'volume=3dB',
          'bass=f=60:t=q:w=0.7:g=6',
          'equalizer=f=1000:t=q:w=1.4:g=-3',
          'treble=f=14000:t=q:w=0.7:g=2',
          'pan=stereo|c0=1.25*c0-0.25*c1|c1=-0.25*c0+1.25*c1',
          'crossfeed=strength=0.4',
          'alimiter=limit=0.8913',
        ].join(',') +
        ']'
    );
  });

  it('never emits `+-` in pan expressions (mpv would reject it)', () => {
    const wide = mpvAudioChainFromFx({ ...base, width: 2 })!;
    expect(wide).toContain('pan=stereo|');
    expect(wide).not.toContain('+-');
  });

  it('only uses filters that were verified to work on the target mpv', () => {
    const candidates: AudioFxSettings[] = [
      base,
      { ...base, eq: { ...base.eq, preamp: 6 } },
      { ...base, eq: { ...base.eq, bands: [{ freq: 60, gain: 9, q: 0.7, type: 'lowshelf' }] } },
      { ...base, eq: { ...base.eq, bands: [{ freq: 16000, gain: 9, q: 2, type: 'highshelf' }] } },
      { ...base, width: 0 },
      { ...base, width: 2 },
      { ...base, balance: -1 },
      { ...base, balance: 0.5 },
      { ...base, crossfeed: 1 },
      { ...base, limiter: { enabled: true, ceiling: -6 } },
    ];
    let checked = 0;
    for (const fx of candidates) {
      const af = mpvAudioChainFromFx(fx);
      if (!af) continue;
      checked += 1;
      for (const part of af.slice('lavfi=['.length, -1).split(',')) {
        const name = part.slice(0, part.indexOf('='));
        expect(VERIFIED_MPV_FILTERS, `未实机核实的滤镜：${part}`).toContain(name);
        // `t=` 只能是 FFmpeg 的 width_type；写滤波器具类名进去会整链失败
        for (const m of part.matchAll(/:t=([^:]+)/g)) {
          expect(['h', 'q', 'o', 's', 'k']).toContain(m[1]);
        }
      }
    }
    expect(checked).toBeGreaterThan(5);
  });
});

// ---------------------------------------------------------------------------
// 实机验证：滤镜串真的能被目标 mpv 接受。
//
// 上面那些断言只能证明"实现产出了我们以为的串"。 mpv 参数非法时只是让整条 af
// 链初始化失败且**不报错**（player-core 里是静默 catch），所以必须真的跑一遍。
// `av://lavfi:sine` 让滤镜在没有外部音频文件的情况下也会真正初始化。
// 没有目标版本 mpv 的环境（Windows / CI）自动跳过。
// ---------------------------------------------------------------------------

function findMpv(): string | null {
  return (
    [process.env.QY_MPV_PATH, path.join(homedir(), '.local/bin/mpv')]
      .filter((p): p is string => Boolean(p))
      .find((p) => existsSync(p)) ?? null
  );
}

const MPV = findMpv();

function runMpv(af: string): boolean {
  if (!MPV) return false;
  const env = process.env.LD_LIBRARY_PATH
    ? process.env
    : {
        ...process.env,
        LD_LIBRARY_PATH: [path.join(homedir(), '.local/lib'), path.join(homedir(), '.local/lib/x86_64-linux-gnu')]
          .filter(existsSync)
          .join(':'),
      };
  const res = spawnSync(
    MPV,
    ['--af=' + af, '--ao=null', '--vo=null', '--no-config', '--frames=2', 'av://lavfi:sine=frequency=440'],
    { env, stdio: 'pipe', timeout: 30000 }
  );
  if (res.error) return false;
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`.toLowerCase();
  return res.status === 0 && !/error|invalid|unable|no such filter/.test(out);
}

// 先跑一次阴性对照，确认这套验证在本机真的可用（否则整组跳过，不产生假失败）
const MPV_USABLE = MPV !== null && runMpv('lavfi=[equalizer=f=1000:t=q:w=0.7:g=4]');

describe.skipIf(!MPV_USABLE)('mpv 实机接受性验证 (QYP3-068v)', () => {
  it('这套验证本身有效：非法参数必须被判为失败（阳性对照）', () => {
    // 历史上就是它让 mpv 音源的均衡器从未生效
    expect(runMpv('lavfi=[equalizer=f=60:t=lowshelf:g=7]')).toBe(false);
  });

  const scenarios: Array<[string, AudioFxSettings]> = [
    ['前置增益', { ...base, eq: { ...base.eq, preamp: 6 } }],
    ['低架段', { ...base, eq: { ...base.eq, bands: [{ freq: 60, gain: 9, q: 0.7, type: 'lowshelf' }] } }],
    ['peaking 段', { ...base, eq: { ...base.eq, bands: [{ freq: 1000, gain: -6, q: 4, type: 'peaking' }] } }],
    ['高架构段', { ...base, eq: { ...base.eq, bands: [{ freq: 16000, gain: 9, q: 2, type: 'highshelf' }] } }],
    ['窄声场', { ...base, width: 0 }],
    ['宽声场', { ...base, width: 2 }],
    ['声道左偏', { ...base, balance: -1 }],
    ['声道右偏', { ...base, balance: 0.5 }],
    ['交叉馈送', { ...base, crossfeed: 1 }],
    ['削波保护', { ...base, limiter: { enabled: true, ceiling: -6 } }],
  ];

  it.each(scenarios)('%s', (_label, fx) => {
    const af = mpvAudioChainFromFx(fx);
    expect(af).toBeTruthy();
    expect(runMpv(af!), `mpv 拒绝了这条链：${af}`).toBe(true);
  });

  it('全部效果叠加时整条链仍然可加载', () => {
    const af = mpvAudioChainFromFx({
      enabled: true,
      eq: {
        enabled: true,
        preamp: 3,
        bands: [
          { freq: 60, gain: 6, q: 0.7, type: 'lowshelf' },
          { freq: 1000, gain: -3, q: 1.4, type: 'peaking' },
          { freq: 14000, gain: 2, q: 0.7, type: 'highshelf' },
        ],
      },
      limiter: { enabled: true, ceiling: -1 },
      width: 1.5,
      balance: 0.2,
      crossfeed: 0.4,
    })!;
    expect(runMpv(af)).toBe(true);
  });
});

describe('legacy migration (QYP3-068v)', () => {  it('imports old playback.eqGains into the parametric bands', () => {
    const fx = audioFxFromLegacyEq([6, 0, -2, 0, 0, 0, 0, 0, 4, 3]);
    expect(fx.eq.bands).toHaveLength(10);
    expect(fx.eq.bands[0].gain).toBe(6);
    expect(fx.eq.bands[2].gain).toBe(-2);
    expect(fx.eq.bands[0].type).toBe('lowshelf');
    expect(fx.eq.bands[3].type).toBe('peaking');
    expect(fx.eq.bands[9].type).toBe('highshelf');
    expect(fx.eq.bands.every((b) => b.q > 0)).toBe(true);
  });

  it('flat legacy gains stay identity', () => {
    expect(isIdentityAudioFx(audioFxFromLegacyEq(new Array(10).fill(0)))).toBe(true);
  });
});
