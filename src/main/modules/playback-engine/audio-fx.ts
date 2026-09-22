/**
 * 高级音效链契约（QYP3-068v）：参量 EQ + 前置增益 + 削波保护 + 声场三项。
 *
 * 单一来源：renderer 引擎（Web Audio 节点）与 mpv 引擎（af=lavfi 链）各消费
 * 一份映射，这里**只产参数，不做 IO**，与 equalizer.ts / replaygain.ts 同构。
 *
 * ## mpv 侧写法已逐条用目标版本实测
 *
 * mpv 0.32.0 + FFmpeg，滤镜参数非法时 mpv 只是让整条 af 链初始化失败且不报错
 * （`player-core` 的 set_property 是静默 catch）——这些写法必须**实机验证过**，
 * 不能凭文档推断。改动任一条前先跑：
 *
 * ```
 * mpv --af="lavfi=[<chain>]" --ao=null --vo=null --frames=3 <wav>
 * ```
 *
 * 已核实可用（2026-09，本机 mpv 即目标版本）：
 *   peaking   `equalizer=f=F:t=q:w=Q:g=G`
 *   shelf     `bass=f=F:t=q:w=Q:g=G` / `treble=...`（独立滤镜，非 equalizer）
 *   输入增益  `volume=XdB`
 *   声场矩阵  `pan=stereo|c0=A*c0+B*c1|c1=C*c0+D*c1`
 *   交叉馈送  `crossfeed=strength=S`（S 合法范围 0..1）
 *   削波保护  `alimiter=limit=L`（L = 10^(ceiling/20)）
 * 立体声专属滤镜（pan / crossfeed）在**单声道源上也实测通过**。
 *
 * `t=q` 让 mpv 的 `w` 就是 **Q 因子**，与 renderer 侧 BiquadFilter 的 Q
 * 语义直接对齐，两边不需要换算。
 */

export type EqFilterType = 'peaking' | 'lowshelf' | 'highshelf';

export interface EqBand {
  /** 中心频率 Hz。 */
  freq: number;
  /** 增益 dB。 */
  gain: number;
  /** Q 因子（= mpv 的 t=q:w 取值）。 */
  q: number;
  type: EqFilterType;
}

export interface AudioFxSettings {
  /** 总开关（关 = 全直通，两个引擎都不挂任何处理）。 */
  enabled: boolean;
  eq: {
    enabled: boolean;
    bands: EqBand[];
    /** 输入增益 dB：先在这里衰减，再进 EQ，才保得住 EQ 的精度。 */
    preamp: number;
  };
  limiter: {
    enabled: boolean;
    /** 输出天花板 dB（-6..0）。 */
    ceiling: number;
  };
  /** 立体声宽度：0 = 单声道，1 = 原样，2 = 加宽。 */
  width: number;
  /** 声道平衡：-1 = 全左，0 = 居中，+1 = 全右。 */
  balance: number;
  /** 耳机交叉馈送强度 0..1（0 = 关闭）。 */
  crossfeed: number;
}

/** 段数上限（节点是常驻的，直通也走 buffer 拷贝，老机有 CPU 预算）。 */
export const AUDIO_FX_MAX_BANDS = 10;
export const EQ_FREQ_MIN = 20;
export const EQ_FREQ_MAX = 20000;
export const EQ_GAIN_LIMIT = 12;
export const EQ_Q_MIN = 0.3;
export const EQ_Q_MAX = 12;
export const PREAMP_LIMIT = 12;
export const LIMITER_CEILING_MIN = -6;
export const LIMITER_CEILING_MAX = 0;
export const WIDTH_MIN = 0;
export const WIDTH_MAX = 2;
export const BALANCE_LIMIT = 1;
export const CROSSFEED_MAX = 1;

/** 默认 Q：沿用旧图形 EQ 的段宽，两个引擎一致。 */
export const EQ_DEFAULT_Q = 0.7;

/**
 * 默认频段：与 renderer 的 EQ_BANDS / mpv 10 段图形 EQ 一致。
 * ≤350Hz 作低架、≥9000Hz 作高架构，中间 peaking —— 与
 * `mpvAudioFilterFromEq`（旧契约）保持同一套意图，迁移时对齐。
 */
export const EQ_DEFAULT_FREQS = [60, 170, 350, 1000, 3500, 6000, 9000, 12000, 14000, 16000];

function bandTypeFor(freq: number): EqFilterType {
  return freq <= 350 ? 'lowshelf' : freq >= 9000 ? 'highshelf' : 'peaking';
}

export function defaultEqBands(): EqBand[] {
  return EQ_DEFAULT_FREQS.map((freq) => ({ freq, gain: 0, q: EQ_DEFAULT_Q, type: bandTypeFor(freq) }));
}

/**
 * 默认全部直通： effects 默认关、增益为 0、宽度 1、平衡 0、交叉馈送 0。
 *
 * `limiter.enabled` 默认 **false**：与既有约定一致（equalizer.ts 的
 * `isFlatEq` → 不挂滤镜省 CPU）。这条一旦默认 true，所有用户（哪怕从未
 * 动过音效）都会常年挂着一条 alimiter —— 而 it's 保护的价值只在用户真的
 * 抬起 EQ 之后才成立。
 */
export const AUDIO_FX_DEFAULT: AudioFxSettings = {
  enabled: true,
  eq: { enabled: true, bands: defaultEqBands(), preamp: 0 },
  limiter: { enabled: false, ceiling: -1 },
  width: 1,
  balance: 0,
  crossfeed: 0,
};

const clampNum = (v: unknown, min: number, max: number, fallback = 0): number => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

function sanitizeBand(raw: unknown): EqBand {
  const input = (raw ?? {}) as Record<string, unknown>;
  const freq = clampNum(input.freq, EQ_FREQ_MIN, EQ_FREQ_MAX, 1000);
  return {
    freq: Math.round(freq),
    gain: Math.round(clampNum(input.gain, -EQ_GAIN_LIMIT, EQ_GAIN_LIMIT) * 10) / 10,
    q: Math.round(clampNum(input.q, EQ_Q_MIN, EQ_Q_MAX, EQ_DEFAULT_Q) * 100) / 100,
    type:
      input.type === 'lowshelf' || input.type === 'highshelf' || input.type === 'peaking'
        ? input.type
        : bandTypeFor(freq),
  };
}

/** 脏配置（手改数据库、旧版本残留）不得直接进 mpv / 音频图。 */
export function sanitizeAudioFx(raw: unknown): AudioFxSettings {
  const input = (raw ?? {}) as Record<string, unknown>;
  const eqInput = (input.eq ?? {}) as Record<string, unknown>;
  const limiterInput = (input.limiter ?? {}) as Record<string, unknown>;

  const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);
  return {
    enabled: bool(input.enabled, AUDIO_FX_DEFAULT.enabled),
    eq: {
      enabled: bool(eqInput.enabled, AUDIO_FX_DEFAULT.eq.enabled),
      // 缺失 → 默认 10 段；**显式空数组要保留**（用户可能把段全删了）
      bands: Array.isArray(eqInput.bands)
        ? eqInput.bands.slice(0, AUDIO_FX_MAX_BANDS).map(sanitizeBand)
        : AUDIO_FX_DEFAULT.eq.bands.map((b) => ({ ...b })),
      preamp: Math.round(clampNum(eqInput.preamp, -PREAMP_LIMIT, PREAMP_LIMIT) * 10) / 10,
    },
    limiter: {
      enabled: bool(limiterInput.enabled, AUDIO_FX_DEFAULT.limiter.enabled),
      ceiling:
        Math.round(
          clampNum(limiterInput.ceiling, LIMITER_CEILING_MIN, LIMITER_CEILING_MAX, AUDIO_FX_DEFAULT.limiter.ceiling) *
            10
        ) / 10,
    },
    width: Math.round(clampNum(input.width, WIDTH_MIN, WIDTH_MAX, 1) * 100) / 100,
    balance: Math.round(clampNum(input.balance, -BALANCE_LIMIT, BALANCE_LIMIT) * 100) / 100,
    crossfeed: Math.round(clampNum(input.crossfeed, 0, CROSSFEED_MAX) * 100) / 100,
  };
}

/** 从旧 `playback.eqGains`（10 段纯 dB）迁移；未知粗略演进。 */
export function audioFxFromLegacyEq(gains: number[]): AudioFxSettings {
  const bands = defaultEqBands().map((band, i) => ({
    ...band,
    gain: clampNum(gains?.[i], -EQ_GAIN_LIMIT, EQ_GAIN_LIMIT),
  }));
  return { ...AUDIO_FX_DEFAULT, eq: { ...AUDIO_FX_DEFAULT.eq, bands } };
}

/** 全直通？是就不让 mpv 挂任何滤镜（省 CPU）。 */
export function isIdentityAudioFx(fx: AudioFxSettings): boolean {
  if (!fx.enabled) return true;
  const eqOff = !fx.eq.enabled || (fx.eq.bands.every((b) => Math.abs(b.gain) < 0.01) && Math.abs(fx.eq.preamp) < 0.01);
  const widthBalanceOff = Math.abs(fx.width - 1) < 0.005 && Math.abs(fx.balance) < 0.005;
  return eqOff && widthBalanceOff && fx.crossfeed < 0.005 && !fx.limiter.enabled;
}

/**
 * 宽度 + 平衡的 4 系数矩阵，与 renderer 侧 Web Audio 的接法数学一致：
 *   L' = a0*L + b0*R
 *   R' = b1*L + a1*R
 *
 * width 部分：`a=(1+w)/2, b=(1-w)/2`（w=1 → a=1,b=0 严格直通；w=0 → 单声道）。
 * 比"mid/side 编解码再展开"少节点、也没有 0.5 系数累积误差。
 * balance 部分：p≥0 时压左声道（`L*=1-p`），p<0 时压右声道 —— 不是
 * StereoPanner 那种等功率声像（那会把两条声道都动）。
 */
export function widthBalanceMatrix(
  width: number,
  balance: number
): { a0: number; b0: number; b1: number; a1: number } | null {
  if (Math.abs(width - 1) < 0.005 && Math.abs(balance) < 0.005) return null;
  const a = (1 + width) / 2;
  const b = (1 - width) / 2;
  const leftScale = balance >= 0 ? 1 - balance : 1;
  const rightScale = balance < 0 ? 1 + balance : 1;
  return { a0: a * leftScale, b0: b * leftScale, b1: b * rightScale, a1: a * rightScale };
}

/** 天花板 dB → alimiter 的线性 limit（0..1）。 */
export function limiterLimitDbToLinear(ceilingDb: number): number {
  return Math.pow(10, clampNum(ceilingDb, LIMITER_CEILING_MIN, LIMITER_CEILING_MAX, -1) / 20);
}

/** mpv/FFmpeg 只认定点小数：既不输出科学计数法，也不留多余的尾随 0。 */
function num(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return '0';
  const s = value.toFixed(digits);
  return s.indexOf('.') >= 0 ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}

/**
 * 多项式项拼接：`1.25*c0-0.25*c1`。
 * 系数为负时必须输出减号而不是 `+-`（LL 的数是 EB 增速）。
 */
function poly(terms: Array<[number, string]>): string {
  let out = `${num(terms[0][0], 4)}*${terms[0][1]}`;
  for (let i = 1; i < terms.length; i += 1) {
    const [coef, ch] = terms[i];
    out += coef < 0 ? `${num(coef, 4)}*${ch}` : `+${num(coef, 4)}*${ch}`;
  }
  return out;
}

/**
 * 契约 → mpv af 链。返回 undefined 表示"全直通，不挂滤镜"。
 *
 * 顺序与 renderer 音频图一致（先增益后 EQ，矩阵声场再交叉馈送，最后限幅）：
 *   volume(preamp) → bass/equalizer/treble… → pan(宽度+平衡) → crossfeed → alimiter
 * 之后才是 mpv 自己的 `volume` 属性 = 用户的音量旋钮（在 af 之外）。
 *
 * 注意：**不要**把 preamp 塞进 mpv 的 `volume` 属性——那个已经被应用的
 * 音量控制占用（player-core 的 setVolume），两边会互相覆盖。
 */
export function mpvAudioChainFromFx(fx: AudioFxSettings): string | undefined {
  if (isIdentityAudioFx(fx)) return undefined;
  const parts: string[] = [];

  if (fx.eq.enabled) {
    if (Math.abs(fx.eq.preamp) >= 0.01) parts.push(`volume=${num(fx.eq.preamp, 1)}dB`);
    for (const band of fx.eq.bands) {
      if (Math.abs(band.gain) < 0.01) continue;
      const filter = band.type === 'lowshelf' ? 'bass' : band.type === 'highshelf' ? 'treble' : 'equalizer';
      parts.push(`${filter}=f=${num(band.freq, 0)}:t=q:w=${num(band.q)}:g=${num(band.gain, 1)}`);
    }
  }

  const matrix = widthBalanceMatrix(fx.width, fx.balance);
  if (matrix) {
    parts.push(
      `pan=stereo|c0=${poly([
        [matrix.a0, 'c0'],
        [matrix.b0, 'c1'],
      ])}|c1=${poly([
        [matrix.b1, 'c0'],
        [matrix.a1, 'c1'],
      ])}`
    );
  }

  if (fx.crossfeed >= 0.005) parts.push(`crossfeed=strength=${num(fx.crossfeed)}`);

  if (fx.limiter.enabled) parts.push(`alimiter=limit=${num(limiterLimitDbToLinear(fx.limiter.ceiling), 4)}`);

  if (parts.length === 0) return undefined;
  return `lavfi=[${parts.join(',')}]`;
}
