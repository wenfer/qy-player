export default function Settings() {
  // 设置页仅保留软件配置（U-002：媒体服务器与媒体来源已迁至「媒体库」页）。
  // 后续软件级配置项（如缓存、日志、界面行为）加在这里。
  return (
    <div className="p-8 max-w-2xl">
      <h1 className="text-2xl font-bold tracking-tight mb-2">设置</h1>
      <p className="text-sm text-muted-foreground mb-8">
        软件配置。媒体服务器（Jellyfin / Emby）与媒体来源（本地目录 / WebDAV）都在「媒体库」页面管理。
      </p>
      <div className="text-center py-16 text-muted-foreground text-sm">
        暂无可配置项
      </div>
    </div>
  );
}
