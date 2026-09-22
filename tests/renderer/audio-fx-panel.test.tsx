// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AudioFxPanel from '../../src/renderer/components/AudioFxPanel';
import MusicToolbar from '../../src/renderer/components/MusicToolbar';
import { AUDIO_FX_KEY, useMusicPlaybackStore } from '../../src/renderer/stores/music-playback-store';
import { AUDIO_FX_DEFAULT, AUDIO_FX_MAX_BANDS } from '../../src/main/modules/playback-engine/audio-fx';

/**
 * 音效面板（QYP3-068v）。
 *
 * 钉住三件事：①入口与面板的显隐；②拖滑块**立即喂引擎**（不写盘）、松手
 * 才落盘；③Esc 与关闭按钮都能关、焦点还给入口。
 */

/**
 * 面板挂载时会异步读配置（syncAudioFx / 预设），事件处理器里的 commit 也是
 * 异步的 —— 不显式 flush 就会在测试结束之后才 setState，满屏 act 警告。
 */
const settle = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve();
  });
};

// SETTINGS.GET 直接返回解码后的值（不包 {ok,data}，见 utils/read-setting.ts）——
// mock 成 {ok,data} 会把"读回来"整条路径测成假绿
const STORED_FX = {
  ...AUDIO_FX_DEFAULT,
  eq: {
    enabled: true,
    preamp: 3,
    bands: AUDIO_FX_DEFAULT.eq.bands.map((b, i) => ({ ...b, gain: i === 0 ? 7 : 0 })),
  },
};

const api = {
  getSettings: vi.fn((_key: string) => Promise.resolve(null as unknown)),
  setSettings: vi.fn((_key: string, _value: unknown) => Promise.resolve(undefined)),
  applyAudioChain: vi.fn(() => Promise.resolve({ ok: true, applied: true })),
  playerControl: vi.fn(() => Promise.resolve({ ok: true })),
  onPlayerStateChange: vi.fn(() => () => undefined),
};

vi.stubGlobal('electronAPI', api);

beforeEach(() => {
  vi.clearAllMocks();
  useMusicPlaybackStore.setState({
    engine: 'webaudio',
    audioFx: AUDIO_FX_DEFAULT,
    current: null,
    isPlaying: false,
  });
  api.getSettings.mockImplementation((key: string) =>
    Promise.resolve(key === AUDIO_FX_KEY ? STORED_FX : null)
  );
});

describe('AudioFxPanel (QYP3-068v)', () => {
  it('renders every effect group', async () => {
    render(<AudioFxPanel onClose={vi.fn()} />);
    await settle();
    expect(screen.getByRole('dialog', { name: '音效调节' })).toBeTruthy();
    expect(screen.getByText('均衡器')).toBeTruthy();
    expect(screen.getByText('削波保护')).toBeTruthy();
    expect(screen.getByText('声场')).toBeTruthy();
    // 默认 10 段，每段都有增益滑杆
    expect(screen.getAllByLabelText(/段增益/)).toHaveLength(AUDIO_FX_DEFAULT.eq.bands.length);
  });

  it('loads the stored chain on open (not the default) and pushes it to the engine', async () => {
    render(<AudioFxPanel onClose={vi.fn()} />);
    await settle();
    await waitFor(() =>
      expect(useMusicPlaybackStore.getState().audioFx.eq.bands[0].gain).toBe(7)
    );
    expect(api.applyAudioChain).toHaveBeenCalled();
    // 界面上也反映出来（第 1 段增益 +7.0）
    expect((screen.getAllByLabelText(/段增益/)[0] as HTMLInputElement).value).toBe('7');
  });

  it('feeds the engine immediately on drag, and persists only on release', async () => {
    render(<AudioFxPanel onClose={vi.fn()} />);
    await settle();
    const gain = screen.getAllByLabelText(/段增益/)[0];
    fireEvent.change(gain, { target: { value: '6' } });
    // 立即喂引擎（内置引擎改 AudioParam，真实时）
    expect(useMusicPlaybackStore.getState().audioFx.eq.bands[0].gain).toBe(6);
    expect(api.applyAudioChain).toHaveBeenCalled();
    // 拖动中不写盘
    expect(api.setSettings).not.toHaveBeenCalled();
    // 松手才落盘
    fireEvent.mouseUp(gain);
    await settle();
    expect(api.setSettings).toHaveBeenCalledWith(AUDIO_FX_KEY, expect.objectContaining({ enabled: true }));
  });

  it('writes the config under the new key (not the legacy eqGains)', async () => {
    render(<AudioFxPanel onClose={vi.fn()} />);
    await settle();
    fireEvent.mouseUp(screen.getAllByLabelText(/段增益/)[0]);
    await settle();
    const call = api.setSettings.mock.calls.find((c: unknown[]) => c[0] === 'playback.audioFx');
    expect(call).toBeTruthy();
  });

  it('caps the band count at the documented maximum', async () => {
    const many = Array.from({ length: AUDIO_FX_MAX_BANDS }, (_, i) => ({
      freq: 100 * (i + 1),
      gain: 0,
      q: 0.7,
      type: 'peaking' as const,
    }));
    useMusicPlaybackStore.setState({
      audioFx: { ...AUDIO_FX_DEFAULT, eq: { ...AUDIO_FX_DEFAULT.eq, bands: many } },
    });
    render(<AudioFxPanel onClose={vi.fn()} />);
    await settle();
    expect(screen.getByRole('button', { name: '添加频段' })).toHaveProperty('disabled', true);
  });

  it('removes a band', async () => {
    render(<AudioFxPanel onClose={vi.fn()} />);
    await settle();
    fireEvent.click(screen.getByLabelText('删除第 1 段'));
    await settle();
    expect(screen.getAllByLabelText(/段增益/)).toHaveLength(AUDIO_FX_DEFAULT.eq.bands.length - 1);
  });

  it('tells the truth about mpv latency (松手生效)', async () => {
    useMusicPlaybackStore.setState({ engine: 'mpv' });
    render(<AudioFxPanel onClose={vi.fn()} />);
    await settle();
    expect(screen.getByText(/松手后生效/)).toBeTruthy();
  });

  it('closes on Escape and restores focus to the opener', async () => {
    const onClose = vi.fn();
    render(<AudioFxPanel onClose={onClose} />);
    await settle();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});

describe('music toolbar entry (QYP3-068v)', () => {
  it('opens the panel from the toolbar button', async () => {
    render(
      <MemoryRouter>
        <MusicToolbar />
      </MemoryRouter>
    );
    await settle();
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByLabelText('音效调节'));
    await settle();
    expect(screen.getByRole('dialog', { name: '音效调节' })).toBeTruthy();
    // 关闭后面板撤掉
    fireEvent.click(screen.getByLabelText('关闭音效面板'));
    await settle();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
