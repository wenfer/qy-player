import { cpus, loadavg } from 'node:os';
import { pressureFromLoad, type ResourcePressure } from '../../../shared/resource-pressure';
import { isWin } from '../platform';

/**
 * 系统资源压力采样（QYP3-036）。
 *
 * 每 ~3s 取一次负载，换算成压力档；只在**变化时**回调（避免无谓 IPC）。
 * 渲染层拿它决定可视化的目标帧率：CPU 紧张时降帧，把 CPU 让给音频解码，
 * 减少播放卡顿。所有失败都不得影响播放——采样本身不触碰播放链路。
 *
 * QYP3-062：Windows 没有 loadavg（恒为 [0,0,0]），改用 os.cpus() 的
 * times 差分估算"忙核心数"（等价量纲喂同一 pressureFromLoad）；两次
 * 采样之间首次调用没有基线，按 normal 处理。采样失败也按正常处理，
 * 绝不因资源保护阻断播放。
 */

const SAMPLE_INTERVAL_MS = 3000;

export interface CpuTimes {
  idle: number;
  total: number;
}

/** 纯函数：两次 os.cpus() 快照 → 忙核心数（0..cores）。快照数为空按 0。 */
export function cpuBusyRatio(prev: CpuTimes[], curr: CpuTimes[]): number {
  if (prev.length === 0 || curr.length === 0 || prev.length !== curr.length) return 0;
  let busy = 0;
  for (let i = 0; i < curr.length; i += 1) {
    const dTotal = curr[i].total - prev[i].total;
    const dIdle = curr[i].idle - prev[i].idle;
    if (dTotal > 0) busy += 1 - Math.max(0, dIdle) / dTotal;
  }
  return busy;
}

function snapshotCpuTimes(): CpuTimes[] {
  return cpus().map((c) => ({
    idle: c.times.idle,
    total: c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq,
  }));
}

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
  let prevTimes: CpuTimes[] | null = null;
  const sample = (): void => {
    try {
      if (isWin) {
        const curr = snapshotCpuTimes();
        const busyCores = prevTimes ? cpuBusyRatio(prevTimes, curr) : 0;
        prevTimes = curr;
        // 首个采样（无基线）= 0 忙 → normal；后续为窗口期内的估算值
        current = pressureFromLoad(busyCores, curr.length || 1);
      } else {
        current = pressureFromLoad(loadavg()[0] ?? 0, cpus().length);
      }
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
