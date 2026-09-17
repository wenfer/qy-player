// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import Settings from '../../../src/renderer/pages/Settings/index';

/**
 * 设置页板块页签（QYP3-029）。
 *
 * 影视配置（自动连播 / 跳片头片尾）与音乐配置（引擎 / 音量链路 / 均衡器 /
 * 歌词）是两个独立配置域，分区后不该互相遮挡：切到音乐时页面上不应还留着
 * 影视项，反之亦然。
 *
 * 三个子组件各自有独立单测，这里把它们换成标记节点，只验证外壳：
 * 同时只挂载一个板块 + 页签语义正确。
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

describe('settings tabs (QYP3-029)', () => {
  it('mounts only the playback section by default', () => {
    render(<Settings />);
    expect(screen.getByText('播放板块')).toBeTruthy();
    expect(screen.queryByText('音乐板块')).toBeNull();
    expect(screen.queryByText('插件板块')).toBeNull();
    expect(screen.getByRole('tab', { name: '播放', selected: true })).toBeTruthy();
  });

  it('shows the music section alone — no video settings left on screen', () => {
    render(<Settings />);
    fireEvent.click(screen.getByRole('tab', { name: '音乐' }));
    expect(screen.getByText('音乐板块')).toBeTruthy();
    expect(screen.queryByText('播放板块')).toBeNull();
    expect(screen.getByRole('tab', { name: '音乐', selected: true })).toBeTruthy();
    expect(screen.getByRole('tab', { name: '播放', selected: false })).toBeTruthy();
  });

  it('shows the plugin section alone and links the panel to its tab', () => {
    render(<Settings />);
    fireEvent.click(screen.getByRole('tab', { name: '插件' }));
    expect(screen.getByText('插件板块')).toBeTruthy();
    expect(screen.queryByText('播放板块')).toBeNull();
    expect(screen.queryByText('音乐板块')).toBeNull();
    const panel = screen.getByRole('tabpanel');
    expect(panel.getAttribute('aria-labelledby')).toBe('settings-tab-plugins');
  });

  it('returns to the playback section when switching back', () => {
    render(<Settings />);
    fireEvent.click(screen.getByRole('tab', { name: '音乐' }));
    fireEvent.click(screen.getByRole('tab', { name: '播放' }));
    expect(screen.getByText('播放板块')).toBeTruthy();
    expect(screen.queryByText('音乐板块')).toBeNull();
  });
});
