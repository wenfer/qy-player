import { cpus, loadavg } from 'node:os';
import { pressureFromLoad, type ResourcePressure } from '../../../shared/resource-pressure';

/**
 * 系统资源压力采样（QYP3-036）。
 *
 * 每 ~3s 取一次 loadavg，换算成压力档；只在**变化时**回调（避免无谓 IPC）。
 * 渲染层拿它决定可视化的目标帧率：CPU 紧张时降帧，把 CPU 让给音频解码，
 * 减少播放卡顿。所有失败都不得影响播放——采样本身不触碰播放链路。
 */

const SAMPLE_INTERVAL_MS = 3000;

let timer: NodeJS.Timeout | null = null;
let current: ResourcePressure = 'normal';

export function getResourcePressure(): ResourcePressure {
  return current;
}

export function startResourceGuard(
  broadcast: (pressure: ResourcePressure) => void,
  intervalMs = SAMPLE_INTERVAL_MS
): void {
  if (timer) return;
  let last: ResourcePressure | null = null;
  const sample = (): void => {
    try {
      current = pressureFromLoad(loadavg()[0] ?? 0, cpus().length);
    } catch {
      current = 'normal'; // 采样失败按正常处理，绝不因资源保护阻断播放
    }
    if (current !== last) {
      last = current;
      broadcast(current);
    }
  };
  sample();
  timer = setInterval(sample, intervalMs);
  // 采样定时器不该拖住进程退出
  timer.unref?.();
}

export function stopResourceGuard(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
