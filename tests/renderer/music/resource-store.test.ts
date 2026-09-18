// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useResourceStore } from '../../../src/renderer/stores/resource-store';

/**
 * 资源压力 store（QYP3-036）：读回主进程压力档、订阅推送，性能保护开关默认开
 * 并持久化到 playback.powerSave。
 */
const api = {
  getResourcePressure: vi.fn((): Promise<{ ok: boolean; data: unknown }> =>
    Promise.resolve({ ok: true, data: 'busy' })
  ),
  getSettings: vi.fn((): Promise<{ ok: boolean; data: unknown }> =>
    Promise.resolve({ ok: true, data: null })
  ),
  setSettings: vi.fn(() => Promise.resolve({ ok: true })),
  onResourcePressure: vi.fn((_cb: (p: string) => void) => () => undefined),
};

vi.stubGlobal('electronAPI', api);

beforeEach(() => {
  vi.clearAllMocks();
  api.getResourcePressure.mockResolvedValue({ ok: true, data: 'busy' });
  api.getSettings.mockResolvedValue({ ok: true, data: null });
  useResourceStore.setState({ pressure: 'normal', powerSave: true });
});

describe('resource store (QYP3-036)', () => {
  it('init reads the pressure, defaults power save on, and subscribes', async () => {
    useResourceStore.getState().init();
    await vi.waitFor(() => expect(useResourceStore.getState().pressure).toBe('busy'));
    // 未设置过 → 默认开启（老机器优先保播放）
    expect(useResourceStore.getState().powerSave).toBe(true);

    const cb = api.onResourcePressure.mock.calls[0]?.[0];
    expect(typeof cb).toBe('function');
    cb?.('critical');
    expect(useResourceStore.getState().pressure).toBe('critical');
  });

  it('setPowerSave persists to settings', async () => {
    await useResourceStore.getState().setPowerSave(false);
    expect(useResourceStore.getState().powerSave).toBe(false);
    expect(api.setSettings).toHaveBeenCalledWith('playback.powerSave', false);
  });
});
