import { create } from 'zustand';
import { scaledFps, type ResourcePressure } from '../../shared/resource-pressure';

/**
 * 系统资源压力 + 性能保护开关（QYP3-036）。
 *
 * 压力档由主进程按 loadavg 采样并推送（`RESOURCE.ON_PRESSURE`），这里只存
 * 最近一档；性能保护开启时，可视化按压力降帧，把 CPU 让给音频解码。
 * 开关持久化到 `playback.powerSave`，**默认开启**（老机器优先保播放）。
 */
interface ResourceStoreState {
  pressure: ResourcePressure;
  powerSave: boolean;
  /** 订阅主进程推送并读回初值/开关；幂等。 */
  init: () => void;
  setPressure: (pressure: ResourcePressure) => void;
  setPowerSave: (enabled: boolean) => Promise<void>;
}

let inited = false;

function normalizePressure(value: unknown): ResourcePressure {
  return value === 'busy' || value === 'critical' ? value : 'normal';
}

export const useResourceStore = create<ResourceStoreState>((set) => ({
  pressure: 'normal',
  powerSave: true,

  init: () => {
    if (inited) return;
    inited = true;
    try {
      window.electronAPI.onResourcePressure?.((p) => set({ pressure: normalizePressure(p) }));
    } catch {
      // 无桥接（测试/受限环境）：保持默认，不影响播放
    }
    void Promise.resolve(window.electronAPI.getResourcePressure?.())
      .then((res) => {
        const data = (res as { data?: unknown } | undefined)?.data ?? res;
        set({ pressure: normalizePressure(data) });
      })
      .catch(() => undefined);
    void Promise.resolve(window.electronAPI.getSettings?.('playback.powerSave'))
      .then((res) => {
        const v = (res as { data?: unknown } | undefined)?.data;
        // 只有显式 false 才关闭（未设置 = 默认开启）
        set({ powerSave: v !== false && v !== 'false' });
      })
      .catch(() => undefined);
  },

  setPressure: (pressure) => set({ pressure }),

  setPowerSave: async (enabled) => {
    set({ powerSave: enabled });
    try {
      await window.electronAPI.setSettings?.('playback.powerSave', enabled);
    } catch {
      // 持久化失败不阻断：本次运行内仍生效
    }
  },
}));

/** 可视化目标帧率：性能保护开启时按系统压力降档（不超过基准帧率）。 */
export function useVisualizerFps(base = 30): number {
  const pressure = useResourceStore((s) => s.pressure);
  const powerSave = useResourceStore((s) => s.powerSave);
  return scaledFps(base, powerSave, pressure);
}
