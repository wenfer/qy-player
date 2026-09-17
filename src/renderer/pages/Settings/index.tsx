import { useState } from 'react';
import PluginSettings from './PluginSettings';
import PlaybackSettings from './PlaybackSettings';
import MusicSettings from './MusicSettings';

/**
 * 设置页：按板块分页签（QYP3-029）。
 *
 * 此前三块（影视播放 / 音乐 / 插件）是同一条长滚动列，音乐配置要滚过
 * 影视设置才够得着。影视与音乐是两套独立配置域（各自的播放引擎、音量
 * 链路、曲目/剧集语义），分区后互不遮挡；子组件本身仍是自描述的单测单元。
 */

type Tab = 'playback' | 'music' | 'plugins';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'playback', label: '播放' },
  { id: 'music', label: '音乐' },
  { id: 'plugins', label: '插件' },
];

export default function Settings() {
  // 设置页仅保留软件配置（U-002：媒体服务器与媒体来源已迁至「媒体库」页）。
  // 插件（QYP2-027）属于软件级配置：启停/优先级/密钥/健康。
  const [tab, setTab] = useState<Tab>('playback');

  return (
    <div className="p-8 max-w-2xl">
      <h1 className="text-2xl font-bold tracking-tight mb-2">设置</h1>
      <p className="text-sm text-muted-foreground mb-5">
        软件配置。媒体服务器（Jellyfin / Emby）与媒体来源（本地目录 / WebDAV）都在「媒体库」页面管理。
      </p>
      <div role="tablist" aria-label="设置分类" className="flex flex-wrap gap-1.5">
        {TABS.map((item) => {
          const active = tab === item.id;
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
        id={`settings-panel-${tab}`}
        aria-labelledby={`settings-tab-${tab}`}
      >
        {tab === 'playback' && <PlaybackSettings />}
        {tab === 'music' && <MusicSettings />}
        {tab === 'plugins' && <PluginSettings />}
      </div>
    </div>
  );
}
