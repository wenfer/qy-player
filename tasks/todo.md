# 开发任务列表：QY-Player

> 按依赖顺序排列。每个任务应在一个专注会话（30-120分钟）内完成。

---

## M1：基础骨架

- [ ] **Task 1.1：初始化 Electron + Vite 项目结构**
  - Acceptance: `npm install` 成功；存在 `src/main/`, `src/preload/`, `src/renderer/` 目录；存在 `package.json` 并配置 `dev`/`build`/`dist` 命令
  - Verify: 运行 `npm run dev` 弹出 Electron 窗口，标题栏显示 "QY-Player"
  - Files: `package.json`, `electron.vite.config.ts`, `vite.renderer.config.ts`, `tsconfig.json`

- [ ] **Task 1.2：配置 TypeScript 严格模式与路径别名**
  - Acceptance: 开启 `strict`, `strictNullChecks`, `noImplicitAny`, `esModuleInterop`；配置 `@main/*`, `@preload/*`, `@renderer/*`, `@shared/*` 路径别名
  - Verify: 在三个进程中各写一个导入测试文件，`npm run typecheck` 零错误
  - Files: `tsconfig.json`, `tsconfig.main.json`, `tsconfig.preload.json`, `tsconfig.renderer.json`

- [ ] **Task 1.3：实现 MPV JSON IPC 客户端核心**
  - Acceptance: `MpvIpcClient` 类可连接 Unix Socket；发送命令带 `request_id`；通过 Promise 返回响应；可监听 `property-change` 事件
  - Verify: 单元测试：mock net.Socket，验证 `loadfile` 命令序列化和 `time-pos` 事件回调
  - Files: `src/main/modules/player-core/mpv-ipc-client.ts`, `tests/main/mpv-ipc-client.test.ts`

- [ ] **Task 1.4：实现 MPV 进程管理器**
  - Acceptance: `MpvProcessManager` 可启动/停止 mpv 进程；指定 socket 路径和基础参数；进程异常退出时触发 `crashed` 事件；主进程退出时自动 kill mpv
  - Verify: 集成测试：启动 mpv（使用 `--idle`），验证 socket 文件创建；停止后验证进程退出
  - Files: `src/main/modules/player-core/mpv-process.ts`, `tests/main/mpv-process.test.ts`

- [ ] **Task 1.5：搭建 SQLite 数据库与 Schema 初始化**
  - Acceptance: `Storage` 类封装 `better-sqlite3`；应用启动时自动执行 Schema 迁移（版本号管理）；提供 `exec`/`prepare` 基础方法
  - Verify: 单元测试：初始化内存数据库，验证所有表创建成功；查询 `sqlite_master` 确认表数量
  - Files: `src/main/modules/storage/db.ts`, `src/main/modules/storage/migrations/001_initial.sql`, `tests/main/storage.test.ts`

- [ ] **Task 1.6：实现类型安全的 IPC Bridge**
  - Acceptance: `preload/index.ts` 暴露 `window.electronAPI` 对象；主进程 `ipc/handlers/` 可按通道名注册 handler；渲染进程通过 typed API 调用，禁止直接 `ipcRenderer`
  - Verify: 端到端测试：渲染进程调用 `window.electronAPI.ping()`，主进程返回 `"pong"`
  - Files: `src/preload/index.ts`, `src/main/ipc/index.ts`, `src/shared/ipc-channels.ts`, `src/shared/types/ipc.ts`

- [ ] **Task 1.7：构建基础 React 应用壳**
  - Acceptance: React 18 根组件渲染；配置 React Router 内存路由；安装 Tailwind CSS 并配置；主窗口 1280x800，深色主题默认
  - Verify:  Electron 窗口显示深色背景的 "QY-Player" 标题和导航占位符
  - Files: `src/renderer/main.tsx`, `src/renderer/App.tsx`, `src/renderer/index.css`, `tailwind.config.js`

---

## M2：本地播放能力

- [ ] **Task 2.1：实现 Player Core 完整播放控制 API**
  - Acceptance: `PlayerCore` 提供 `loadFile`/`pause`/`resume`/`seek`/`setVolume`/`setFullscreen`/`cycleSubtitle`/`addSubtitle`；每个方法通过 IPC 调用 MPV；加载文件时支持 `start` 参数续播
  - Verify: 单元测试（mock MPV client）：验证每个命令发送的 JSON 结构正确；验证 `loadFile` 带 `start=120` 时正确构造参数
  - Files: `src/main/modules/player-core/index.ts`, `tests/main/player-core.test.ts`

- [ ] **Task 2.2：播放状态监听与 IPC 广播**
  - Acceptance: 主进程观察 `time-pos`/`duration`/`pause`/`eof-reached`/`track-list`；通过 IPC `player:on-state-change` 推送到渲染进程；渲染进程 Zustand store 自动更新
  - Verify: 端到端测试：mock MPV 推送 `{"event":"property-change","name":"time-pos","data":60}`，渲染进程 store 中 `currentTime === 60`
  - Files: `src/main/modules/player-core/state-bridge.ts`, `src/renderer/stores/player-store.ts`

- [ ] **Task 2.3：实现字幕扫描与语言识别**
  - Acceptance: `SubtitleEngine.scanForSubtitles(videoPath)` 返回同目录下所有匹配字幕；支持 `Subs/` 子目录；从文件名提取语言标签（`chs/zh-cn/en/jpn` 等映射到标准语言码）
  - Verify: 单元测试：在临时目录创建 `Movie.mkv`, `Movie.zh.srt`, `Subs/Movie.en.ass`，验证扫描返回 2 条字幕且语言识别正确
  - Files: `src/main/modules/subtitle-engine/scanner.ts`, `src/main/modules/subtitle-engine/lang-map.ts`, `tests/main/subtitle-scanner.test.ts`

- [ ] **Task 2.4：实现字幕加载与切换**
  - Acceptance: 调用 `autoLoadSubtitle(videoPath, preferredLang='zh')` 自动选择最佳字幕并通过 MPV `sub-add` 加载；提供 `setSubtitleDelay(delayMs)` 调整同步
  - Verify: 集成测试（mock MPV）：验证 `sub-add` 命令带正确路径；验证 `sub-delay` 设置为 1.5（1500ms / 1000）
  - Files: `src/main/modules/subtitle-engine/index.ts`, `tests/main/subtitle-engine.test.ts`

- [ ] **Task 2.5：实现播放进度保存机制**
  - Acceptance: `PlaybackStateManager` 每 5 秒写入 `playback_progress`；暂停时立即保存；进度 > 90% 标记 `is_finished`；加载影片时查询并返回 `startPosition`
  - Verify: 单元测试：模拟播放 10 秒，验证数据库中 `position` 更新；模拟播放到结尾，验证 `is_finished === 1`
  - Files: `src/main/modules/playback-state/index.ts`, `tests/main/playback-state.test.ts`

- [ ] **Task 2.6：构建播放控制 UI 组件**
  - Acceptance: 底部控制条组件：播放/暂停按钮、进度条（可拖拽 Seek）、当前/总时长、音量滑块、字幕切换下拉框、全屏按钮
  - Verify: 手动测试：播放本地视频，点击暂停/播放、拖拽进度条、切换字幕、调整音量，MPV 正确响应
  - Files: `src/renderer/components/PlayerControls/index.tsx`, `src/renderer/components/PlayerControls/ProgressBar.tsx`, `src/renderer/components/PlayerControls/VolumeControl.tsx`

- [ ] **Task 2.7：实现 Settings 数据层**
  - Acceptance: `SettingsStore` 提供 `get(key)`/`set(key, value)`；所有配置项有 TypeScript 类型定义；默认值在首次启动时初始化
  - Verify: 单元测试：设置 `preferred-subtitle-lang = zh`，验证数据库 `app_config` 表正确写入；重启后读取仍为 `zh`
  - Files: `src/main/modules/settings/store.ts`, `src/shared/types/settings.ts`, `tests/main/settings-store.test.ts`

---

## M3：海报墙与本地播放入口

- [ ] **Task 3.1：实现本地文件选择器**
  - Acceptance: `MediaLibrary.openFile()` 调用 Electron `dialog.showOpenDialog` 过滤视频文件，返回所选路径；`openFolder()` 返回文件夹内所有视频文件路径列表（递归或单层）
  - Verify: 单元测试（mock Electron dialog）：验证过滤参数正确；验证返回路径列表按文件名排序
  - Files: `src/main/modules/media-library/file-browser.ts`, `tests/main/file-browser.test.ts`

- [ ] **Task 3.2：实现最近播放记录**
  - Acceptance: `MediaLibrary.getRecentlyPlayed(limit)` 从 `watch_history` 查询最近播放记录；播放任何视频（本地或在线）后自动写入历史；记录包含标题、海报 URL（在线）、路径（本地）、播放位置、时间
  - Verify: 单元测试：模拟播放 3 个视频，验证历史表记录顺序和字段正确
  - Files: `src/main/modules/media-library/recent-played.ts`, `tests/main/recent-played.test.ts`

- [ ] **Task 3.3：构建 Jellyfin/Emby 海报墙首页 UI**
  - Acceptance: 首页从在线服务器拉取数据，展示横向滚动行：继续观看、最近添加、电影、电视剧；海报卡片直接使用服务器图片 URL；悬停放大效果；点击跳转详情页
  - Verify: 手动测试：连接 Jellyfin 服务器，首页加载 < 3s，海报正确显示，点击跳转详情正确
  - Files: `src/renderer/pages/Home/index.tsx`, `src/renderer/components/PosterCard/index.tsx`, `src/renderer/components/HorizontalRow/index.tsx`

- [ ] **Task 3.4：构建详情页 UI**
  - Acceptance: 详情页从服务器获取完整数据：大背景图（`Backdrop` 图片 URL + 暗化渐变）、左侧海报（`Primary` 图片 URL）、右侧标题/年份/评分/简介、演员列表、播放/续播按钮；电视剧显示季选择器，选中季后从服务器获取集列表
  - Verify: 手动测试：点击电影进入详情，所有字段正确渲染；点击播放请求流媒体 URL 并启动 MPV；点击电视剧切换季，集列表从服务器更新
  - Files: `src/renderer/pages/Detail/index.tsx`, `src/renderer/components/SeasonSelector/index.tsx`, `src/renderer/components/EpisodeList/index.tsx`

- [ ] **Task 3.5：构建搜索页**
  - Acceptance: 搜索页输入关键词后调用 Jellyfin/Emby `Items` API 的 `SearchTerm` 参数；实时显示搜索结果（海报+标题+类型）；支持按类型筛选（电影/电视剧/集）
  - Verify: 手动测试：输入关键词，搜索结果在 1s 内返回，结果准确
  - Files: `src/renderer/pages/Search/index.tsx`

- [ ] **Task 3.6：构建本地播放入口页**
  - Acceptance: 独立页面或首页固定区域显示："打开文件"按钮、"打开文件夹"按钮、最近播放列表（显示文件名/在线标题+小缩略图/占位图）
  - Verify: 手动测试：点击"打开文件"选择本地视频，MPV 启动播放；最近播放列表显示正确
  - Files: `src/renderer/pages/Local/index.tsx`, `src/renderer/components/RecentList/index.tsx`

- [ ] **Task 3.7：实现海报墙图片懒加载**
  - Acceptance: 海报图片使用 `loading="lazy"` 或 Intersection Observer；占位符在图片加载前显示；服务器图片 URL 直接用于 `img src`，不本地缓存
  - Verify: 手动测试：快速滚动海报墙，Network 面板观察图片按需请求；无图片时显示灰色占位
  - Files: `src/renderer/components/LazyImage/index.tsx`, `src/renderer/components/Skeleton/PosterSkeleton.tsx`

- [ ] **Task 3.8：构建在线服务器管理设置页**
  - Acceptance: 设置页可添加/编辑/删除 Jellyfin/Emby 服务器；测试连接按钮；显示连接状态（已连接/离线）；支持设为默认服务器
  - Verify: 手动测试：添加本地 Jellyfin 服务器，测试连接成功，保存后服务器列表显示在线状态
  - Files: `src/renderer/pages/Settings/ServerConfig.tsx`

---

## M4：在线服务接入

- [ ] **Task 4.1：实现 Jellyfin API 客户端**
  - Acceptance: `JellyfinClient` 实现 `discover`/`authenticate`/`getViews`/`getItems`/`getItemDetails`/`getStreamingUrl`/`getContinueWatching`；正确处理 `UserId` 和 `AccessToken` Header；图片 URL 正确拼接
  - Verify: 单元测试（mock axios）：验证认证请求 body 和响应解析；验证流媒体 URL 包含 `api_key` 和 `MediaSourceId`
  - Files: `src/main/modules/online-connector/jellyfin-client.ts`, `tests/main/jellyfin-client.test.ts`

- [ ] **Task 4.2：实现 Emby API 客户端**
  - Acceptance: `EmbyClient` 继承/复用 Jellyfin 逻辑，覆盖认证端点和差异字段；提供与 `JellyfinClient` 统一的 `OnlineConnector` 接口
  - Verify: 单元测试：验证 Emby 认证 URL 和请求体与 Jellyfin 不同点正确
  - Files: `src/main/modules/online-connector/emby-client.ts`, `tests/main/emby-client.test.ts`

- [ ] **Task 4.3：构建在线服务器配置 UI**
  - Acceptance: 设置页可添加服务器：输入名称、URL、类型（Jellyfin/Emby）、用户名密码；点击"测试连接"验证；保存后显示在服务器列表；支持设为启用/禁用
  - Verify: 手动测试：添加本地 Jellyfin 服务器，测试连接成功，保存后服务器列表显示
  - Files: `src/renderer/pages/Settings/ServerConfig.tsx`, `src/main/modules/online-connector/server-store.ts`

- [ ] **Task 4.4：实现海报墙数据适配层**
  - Acceptance: `PosterWallDataAdapter` 将 Jellyfin/Emby API 原始响应转换为前端统一的 `MediaItem` 类型；处理字段差异（Jellyfin 的 `Name` vs Emby 的 `Name` 等）；缓存当前视图数据减少重复请求
  - Verify: 单元测试：模拟 Jellyfin 和 Emby 各 5 条响应数据，验证适配后统一类型字段正确
  - Files: `src/main/modules/poster-wall/data-adapter.ts`, `src/shared/types/media-item.ts`, `tests/main/data-adapter.test.ts`

- [ ] **Task 4.5：实现流媒体 URL 构建与分辨率选择**
  - Acceptance: 播放在线视频时弹出分辨率选择：原画 / 1080p / 720p / 480p；选择后构建对应转码 URL（HLS `.m3u8` 或 DirectPlay URL）；直接播放原画时优先使用 DirectPlay
  - Verify: 单元测试：验证不同分辨率对应的 `MaxStreamingBitrate` 参数值正确（如 1080p = 10_000_000）
  - Files: `src/main/modules/online-connector/stream-url-builder.ts`, `tests/main/stream-url-builder.test.ts`

- [ ] **Task 4.6：实现在线播放集成**
  - Acceptance: 在线影片详情页点击播放 → 请求流媒体 URL → 通过 `player:load-file` 传递给 MPV（MPV 支持 HTTP/HLS 播放）；MPV 加载网络流并开始播放
  - Verify: 手动测试：选择 Jellyfin 服务器影片 → 选择 720p → MPV 窗口弹出并开始缓冲播放
  - Files: `src/main/ipc/handlers/online-play.ts`, `src/renderer/pages/Detail/PlayButton.tsx`

- [ ] **Task 4.7：实现在线进度同步（可选）**
  - Acceptance: 在线视频播放暂停/停止时，向服务器上报 `PlaybackProgressInfo`；启动时从服务器拉取 `ContinueWatching` 并合并到本地
  - Verify: 单元测试（mock axios）：验证上报请求包含 `PositionTicks` 和 `MediaSourceId`
  - Files: `src/main/modules/online-connector/progress-sync.ts`

---

## M5：Polish 与打包

- [ ] **Task 5.1：实现系统托盘与最小化到托盘**
  - Acceptance: 关闭窗口时最小化到系统托盘；托盘图标右键菜单：显示主窗口、退出；点击托盘图标恢复窗口
  - Verify: 手动测试：点击关闭按钮，窗口隐藏但托盘图标存在；右键菜单功能正常
  - Files: `src/main/modules/ui-shell/tray.ts`, `src/main/index.ts`

- [ ] **Task 5.2：注册全局媒体快捷键**
  - Acceptance: 注册 `MediaPlayPause`/`MediaNextTrack`/`MediaPreviousTrack`/`Ctrl+Shift+Q`；即使窗口未聚焦也能触发；播放时控制 MPV，未播放时忽略
  - Verify: 手动测试：播放视频时按键盘多媒体键，MPV 正确暂停/播放
  - Files: `src/main/modules/ui-shell/shortcuts.ts`

- [ ] **Task 5.3：UI 动画与懒加载优化**
  - Acceptance: 海报图片使用 `loading="lazy"` 或 Intersection Observer；海报墙加载时显示骨架屏；页面切换有淡入过渡
  - Verify: 手动测试：快速滚动海报墙，观察图片按需加载；网络限速下骨架屏可见
  - Files: `src/renderer/components/Skeleton/PosterSkeleton.tsx`, `src/renderer/components/LazyImage/index.tsx`

- [ ] **Task 5.4：实现错误处理与 Toast 通知**
  - Acceptance: 所有异步 IPC 调用失败时渲染进程显示 Toast 通知；错误类型：网络错误、服务器连接失败、MPV 启动失败、字幕加载失败；支持手动关闭和自动消失（5s）
  - Verify: 手动测试：断开网络后尝试连接 Jellyfin，看到红色 Toast "无法连接到服务器"
  - Files: `src/renderer/components/Toast/index.tsx`, `src/renderer/stores/toast-store.ts`

- [ ] **Task 5.5：实现虚拟滚动优化大数据量海报墙**
  - Acceptance: 电影/电视剧网格页在超过 200 项时使用虚拟滚动或分页；滚动时无卡顿；内存稳定不增长
  - Verify: 手动测试：导入 500+ 影片，网格页滚动流畅，任务管理器观察内存 < 400MB
  - Files: `src/renderer/components/VirtualGrid/index.tsx`

- [ ] **Task 5.6：配置 electron-builder 并生成 .deb 包**
  - Acceptance: `npm run dist:deb` 生成 `qy-player_x.x.x_amd64.deb`；包含 desktop 入口、图标、依赖声明（`mpv`, `libmpv1`）；可在 Deepin 上 `dpkg -i` 安装
  - Verify: 在干净环境（或 chroot）安装 .deb，运行 `qy-player` 命令启动成功
  - Files: `electron-builder.yml`, `scripts/build-deb.sh`, `resources/icon.png`, `resources/qy-player.desktop`

- [ ] **Task 5.7：编写 README 与用户使用文档**
  - Acceptance: README 包含：功能介绍、安装方法（Deepin）、Jellyfin/Emby 接入步骤、本地文件播放说明、快捷键列表、常见问题
  - Verify: 人工阅读检查无错别字，步骤可在当前环境复现
  - Files: `README.md`

---

## 进度追踪

| 阶段 | 任务数 | 已完成 | 状态 |
|---|---|---|---|
| M1 基础骨架 | 7 | 7 | ✅ 已完成 |
| M2 本地播放 | 7 | 7 | ✅ 已完成 |
| M3 海报墙与本地入口 | 8 | 8 | ✅ 已完成 |
| M4 在线接入 | 7 | 7 | ✅ 已完成 |
| M5 Polish 与打包 | 7 | 7 | ✅ 已完成 |
| M5 系统托盘/快捷键 | 2 | 2 | ✅ 已完成 |
| M5 打包（多格式） | 2 | 2 | ✅ 已完成 |
| **总计** | **40** | **40** | ✅ 全部完成 |
