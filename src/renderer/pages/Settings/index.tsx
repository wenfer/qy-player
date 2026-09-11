import PluginSettings from './PluginSettings';

export default function Settings() {
  // 设置页仅保留软件配置（U-002：媒体服务器与媒体来源已迁至「媒体库」页）。
  // 插件（QYP2-027）属于软件级配置：启停/优先级/密钥/健康。
  return (
    <div className="p-8 max-w-2xl">
      <h1 className="text-2xl font-bold tracking-tight mb-2">设置</h1>
      <p className="text-sm text-muted-foreground mb-8">
        软件配置。媒体服务器（Jellyfin / Emby）与媒体来源（本地目录 / WebDAV）都在「媒体库」页面管理。
      </p>
      <PluginSettings />
    </div>
  );
}
