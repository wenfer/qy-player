// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AudioFxPanel from '../../../src/renderer/components/AudioFxPanel';
import {
  AUDIO_FX_PRESETS_KEY,
  BUILTIN_FX_PRESETS,
  parseFxPresets,
} from '../../../src/renderer/utils/audio-fx-presets';
import { AUDIO_FX_DEFAULT } from '../../../src/main/modules/playback-engine/audio-fx';
import { useMusicPlaybackStore } from '../../../src/renderer/stores/music-playback-store';
import { useToastStore } from '../../../src/renderer/stores/toast-store';

/**
 * 音效预设（QYP3-068v）：结构升级到 v2（整条音效链），但**必须收得下旧的
 * `{id,label,gains}`** —— 换格式就把用户已有的自定义预设丢了。
 *
 * ⚠️ mock 必须照**真实契约**写：`SETTINGS.GET` 直接返回解码后的值，不像
 * 大多数通道那样包 `{ ok, data }`（见 utils/read-setting.ts）。第一版这里
 * mock 成 `{ok,data}`，于是"读回来"这条路径在测试里永远走不到，把
 * `?.data` 的读法钉死成了正确的——真机上预设一直读不出来（QYP3-068v 实测发现）。
 */

const api = {
  getSettings: vi.fn((_key: string) => Promise.resolve(null as unknown)),
  setSettings: vi.fn((_key: string, _value: unknown) => Promise.resolve(undefined)),
  applyAudioChain: vi.fn(() => Promise.resolve({ ok: true })),
};

vi.stubGlobal('electronAPI', api);

const LEGACY_PRESET = { id: 'custom-1', label: '我的低音', gains: [6, 5, 3, 1, 0, 0, 0, 0, 0, 0] };

beforeEach(() => {
  vi.clearAllMocks();
  useMusicPlaybackStore.setState({ engine: 'webaudio', audioFx: AUDIO_FX_DEFAULT });
  useToastStore.setState({ toasts: [] });
  // 原样返回（不包 {ok,data}）——与主进程 SETTINGS.GET 的实际返回一致
  api.getSettings.mockImplementation((key: string) =>
    Promise.resolve(key === AUDIO_FX_PRESETS_KEY ? [LEGACY_PRESET] : null)
  );
});

describe('parseFxPresets (QYP3-068v)', () => {
  it('rejects malformed payloads', () => {
    expect(parseFxPresets(null)).toEqual([]);
    expect(parseFxPresets([{ label: 'x' }])).toEqual([]);
    expect(parseFxPresets([{ id: 'a' }])).toEqual([]);
    expect(parseFxPresets(['junk'])).toEqual([]);
  });

  it('upgrades legacy gains-shaped presets instead of dropping them', () => {
    const [preset] = parseFxPresets([LEGACY_PRESET]);
    expect(preset.label).toBe('我的低音');
    // 10 段增益落到参量频段上（第 0 段 6dB）
    expect(preset.fx.eq.bands[0].gain).toBe(6);
    expect(preset.fx.eq.bands).toHaveLength(10);
  });

  it('accepts the v2 shape and never trusts dirty values', () => {
    const [preset] = parseFxPresets([
      { v: 2, id: 'x', label: '宽声场', fx: { width: 99, balance: 0, crossfeed: 99, enabled: true } },
    ]);
    expect(preset.fx.width).toBe(2); // 限幅到合法区间
    expect(preset.fx.crossfeed).toBe(1);
  });

  it('ships the seven built-in presets', () => {
    expect(BUILTIN_FX_PRESETS.map((p) => p.label)).toEqual([
      '平直',
      '重低音',
      '人声',
      '高亮',
      '电子',
      '古典',
      '摇滚',
    ]);
  });
});

describe('AudioFxPanel presets (QYP3-068v)', () => {
  it('lists built-in and custom presets; only custom ones are deletable', async () => {
    render(<AudioFxPanel onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: '我的低音' })).toBeTruthy());
    expect(screen.getByRole('button', { name: '摇滚' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '删除预设 我的低音' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '删除预设 摇滚' })).toBeNull();
  });

  it('applies a preset by writing the audio fx key (and feeds the engine)', async () => {
    render(<AudioFxPanel onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: '我的低音' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '我的低音' }));
    await waitFor(() => {
      const call = api.setSettings.mock.calls.find((c) => c[0] === 'playback.audioFx');
      expect(call).toBeTruthy();
      expect((call![1] as { eq: { bands: Array<{ gain: number }> } }).eq.bands[0].gain).toBe(6);
    });
    // 新格式下也直接喂了引擎
    expect(useMusicPlaybackStore.getState().audioFx.eq.bands[0].gain).toBe(6);
  });

  it('saves the current chain as a named preset', async () => {
    render(<AudioFxPanel onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: '我的低音' })).toBeTruthy());
    fireEvent.change(screen.getByLabelText('自定义预设名称'), { target: { value: '深夜' } });
    fireEvent.click(screen.getByRole('button', { name: '保存当前为预设' }));
    await waitFor(() => {
      const call = api.setSettings.mock.calls.find((c) => c[0] === AUDIO_FX_PRESETS_KEY);
      expect(call).toBeTruthy();
      const saved = call![1] as Array<{ label: string; fx: unknown }>;
      expect(saved.map((p) => p.label)).toEqual(['我的低音', '深夜']);
      expect(saved[1].fx).toBeTruthy(); // v2：存整条链而不是 gains
    });
  });

  it('rejects empty and duplicate preset names', async () => {
    render(<AudioFxPanel onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: '我的低音' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '保存当前为预设' }));
    expect(api.setSettings).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('自定义预设名称'), { target: { value: '我的低音' } });
    fireEvent.click(screen.getByRole('button', { name: '保存当前为预设' }));
    expect(api.setSettings).not.toHaveBeenCalled();
  });

  it('deletes a custom preset', async () => {
    render(<AudioFxPanel onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: '删除预设 我的低音' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '删除预设 我的低音' }));
    await waitFor(() => expect(api.setSettings).toHaveBeenCalledWith(AUDIO_FX_PRESETS_KEY, []));
  });

  it('rolls the list back when persisting presets rejects', async () => {
    // SETTINGS.SET 不返回 {ok}，失败只体现为 reject —— 回滚分支必须挂在这上面
    // （原来读 `res.ok === false`，恒为 false，整个回滚是死代码）
    api.setSettings.mockRejectedValueOnce(new Error('disk full'));
    render(<AudioFxPanel onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: '删除预设 我的低音' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '删除预设 我的低音' }));
    await waitFor(() =>
      expect(useToastStore.getState().toasts.some((t) => t.message === '预设保存失败')).toBe(true)
    );
    // 回滚后自定义预设还在
    expect(screen.getByRole('button', { name: '删除预设 我的低音' })).toBeTruthy();
  });
});
