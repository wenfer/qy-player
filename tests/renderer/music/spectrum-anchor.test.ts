import { describe, expect, it } from 'vitest';
import {
  estimatePosition,
  makeAnchor,
} from '../../../src/renderer/player/spectrum-anchor';

/**
 * 播放位置锚点（QYP3-050）：mpv 的位置是 ~1Hz 的离散推送，离线频谱却是 12fps，
 * 所以要能在两次推送之间把位置外推出来（暂停/未播放时冻结）。
 */

describe('spectrum position anchor (QYP3-050)', () => {
  it('extrapolates while playing', () => {
    const a = makeAnchor(10, true, 1000);
    expect(estimatePosition(a, true, 1250)).toBeCloseTo(10.25, 6);
    expect(estimatePosition(a, true, 2000)).toBeCloseTo(11, 6);
  });

  it('freezes when paused or not yet playing', () => {
    const a = makeAnchor(10, true, 1000);
    expect(estimatePosition(a, false, 5000)).toBe(10); // 暂停
    const idle = makeAnchor(7, false, 1000);
    expect(estimatePosition(idle, true, 5000)).toBe(7); // 锚点本身标着"没在放"
  });

  it('never goes backwards past zero and tolerates clock skew', () => {
    const a = makeAnchor(0, true, 1000);
    expect(estimatePosition(a, true, 990)).toBe(0); // 时钟回拨
    expect(estimatePosition(a, true, Number.NaN)).toBe(0);
  });

  it('re-anchors on the next position event (seek / pause are authoritative)', () => {
    let a = makeAnchor(10, true, 1000);
    expect(estimatePosition(a, true, 2000)).toBeCloseTo(11, 6);
    a = makeAnchor(200, true, 2000); // seek 到 200s
    expect(estimatePosition(a, true, 2100)).toBeCloseTo(200.1, 6);
    a = makeAnchor(200, false, 2100); // 暂停
    expect(estimatePosition(a, false, 9000)).toBe(200);
  });
});
