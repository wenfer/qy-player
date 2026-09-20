// @vitest-environment jsdom
import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import WindowProfileHost from '../../src/renderer/components/WindowProfileHost';
import { useAppModeStore } from '../../src/renderer/stores/app-mode-store';
import { useCompactModeStore } from '../../src/renderer/stores/compact-mode-store';

/**
 * reload 后回填（QYP3-044 修复）：窗口几何在主进程，store 在渲染层。热重载时
 * 主进程不重置，渲染层 store 归零 → 小窗口里画出完整影视界面。
 */

const setMusicMode = vi.fn(async () => ({ ok: true }));
const setCompactMode = vi.fn(async () => ({ ok: true }));
const getWindowProfile = vi.fn();

vi.stubGlobal('electronAPI', { getWindowProfile, setMusicMode, setCompactMode });

beforeEach(() => {
  vi.clearAllMocks();
  useAppModeStore.setState({ mode: 'video' });
  useCompactModeStore.setState({ compact: false });
  getWindowProfile.mockResolvedValue({ ok: true, data: { compact: false, music: false } });
});

describe('WindowProfileHost (QYP3-044)', () => {
  it('restores music mode when the window is still the portrait one', async () => {
    getWindowProfile.mockResolvedValue({ ok: true, data: { compact: false, music: true } });
    render(<WindowProfileHost />);
    await waitFor(() => expect(useAppModeStore.getState().mode).toBe('music'));
    expect(useCompactModeStore.getState().compact).toBe(false);
  });

  it('restores the compact player when the window is still the floating widget', async () => {
    getWindowProfile.mockResolvedValue({ ok: true, data: { compact: true, music: true } });
    render(<WindowProfileHost />);
    await waitFor(() => expect(useCompactModeStore.getState().compact).toBe(true));
    expect(useAppModeStore.getState().mode).toBe('music');
  });

  it('stays in video mode for a normal window', async () => {
    render(<WindowProfileHost />);
    await waitFor(() => expect(getWindowProfile).toHaveBeenCalled());
    expect(useAppModeStore.getState().mode).toBe('video');
    expect(useCompactModeStore.getState().compact).toBe(false);
  });
});
