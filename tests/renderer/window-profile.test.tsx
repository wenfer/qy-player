// @vitest-environment jsdom
import { render, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import WindowProfileHost from '../../src/renderer/components/WindowProfileHost';
import { useAppModeStore } from '../../src/renderer/stores/app-mode-store';
import { useCompactModeStore } from '../../src/renderer/stores/compact-mode-store';

/**
 * reload 后回填（QYP3-044 修复）：窗口几何在主进程，store 在渲染层。热重载时
 * 主进程不重置，渲染层 store 归零 → 小窗口里画出完整影视界面。
 *
 * QYP3-054：恢复音乐模式必须**连默认页一起恢复**——只回填 store 的话，竖屏
 * 窗口停在影视首页上（侧栏是音乐那套、内容却是影视），看起来像"只记住一半"。
 * 只在冷启动的初始路由 `/` 上补跳；热重载保留的深链不抢。
 */

const setMusicMode = vi.fn(async () => ({ ok: true }));
const setCompactMode = vi.fn(async () => ({ ok: true }));
const getWindowProfile = vi.fn();

vi.stubGlobal('electronAPI', { getWindowProfile, setMusicMode, setCompactMode });

/** 记录当前路由（不用 screen 断言路由内容，直接探针）。 */
let currentPath = '/';

function RouteProbe(): null {
  currentPath = useLocation().pathname;
  return null;
}

function renderHost(initialPath = '/'): void {
  render(
    <MemoryRouter initialEntries={[initialPath]}>
      <WindowProfileHost />
      <RouteProbe />
      <Routes>
        <Route path="*" element={null} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  currentPath = '/';
  useAppModeStore.setState({ mode: 'video' });
  useCompactModeStore.setState({ compact: false });
  getWindowProfile.mockResolvedValue({ ok: true, data: { compact: false, music: false } });
});

describe('WindowProfileHost (QYP3-044/054)', () => {
  it('restores music mode and lands on the music page from a cold start', async () => {
    getWindowProfile.mockResolvedValue({ ok: true, data: { compact: false, music: true } });
    renderHost('/');
    await waitFor(() => expect(useAppModeStore.getState().mode).toBe('music'));
    await waitFor(() => expect(currentPath).toBe('/music'));
    expect(useCompactModeStore.getState().compact).toBe(false);
  });

  it('does not hijack a deep link preserved by a hot reload', async () => {
    getWindowProfile.mockResolvedValue({ ok: true, data: { compact: false, music: true } });
    renderHost('/settings');
    await waitFor(() => expect(useAppModeStore.getState().mode).toBe('music'));
    await waitFor(() => expect(getWindowProfile).toHaveBeenCalled());
    expect(currentPath).toBe('/settings');
  });

  it('restores the compact player when the window is still the floating widget', async () => {
    getWindowProfile.mockResolvedValue({ ok: true, data: { compact: true, music: true } });
    renderHost('/');
    await waitFor(() => expect(useCompactModeStore.getState().compact).toBe(true));
    expect(useAppModeStore.getState().mode).toBe('music');
  });

  it('stays in video mode for a normal window', async () => {
    renderHost('/');
    await waitFor(() => expect(getWindowProfile).toHaveBeenCalled());
    expect(useAppModeStore.getState().mode).toBe('video');
    expect(useCompactModeStore.getState().compact).toBe(false);
    expect(currentPath).toBe('/');
  });
});
