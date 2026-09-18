/**
 * 系统资源压力（QYP3-036）。
 *
 * 精简模式下的「性能保护」：主进程按 loadavg 采样系统压力，渲染层据此降低
 * 频谱刷新帧率——应用自身最大的可控 CPU 开销就是可视化画布，CPU 紧张时把它
 * 让出去，优先保证音频不卡。不触碰进程优先级（老机/无 sudo 环境不可靠）。
 */

export type ResourcePressure = 'normal' | 'busy' | 'critical';

/** 各压力档下的可视化目标帧率（上限仍是 30fps，压力越大越省）。 */
export const PRESSURE_FPS: Record<ResourcePressure, number> = {
  normal: 30,
  busy: 12,
  critical: 3,
};

/** loadavg(1min) / 核心数 → 压力档（纯函数，可测）。 */
export function pressureFromLoad(load1: number, cores: number): ResourcePressure {
  const ratio = cores > 0 && Number.isFinite(load1) ? load1 / cores : 0;
  if (ratio >= 1) return 'critical';
  if (ratio >= 0.7) return 'busy';
  return 'normal';
}

/** 性能保护开启时的可视化帧率：不超过基准，且随压力降档（纯函数，可测）。 */
export function scaledFps(base: number, powerSave: boolean, pressure: ResourcePressure): number {
  if (!powerSave) return base;
  return Math.max(1, Math.min(base, PRESSURE_FPS[pressure]));
}

export function pressureLabel(pressure: ResourcePressure): string {
  if (pressure === 'critical') return '系统繁忙，已大幅降低频谱刷新';
  if (pressure === 'busy') return '系统较忙，已降低频谱刷新';
  return '正常';
}
