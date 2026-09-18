import { useState } from 'react';
import PluginSettings from './PluginSettings';
import PlaybackSettings from './PlaybackSettings';
import MusicSettings from './MusicSettings';
import { ShortcutsContent } from '../Shortcuts';
import { useAppModeStore, type AppMode } from '../../stores/app-mode-store';

/**
 * 设置页：按板块分页签（QYP3-029），页签集合随顶层模式变化（QYP3-040）。
 *
 * 影视与音乐是两套独立配置域（各自的播放引擎、音量链路、曲目/剧集语义），
 * 模式隔离后视频模式只见 播放/插件/快捷键，音乐模式只见 音乐/快捷键。
 * 快捷键是应用级配置（全局键 + MPV 键），两种模式共用同一份内容。
 */

type Tab = 'playback' | 'music' | 'plugins' | 'shortcuts';

const TABS_BY_MODE: Record<AppMode, Array<{ id: Tab; label: string }>> = {
  video: [
    { id: 'playback', label: '播放' },
    { id: 'plugins', label: '插件' },
    { id: 'shortcuts', label: '快捷键' },
  ],
  music: [
    { id: 'music', label: '音乐' },
    { id: 'shortcuts', label: '快捷键' },
  ],
};

const HINT_BY_MODE: Record<AppMode, string> = {
  video: '软件配置。媒体服务器（Jellyfin / Emby）与媒体来源（本地目录 / WebDAV）都在视频模式的「媒体库」页面管理。',
  music: '软件配置。音乐服务器与音乐来源（本地目录 / WebDAV）都在音乐模式的「媒体库」页面管理。',
};

export default function Settings() {
  // 设置页仅保留软件配置（U-002：媒体服务器与媒体来源在「媒体库」页管理）。
  const mode = useAppModeStore((s) => s.mode);
  const tabs = TABS_BY_MODE[mode];
  const [tab, setTab] = useState<Tab>(tabs[0].id);
  // 模式切换时页签重置为新模式的第一项（render 阶段状态调整；key 挂在
  // 自己返回的元素上重置不了自身 state）
  const [renderedMode, setRenderedMode] = useState(mode);
  if (renderedMode !== mode) {
    setRenderedMode(mode);
    setTab(tabs[0].id);
  }
  const activeTab = tabs.some((t) => t.id === tab) ? tab : tabs[0].id;

  return (
    <div className="p-8 max-w-2xl">
      <h1 className="text-2xl font-bold tracking-tight mb-2">设置</h1>
      <p className="text-sm text-muted-foreground mb-5">{HINT_BY_MODE[mode]}</p>
      <div role="tablist" aria-label="设置分类" className="flex flex-wrap gap-1.5">
        {tabs.map((item) => {
          const active = activeTab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              id={`settings-tab-${item.id}`}
              aria-selected={active}
              aria-controls={`settings-panel-${item.id}`}
              onClick={() => setTab(item.id)}
              className={`px-3 py-1.5 text-xs rounded-lg border transition-colors focus-ring ${
                active
                  ? 'bg-secondary border-border text-foreground'
                  : 'border-border text-muted-foreground hover:bg-accent'
              }`}
            >
              {item.label}
            </button>
          );
        })}
      </div>
      <div
        role="tabpanel"
        id={`settings-panel-${activeTab}`}
        aria-labelledby={`settings-tab-${activeTab}`}
      >
        {activeTab === 'playback' && <PlaybackSettings />}
        {activeTab === 'music' && <MusicSettings />}
        {activeTab === 'plugins' && <PluginSettings />}
        {activeTab === 'shortcuts' && <ShortcutsContent />}
      </div>
    </div>
  );
}
