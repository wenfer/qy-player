/**
 * 睡眠定时（P2，计划 §7）：到点暂停播放，音乐与视频通用。
 *
 * 只存在于主进程本次会话内，不写配置——"重启后旧定时还在跑"才是意外。
 * 时钟与定时器可注入，便于测试（无需真实等待）。
 */

export interface SleepTimerState {
  active: boolean;
  /** 已设置的分钟数；未启用为 null（UI 用来高亮当前档位）。 */
  minutes: number | null;
  /** 触发时刻（epoch ms）；未启用为 null。 */
  expiresAt: number | null;
  /** 剩余毫秒；未启用为 null。 */
  remainingMs: number | null;
}

/** 上限 24 小时，防止脏值把定时器设成天文数字。 */
export const SLEEP_MAX_MINUTES = 1440;

export interface SleepTimerDeps {
  now: () => number;
  setTimer: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer: (handle: ReturnType<typeof setTimeout>) => void;
  /** 到点回调（暂停播放 + 通知 renderer）。 */
  onExpire: () => void;
}

export class SleepTimer {
  private readonly deps: SleepTimerDeps;
  private handle: ReturnType<typeof setTimeout> | null = null;
  private expiresAt: number | null = null;
  private minutes: number | null = null;

  constructor(deps: SleepTimerDeps) {
    this.deps = deps;
  }

  /**
   * 设置定时（分钟）。0 或非法值 = 关闭。
   * 返回归一后的分钟数（0 = 已关闭）。
   */
  set(minutes: unknown): number {
    const min = Number(minutes);
    if (!Number.isFinite(min) || min <= 0) {
      this.cancel();
      return 0;
    }
    const clamped = Math.min(SLEEP_MAX_MINUTES, Math.floor(min));
    this.clear();
    const ms = clamped * 60_000;
    this.expiresAt = this.deps.now() + ms;
    this.minutes = clamped;
    this.handle = this.deps.setTimer(() => this.expire(), ms);
    return clamped;
  }

  cancel(): void {
    this.clear();
    this.expiresAt = null;
    this.minutes = null;
  }

  state(): SleepTimerState {
    if (this.expiresAt === null) {
      return { active: false, minutes: null, expiresAt: null, remainingMs: null };
    }
    return {
      active: true,
      minutes: this.minutes,
      expiresAt: this.expiresAt,
      remainingMs: Math.max(0, this.expiresAt - this.deps.now()),
    };
  }

  /** 一次性定时：先清状态再回调（避免回调里再读到"仍在计时"）。 */
  private expire(): void {
    this.handle = null;
    this.expiresAt = null;
    this.minutes = null;
    this.deps.onExpire();
  }

  private clear(): void {
    if (this.handle !== null) {
      this.deps.clearTimer(this.handle);
      this.handle = null;
    }
  }
}
