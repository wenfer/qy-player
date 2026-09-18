import { describe, expect, it } from 'vitest';
import {
  PRESSURE_FPS,
  pressureFromLoad,
  pressureLabel,
  scaledFps,
} from '../../src/shared/resource-pressure';

/**
 * 资源压力档与可视化帧率（QYP3-036）：性能保护据此在 CPU 紧张时降帧。
 */
describe('resource pressure (QYP3-036)', () => {
  it('maps the load-per-core ratio to a pressure level', () => {
    expect(pressureFromLoad(0, 4)).toBe('normal');
    expect(pressureFromLoad(2.4, 4)).toBe('normal'); // 0.6
    expect(pressureFromLoad(2.8, 4)).toBe('busy'); // 0.7
    expect(pressureFromLoad(3.6, 4)).toBe('busy'); // 0.9
    expect(pressureFromLoad(4, 4)).toBe('critical'); // 1.0
    expect(pressureFromLoad(8, 4)).toBe('critical');
  });

  it('is safe with zero cores / non-finite load', () => {
    expect(pressureFromLoad(5, 0)).toBe('normal');
    expect(pressureFromLoad(Number.NaN, 4)).toBe('normal');
  });

  it('scales the target fps with pressure only when power save is on', () => {
    expect(scaledFps(30, true, 'normal')).toBe(30);
    expect(scaledFps(30, true, 'busy')).toBe(PRESSURE_FPS.busy);
    expect(scaledFps(30, true, 'critical')).toBe(PRESSURE_FPS.critical);
    // 关闭性能保护：任何压力都按基准帧率
    expect(scaledFps(30, false, 'critical')).toBe(30);
    // 基准低于档位时不抬高
    expect(scaledFps(6, true, 'busy')).toBe(6);
    // 绝不降到 0（仍要有最小刷新）
    expect(scaledFps(30, true, 'critical')).toBeGreaterThan(0);
  });

  it('labels the pressure in Chinese', () => {
    expect(pressureLabel('normal')).toContain('正常');
    expect(pressureLabel('busy')).toContain('系统较忙');
    expect(pressureLabel('critical')).toContain('系统繁忙');
  });
});
