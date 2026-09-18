// @vitest-environment jsdom
import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import Settings from '../../../src/renderer/pages/Settings/index';
import { useAppModeStore } from '../../../src/renderer/stores/app-mode-store';

/**
 * 设置页板块页签（QYP3-029）+ 按模式拆分（QYP3-040）。
 *
 * 视频模式页签：播放（视频）/ 插件 / 快捷键；音乐模式页签：音乐 / 快捷键。
 * 影视与音乐是两套独立配置域，模式隔离后互不可见；快捷键是应用级配置，
 * 两种模式共用同一内容。
 *
 * 各子组件/嵌入内容换成标记节点，这里只验证外壳：页签集合随模式变化、
 * 同时只挂载一个板块、模式切换重置页签。
 */

vi.mock('../../../src/renderer/pages/Settings/PlaybackSettings', () => ({
  default: () => <div>播放板块</div>,
}));
vi.mock('../../../src/renderer/pages/Settings/MusicSettings', () => ({
  default: () => <div>音乐板块</div>,
}));
vi.mock('../../../src/renderer/pages/Settings/PluginSettings', () => ({
  default: () => <div>插件板块</div>,
}));
vi.mock('../../../src/renderer/pages/Shortcuts', () => ({
  ShortcutsContent: () => <div>快捷键板块</div>,
}));

beforeEach(() => {
  act(() => useAppModeStore.setState({ mode: 'video' }));
});

describe('settings tabs — video mode (QYP3-029/040)', () => {
  it('mounts the playback section by default with video-only tabs', () => {
    render(<Settings />);
    expect(screen.getByText('播放板块')).toBeTruthy();
    expect(screen.queryByText('音乐板块')).toBeNull();
    expect(screen.queryByText('插件板块')).toBeNull();
    expect(screen.getByRole('tab', { name: '播放', selected: true })).toBeTruthy();
    // 视频模式没有音乐页签
    expect(screen.queryByRole('tab', { name: '音乐' })).toBeNull();
    // 快捷键是应用级配置，视频模式可见
    expect(screen.getByRole('tab', { name: '快捷键' })).toBeTruthy();
  });

  it('shows the plugin section alone and links the panel to its tab', () => {
    render(<Settings />);
    fireEvent.click(screen.getByRole('tab', { name: '插件' }));
    expect(screen.getByText('插件板块')).toBeTruthy();
    expect(screen.queryByText('播放板块')).toBeNull();
    const panel = screen.getByRole('tabpanel');
    expect(panel.getAttribute('aria-labelledby')).toBe('settings-tab-plugins');
  });

  it('embeds the shared shortcuts content', () => {
    render(<Settings />);
    fireEvent.click(screen.getByRole('tab', { name: '快捷键' }));
    expect(screen.getByText('快捷键板块')).toBeTruthy();
  });
});

describe('settings tabs — music mode (QYP3-040)', () => {
  it('shows music + shortcuts only — no video or plugin settings', () => {
    act(() => useAppModeStore.setState({ mode: 'music' }));
    render(<Settings />);
    expect(screen.getByText('音乐板块')).toBeTruthy();
    expect(screen.getByRole('tab', { name: '音乐', selected: true })).toBeTruthy();
    expect(screen.getByRole('tab', { name: '快捷键' })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: '播放' })).toBeNull();
    expect(screen.queryByRole('tab', { name: '插件' })).toBeNull();
  });

  it('switching mode resets the tab to the first of the new mode', () => {
    render(<Settings />);
    fireEvent.click(screen.getByRole('tab', { name: '快捷键' }));
    expect(screen.getByText('快捷键板块')).toBeTruthy();
    // 模式切换 → key={mode} 重挂载 → 页签重置为音乐板块
    act(() => useAppModeStore.setState({ mode: 'music' }));
    expect(screen.getByText('音乐板块')).toBeTruthy();
    expect(screen.queryByText('快捷键板块')).toBeNull();
    expect(screen.getByRole('tab', { name: '音乐', selected: true })).toBeTruthy();
  });
});
