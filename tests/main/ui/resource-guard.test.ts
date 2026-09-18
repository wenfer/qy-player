import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * 资源压力采样（QYP3-036）：主进程按 loadavg 采样，只在压力档**变化时**推送，
 * 避免无谓 IPC 戳渲染层重渲染。
 */
const h = vi.hoisted(() => ({ load: 0, cores: 4 }));

vi.mock('node:os', () => ({
  cpus: () => new Array(h.cores).fill({}),
  loadavg: () => [h.load, 0, 0],
}));

import {
  getResourcePressure,
  startResourceGuard,
  stopResourceGuard,
} from '../../../src/main/modules/ui-shell/resource-guard';

afterEach(() => {
  stopResourceGuard();
  vi.useRealTimers();
  h.load = 0;
  h.cores = 4;
});

describe('resource guard (QYP3-036)', () => {
  it('broadcasts the initial level and only on change', () => {
    vi.useFakeTimers();
    h.load = 0;
    const seen: string[] = [];
    startResourceGuard((p) => seen.push(p), 1000);
    expect(seen).toEqual(['normal']);

    // 同级：不重复推送
    vi.advanceTimersByTime(1000);
    expect(seen).toEqual(['normal']);

    // 升到 busy（3/4 = 0.75）
    h.load = 3;
    vi.advanceTimersByTime(1000);
    expect(seen).toEqual(['normal', 'busy']);

    // 保持 busy：不再推送
    vi.advanceTimersByTime(1000);
    expect(seen).toEqual(['normal', 'busy']);

    // 升到 critical（5/4 > 1）
    h.load = 5;
    vi.advanceTimersByTime(1000);
    expect(seen).toEqual(['normal', 'busy', 'critical']);
    expect(getResourcePressure()).toBe('critical');

    // 回落
    h.load = 0;
    vi.advanceTimersByTime(1000);
    expect(seen).toEqual(['normal', 'busy', 'critical', 'normal']);
    expect(getResourcePressure()).toBe('normal');
  });

  it('does not start a second timer', () => {
    vi.useFakeTimers();
    const seen: string[] = [];
    startResourceGuard((p) => seen.push(p), 1000);
    startResourceGuard((p) => seen.push(p), 1000);
    // 第二次调用直接返回（timer 已存在）——初值只推送一次
    expect(seen).toEqual(['normal']);
  });
});
