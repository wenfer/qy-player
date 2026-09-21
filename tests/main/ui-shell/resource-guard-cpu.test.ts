import { describe, expect, it } from 'vitest';
import { cpuBusyRatio } from '../../../src/main/modules/ui-shell/resource-guard';

/**
 * Windows 资源采样（QYP3-062）：os.loadavg() 在 win32 恒为 0，改用
 * os.cpus() times 差分估算忙核心数。纯函数单独钉住。
 */

const times = (idle: number, user: number, sys: number): { idle: number; total: number } => ({
  idle,
  total: idle + user + sys,
});

describe('cpuBusyRatio (QYP3-062)', () => {
  it('counts fully busy and idle cores on the window delta', () => {
    const prev = [times(100, 0, 0), times(90, 10, 0)];
    const curr = [times(150, 0, 0), times(90, 60, 0)];
    // 核心0：全闲 → 0；核心1：user 从 10→60，idle 0 → 全忙 → 1
    expect(cpuBusyRatio(prev, curr)).toBeCloseTo(1, 5);
  });

  it('scales with the busy fraction of a partially loaded core', () => {
    const prev = [times(0, 0, 0)];
    const curr = [times(40, 60, 0)];
    expect(cpuBusyRatio(prev, curr)).toBeCloseTo(0.6, 5);
  });

  it('returns 0 without a baseline snapshot or mismatched core counts', () => {
    const snap = [times(0, 10, 0)];
    expect(cpuBusyRatio([], snap)).toBe(0);
    expect(cpuBusyRatio(snap, [])).toBe(0);
    expect(cpuBusyRatio(snap, [snap[0], snap[0]])).toBe(0);
  });

  it('clamps negative idle deltas (counter reset) to zero busy time', () => {
    const prev = [times(200, 0, 0)];
    const curr = [times(100, 10, 0)]; // idle 倒退：dIdle < 0
    // dTotal = -90 ≤ 0 → 该核心不计忙（跳过），整体仍为 0
    expect(cpuBusyRatio(prev, curr)).toBe(0);
  });
});
