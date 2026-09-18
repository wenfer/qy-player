// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { MemoryRouter, useLocation } from 'react-router-dom';
import Navigation from '../../../src/renderer/components/Navigation';
import { useAppModeStore } from '../../../src/renderer/stores/app-mode-store';

/**
 * 顶层模式切换（QYP3-040）：默认视频模式；侧栏分段切换 影视/音乐，
 * 切换时导航到该模式默认页，导航项随模式整组更换。
 * 导航项断言用 role=button（模式切换按钮是 role=radio，不会混淆）。
 */

vi.stubGlobal('electronAPI', {
  getAppVersion: vi.fn(async () => ({ ok: true, data: { version: '0.0.0-test' } })),
});

function LocationProbe(): JSX.Element {
  const { pathname } = useLocation();
  return <div data-testid="location">{pathname}</div>;
}

function renderShell(): void {
  render(
    <MemoryRouter initialEntries={['/']}>
      <Navigation />
      <LocationProbe />
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useAppModeStore.setState({ mode: 'video' });
});

describe('app mode navigation (QYP3-040)', () => {
  it('defaults to video mode with video-only nav items', () => {
    renderShell();
    expect(screen.getByRole('radio', { name: '影视', checked: true })).toBeTruthy();
    expect(screen.getByRole('button', { name: '首页' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '本地' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '历史' })).toBeTruthy();
    // 音乐域入口在视频模式不可见（模式切换按钮是 radio，不算导航项）
    expect(screen.queryByRole('button', { name: '音乐' })).toBeNull();
    expect(screen.queryByRole('button', { name: '歌单' })).toBeNull();
  });

  it('switching to music mode swaps the nav group and navigates to /music', () => {
    renderShell();
    fireEvent.click(screen.getByRole('radio', { name: '音乐' }));
    expect(screen.getByRole('radio', { name: '音乐', checked: true })).toBeTruthy();
    expect(screen.getByRole('button', { name: '音乐' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '歌单' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '媒体库' })).toBeTruthy();
    // 视频域入口不可见
    expect(screen.queryByRole('button', { name: '首页' })).toBeNull();
    expect(screen.queryByRole('button', { name: '本地' })).toBeNull();
    // 落到音乐模式默认页
    expect(screen.getByTestId('location').textContent).toBe('/music');
  });

  it('switching back to video navigates to the video home', () => {
    useAppModeStore.setState({ mode: 'music' });
    renderShell();
    expect(screen.getByRole('button', { name: '歌单' })).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: '影视' }));
    expect(screen.getByTestId('location').textContent).toBe('/');
    expect(screen.getByRole('button', { name: '首页' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '歌单' })).toBeNull();
  });

  it('music mode media library points at /music-sources and the window title follows', () => {
    useAppModeStore.setState({ mode: 'music' });
    renderShell();
    fireEvent.click(screen.getByRole('button', { name: '媒体库' }));
    expect(screen.getByTestId('location').textContent).toBe('/music-sources');
    expect(document.title).toBe('媒体库 · QY Player');
  });
});
