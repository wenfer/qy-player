import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAfHotUpdate } from '../../../src/main/modules/playback-engine/af-hot-update';

/**
 * af 热更新的防抖状态机（QYP3-068v）。
 *
 * 这段逻辑原先埋在 `ipc/index.ts` 的 IPC handler 闭包里，两条错误分支都
 * 抓不到（真机 CDP 才看得出"界面显示 B、mpv 却是 A"），所以抽成独立单元
 * 在这里钉住。
 */

const DEBOUNCE = 120;
/** 与真实链等长的两串，肉眼可区分。 */
const A = 'lavfi=[bass=f=60:t=q:w=0.7:g=6]';
const B = 'lavfi=[equalizer=f=1000:t=q:w=0.7:g=4]';

let applied: string[];
let hot: ReturnType<typeof createAfHotUpdate>;

beforeEach(() => {
  vi.useFakeTimers();
  applied = [];
  hot = createAfHotUpdate(DEBOUNCE, (chain) => applied.push(chain));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createAfHotUpdate (QYP3-068v)', () => {
  it('applyNow goes through immediately (loadfile cannot wait for the debounce)', () => {
    hot.applyNow(A);
    expect(applied).toEqual([A]);
    // 不是排队：不需要推进时间
    vi.advanceTimersByTime(DEBOUNCE);
    expect(applied).toEqual([A]);
  });

  it('collapses a burst of changes into one apply after the quiet period', () => {
    hot.applyNow(A);
    hot.request(B);
    hot.request(A + ' ');
    hot.request(B);
    // 静默期内一条都没发
    expect(applied).toEqual([A]);
    vi.advanceTimersByTime(DEBOUNCE);
    expect(applied).toEqual([A, B]);
  });

  it('skips the round trip entirely when the chain is unchanged', () => {
    hot.applyNow(A);
    expect(hot.request(A)).toBe('unchanged');
    vi.advanceTimersByTime(DEBOUNCE);
    expect(applied).toEqual([A]);
  });

  /**
   * 回归：拖到 B 又拖回 A（A 是当前已生效的链）时，**必须撤销**排队中的 B。
   * 否则 120ms 后 B 落地 → 界面显示 A、mpv 是 B。
   */
  it('cancels the pending request when the user drags back to the live chain', () => {
    hot.applyNow(A);
    expect(hot.request(B)).toBe('debounced');
    expect(hot.request(A)).toBe('unchanged');
    vi.advanceTimersByTime(DEBOUNCE * 3);
    expect(applied).toEqual([A]); // 过期的那条 B 绝不能落地
  });

  it('compares against the applied chain, not the last requested one', () => {
    hot.applyNow(A);
    hot.request(B);
    // 还没落地，所以"再来一条 B"仍是变化，而不是被误判成没变
    expect(hot.request(B)).toBe('debounced');
    vi.advanceTimersByTime(DEBOUNCE);
    expect(applied).toEqual([A, B]);
    // 落地之后 B 才是"当前的"
    expect(hot.request(B)).toBe('unchanged');
  });

  it('reset drops the pending request and forgets what is live', () => {
    hot.applyNow(A);
    hot.request(B);
    hot.reset();
    vi.advanceTimersByTime(DEBOUNCE * 3);
    expect(applied).toEqual([A]); // 排队的 B 不能落地
    // 已生效的记录被清空 → 再请求同一条链必须重新下发（切视频后 mpv 那边已经空了）
    expect(hot.request(A)).toBe('debounced');
    vi.advanceTimersByTime(DEBOUNCE);
    expect(applied).toEqual([A, A]);
  });

  it('applyNow supersedes anything pending (new track while dragging)', () => {
    hot.applyNow(A);
    hot.request(B);
    hot.applyNow(A + 'x');
    vi.advanceTimersByTime(DEBOUNCE * 3);
    expect(applied).toEqual([A, A + 'x']); // 排队的 B 被顶掉
  });

  it('treats the empty chain as a normal value (真旁路也是一条链)', () => {
    hot.applyNow(A);
    expect(hot.request('')).toBe('debounced');
    vi.advanceTimersByTime(DEBOUNCE);
    expect(applied).toEqual([A, '']);
    expect(hot.request('')).toBe('unchanged');
  });
});
