// @vitest-environment jsdom
import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { CompactModeHost } from '../../../src/renderer/App';
import WindowProfileHost from '../../../src/renderer/components/WindowProfileHost';
import { useAppModeStore } from '../../../src/renderer/stores/app-mode-store';
import { useCompactModeStore } from '../../../src/renderer/stores/compact-mode-store';
import { useMusicPlaybackStore } from '../../../src/renderer/stores/music-playback-store';

/**
 * 跨重启恢复（QYP3-051）：主进程按记忆把窗口开成浮窗/竖屏，渲染层再回填。
 *
 * 这里钉住的是两个宿主**同时挂载**时的相互作用——单独测 WindowProfileHost
 * 看不出"回填出来的 compact 被 CompactModeHost 当成空会话撤销"这条竞态。
 *
 * WindowProfileHost 用了 useNavigate（QYP3-054 恢复默认页），所以要包 Router。
 */

const api = {
  getWindowProfile: vi.fn(),
  setMusicMode: vi.fn(async () => ({ ok: true })),
  setCompactMode: vi.fn(async () => ({ ok: true })),
  getSettings: vi.fn(
    async (): Promise<{ ok: boolean; data: unknown }> => ({ ok: true, data: null })
  ),
  getMusicSpectrum: vi.fn(
    async (): Promise<{ ok: boolean; data: unknown }> => ({ ok: true, data: { status: 'none' } })
  ),
};

vi.stubGlobal('electronAPI', api);

/** 让挂载后的 effect / promise 链都跑完一轮。 */
const settle = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

beforeEach(() => {
  vi.clearAllMocks();
  api.getWindowProfile.mockResolvedValue({ ok: true, data: { compact: false, music: false } });
  useAppModeStore.setState({ mode: 'video' });
  useCompactModeStore.setState({ compact: false });
  useMusicPlaybackStore.setState({ engine: null });
});

/** 测试里直接改 store = 模拟"会话开始/结束"，包进 act 免得告警。 */
function setEngine(engine: 'webaudio' | 'mpv' | null): void {
  act(() => {
    useMusicPlaybackStore.setState({ engine });
  });
}

describe('窗口/模式恢复（QYP3-051）', () => {
  it('冷启动恢复的精简浮窗不会被"没有音乐会话"撤销', async () => {
    api.getWindowProfile.mockResolvedValue({ ok: true, data: { compact: true, music: false } });
    render(
      <MemoryRouter>
        <CompactModeHost />
        <WindowProfileHost />
      </MemoryRouter>
    );

    await waitFor(() => expect(useCompactModeStore.getState().compact).toBe(true));
    await settle();
    expect(useCompactModeStore.getState().compact).toBe(true);
    expect(api.setCompactMode).not.toHaveBeenCalledWith(false);
    // 影视模式的浮窗：不该顺手把应用切成音乐模式
    expect(useAppModeStore.getState().mode).toBe('video');
  });

  it('音乐模式里的浮窗恢复后仍是音乐模式，且不重复挪窗', async () => {
    api.getWindowProfile.mockResolvedValue({ ok: true, data: { compact: true, music: true } });
    render(
      <MemoryRouter>
        <CompactModeHost />
        <WindowProfileHost />
      </MemoryRouter>
    );

    await waitFor(() => expect(useAppModeStore.getState().mode).toBe('music'));
    await waitFor(() => expect(useCompactModeStore.getState().compact).toBe(true));
    expect(api.setMusicMode).toHaveBeenCalledWith(true);
    expect(api.setMusicMode).not.toHaveBeenCalledWith(false);
  });

  it('会话真正结束时才自动还原（webaudio → null）', async () => {
    render(<CompactModeHost />);
    act(() => {
      useCompactModeStore.setState({ compact: true });
    });
    api.setCompactMode.mockClear();

    setEngine('webaudio');
    await waitFor(() => expect(useMusicPlaybackStore.getState().engine).toBe('webaudio'));
    expect(useCompactModeStore.getState().compact).toBe(true); // 播放中不还原

    setEngine(null);
    await waitFor(() => expect(useCompactModeStore.getState().compact).toBe(false));
    expect(api.setCompactMode).toHaveBeenCalledWith(false);
  });

  it('视频接管 mpv 后音乐会话结束，同样自动还原', async () => {
    render(<CompactModeHost />);
    act(() => {
      useCompactModeStore.setState({ compact: true });
    });
    setEngine('mpv');
    await waitFor(() => expect(useMusicPlaybackStore.getState().engine).toBe('mpv'));

    setEngine(null);
    await waitFor(() => expect(useCompactModeStore.getState().compact).toBe(false));
  });

  it('会话从无到有：按设置自动进入精简模式（原有行为不回归）', async () => {
    api.getSettings.mockResolvedValue({ ok: true, data: true });
    render(<CompactModeHost />);

    setEngine('mpv');
    await waitFor(() => expect(useCompactModeStore.getState().compact).toBe(true));
    expect(api.getSettings).toHaveBeenCalledWith('playback.autoCompact');
  });

  it('已经是精简模式时，起播不再重复下发', async () => {
    render(<CompactModeHost />);
    act(() => {
      useCompactModeStore.setState({ compact: true });
    });
    api.setCompactMode.mockClear();

    setEngine('mpv');
    await settle();
    expect(api.setCompactMode).not.toHaveBeenCalled();
  });
});
