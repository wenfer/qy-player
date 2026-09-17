import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SleepTimer, SLEEP_MAX_MINUTES } from '../../../src/main/modules/ui-shell/sleep-timer';

/**
 * 睡眠定时（P2）：到点暂停播放，音乐/视频通用。
 * 时钟与定时器注入，测试不真实等待。
 */

let now = 1_000_000;
let pending: Array<{ cb: () => void; at: number; id: number }> = [];
let nextId = 1;
const onExpire = vi.fn();

function makeTimer(): SleepTimer {
  return new SleepTimer({
    now: () => now,
    setTimer: (cb, ms) => {
      const entry = { cb, at: now + ms, id: nextId++ };
      pending.push(entry);
      return entry.id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (handle) => {
      pending = pending.filter((p) => p.id !== (handle as unknown as number));
    },
    onExpire,
  });
}

/** 推进时钟并触发所有到期回调。 */
function advance(ms: number): void {
  now += ms;
  const due = pending.filter((p) => p.at <= now);
  pending = pending.filter((p) => p.at > now);
  for (const d of due) d.cb();
}

beforeEach(() => {
  now = 1_000_000;
  pending = [];
  nextId = 1;
  onExpire.mockClear();
});

describe('sleep timer (P2)', () => {
  it('starts inactive', () => {
    expect(makeTimer().state()).toEqual({
      active: false,
      minutes: null,
      expiresAt: null,
      remainingMs: null,
    });
  });

  it('sets a timer and reports the remaining time', () => {
    const t = makeTimer();
    expect(t.set(30)).toBe(30);
    expect(t.state()).toEqual({
      active: true,
      minutes: 30,
      expiresAt: now + 30 * 60_000,
      remainingMs: 30 * 60_000,
    });

    advance(10 * 60_000);
    expect(t.state().remainingMs).toBe(20 * 60_000);
    expect(onExpire).not.toHaveBeenCalled();
  });

  it('fires once and clears itself at expiry', () => {
    const t = makeTimer();
    t.set(15);
    advance(15 * 60_000);
    expect(onExpire).toHaveBeenCalledTimes(1);
    // 一次性：到点后不再有状态残留，也不会再次触发
    expect(t.state()).toEqual({ active: false, minutes: null, expiresAt: null, remainingMs: null });
    advance(60 * 60_000);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it('replaces an existing timer instead of stacking them', () => {
    const t = makeTimer();
    t.set(10);
    t.set(60);
    expect(pending).toHaveLength(1);
    advance(10 * 60_000);
    expect(onExpire).not.toHaveBeenCalled();
    expect(t.state().minutes).toBe(60);
    advance(50 * 60_000);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it('treats 0 and invalid input as cancel', () => {
    const t = makeTimer();
    t.set(30);
    expect(t.set(0)).toBe(0);
    expect(pending).toHaveLength(0);
    expect(t.state().active).toBe(false);

    t.set(30);
    expect(t.set(Number.NaN)).toBe(0);
    expect(t.set(-5)).toBe(0);
    expect(t.set('abc' as unknown as number)).toBe(0);
    expect(pending).toHaveLength(0);
  });

  it('clamps to 24 hours and floors fractional minutes', () => {
    const t = makeTimer();
    expect(t.set(99999)).toBe(SLEEP_MAX_MINUTES);
    expect(t.state().expiresAt).toBe(now + SLEEP_MAX_MINUTES * 60_000);
    t.set(12.9);
    expect(t.state().minutes).toBe(12);
  });

  it('cancel() stops the pending timer', () => {
    const t = makeTimer();
    t.set(5);
    t.cancel();
    expect(pending).toHaveLength(0);
    advance(10 * 60_000);
    expect(onExpire).not.toHaveBeenCalled();
    expect(t.state().active).toBe(false);
  });
});
