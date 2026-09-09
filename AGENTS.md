# AGENTS.md — QY Player 开发指南

供 AI code agent 使用。先读这里，再动手改代码。

## 项目定位（决定了所有技术约束）

**专为老版本 Linux 打造的桌面媒体播放器**（Deepin 20.9 / Debian 10 / glibc 2.28），以 MPV 为内核，支持 Jellyfin / Emby。

一切"看起来可以升级"的依赖都可能破坏对老系统的兼容性，见下方硬性约束。

## 硬性约束（违反 = 回归）

1. **Electron 锁定 21.4.4，禁止升级**。22+ 要求更新的 glibc，老系统装不上。
2. **MPV 只能用软件解码**：`--hwdec=no`（见 `mpv-process.ts`）。老机器的 VA-API/VDPAU 播放在线流会在 ~30 秒后冻结，这是实测结论，不要改回 `auto`。
3. **mpv 子进程的 stdout/stderr 必须被 drain**。spawn 默认管道 64KB 写满后 mpv 会阻塞卡死。当前做法是挂空的 `data` 监听（`mpv-process.ts`）。不要删除，也不要把 mpv 日志转发到主进程控制台（用户明确要求静默）。
4. **mpv 卸载文件时会补发 `time-pos: null`**。`PlayerCore` 收到 null 必须保留最后一次真实值，绝不能归零——否则退出时的最终保存会用 0 覆盖整场播放进度（已修复过的 bug，见 `player-core/index.ts`）。
5. **关闭主窗口 = 退出应用**。Linux 托盘图标不可靠（GNOME 无 AppIndicator 就不显示），绝不能把"退出"的唯一途径押在托盘上（`window-all-closed` → `app.quit()`）。
6. **不假设现代 Linux 工具链**：目标机 gcc 8.3、无 sudo、GitHub 直连受限。涉及老系统编译的说明见 `docs/BUILD-MPV.md`。
7. **TypeScript 严格模式 + noUnusedLocals**，提交前必须通过：
   ```bash
   npx tsc --noEmit -p tsconfig.json && npx tsc --noEmit -p tsconfig.node.json
   ```

## 架构总览

三进程结构 + 外部 MPV 子进程：

```
┌─ Electron 主进程 (out/main.cjs)
│   src/main/index.ts            入口：窗口、托盘、快捷键注册、will-quit 清理链
│   src/main/ipc/index.ts         全部 ipcMain.handle 注册（单文件，勿拆散）
│   src/main/modules/
│     player-core/               MPV 生命周期 + JSON IPC 封装
│     playback-state/            进度保存（10s 定时 + pause/eof/disconnect/crashed）+ 服务器同步回调
│     storage/db.ts              SQLite（better-sqlite3）+ MIGRATIONS
│     online-connector/          Jellyfin/Emby REST 客户端（EmbyClient 继承 JellyfinClient，路径加 /emby 前缀）
│     subtitle-engine/ ui-shell/  字幕扫描；托盘/全局快捷键/mpv 按键生成
├─ Preload (out/preload.cjs)     contextBridge 暴露 window.electronAPI，类型来自 shared/types
├─ Renderer (React 18)           pages/* + zustand stores
└─ mpv 0.32 子进程               ~/.local/bin/mpv 优先，系统 mpv 兜底；通信走 Unix Socket JSON IPC
```

数据流要点：
- **播放**：renderer 调 `playerLoadFile(url, startPos, headers, mediaContext)` → IPC → `PlaybackStateManager.setCurrentMedia(...)` → mpv `loadfile`
- **进度**：主进程每 10s 从内存态保存（读 `player.getState()`，不走 IPC）→ 本地 SQLite + 经 `reportProgress` 回传 Emby/Jellyfin（`/Sessions/Playing/Progress|Stopped`）
- **历史**：`watch_history` 表按 `(media_type, media_id)` upsert；剧集记录含 `series_name/season_number/episode_number`

## 已知机制与陷阱（改相关代码前必读）

### 播放进度
- 容器（Series/Season/Folder）无 MediaSources，播放前要解析到第一个可播子项；解析后必须把**子项的 id/标题/季集编号**传进 `mediaContext`，否则历史信息缺失（修复过的 bug）
- `MediaContext`（`shared/types`）字段：mediaType/mediaId/title/seriesName/seasonNumber/episodeNumber/mediaSourceId
- 历史缩略图**不落库**：展示时按归属服务器现场拼 `…/Items/{id}/Images/Primary?maxHeight=200`（不带 tag，Emby 返回当前主图，见 `pages/History`）

### 快捷键
- 全局快捷键：定义在 `shared/shortcut-defs.ts`；用户配置存 `app_config` 的 `shortcuts` 键（Electron accelerator 原文，如 `CommandOrControl+Shift+Q`）；注册失败要返回 failed 列表并由 UI 提示冲突
- **显示层必须格式化**：`CommandOrControl` → `Ctrl`（Mac 为 `Cmd`），`MediaPlayPause/Next/PreviousTrack` → `⏯/⏭/⏮`。不要把 Electron 内部术语直接亮给用户
- MPV 窗口按键：主进程按 `MPV_BINDINGS` 定义**动态生成** `userData/mpv-input.conf`（未配置的条目用 defaultKeys），启动时 `--input-conf` 加载；修改后用 `set_property('input-conf', path)` 热重载，失败则下次启动生效
- MPV 固定项（滚轮音量、双击全屏、a/c 菜单、Ctrl+1~5 比例预设）不可录制，UI 里归入"固定按键"区

### 窗口/托盘
- 托盘只是运行中的显隐快捷方式；菜单里有"退出"兜底

## 新增功能的固定套路

### 加一个 IPC 接口
1. `src/shared/ipc-channels.ts` 加通道常量（禁止裸字符串通道名）
2. `src/main/ipc/index.ts` 加 `ipcMain.handle`
3. `src/preload/index.ts` 的 `electronAPI` 加包装方法（renderer 禁止直接碰 ipcRenderer）
4. 需要跨进程传复杂上下文时，扩展 `shared/types` 的类型（如 `MediaContext`），主/渲染两端共用

### 数据库结构变更
- 只能**追加** migration 到 `storage/db.ts` 的 `MIGRATIONS` 数组末尾；每个 migration 是一段 SQL，包在事务里按 `schema_version` 顺序执行
- 绝不修改已发布的 migration；SQLite 用 `ALTER TABLE ADD COLUMN`，不改列
- 保留 upsert 模式：`watch_history`/`playback_progress` 都按业务键 ON CONFLICT 更新，写入时用 `COALESCE(excluded.x, x)` 防止 null 抹掉旧值

### UI 约定（用户偏好，勿回退）
- **拒绝横向滚动条**：超宽内容一律换行（`flex-wrap` / grid），用户明确反对横向拖动
- Tailwind + 深色主题语义 token（`bg-card`/`border-border`/`text-muted-foreground`/`focus-ring`）
- 异步操作必须有 Toast 反馈（`stores/toast-store`）；列表操作用乐观更新 + 失败回滚
- 面向用户的文案用中文；技术内部术语（accelerator、mpv 属性名）不得出现在 UI

## 构建与发版

```bash
npm run dev          # 开发（构建 main/preload + vite renderer + electron）
npm run typecheck    # 提交前必跑
npm run dist:all     # 全格式打包（AppImage/deb/rpm/pacman/tar）
```

- renderer 构建必须用 `vite build --config vite.renderer.config.ts`（`index.html` 在 `src/renderer/`），`npm run build` 已串好，不要单独裸跑 `vite build`
- `better-sqlite3` 是原生模块：`postinstall` 里的 `electron-builder install-app-deps` 负责 rebuild，别删
- 发版 = 推 tag：`git tag v1.0.x && git push origin v1.0.x`，GitHub Actions 自动打包发布（workflow 依赖 `rpm` 和 `libarchive-tools`，pacman 目标需要 bsdtar）
- 仓库：`git@github.com:wenfer/qy-player.git`；远端操作可能遇到瞬时 `EOF`，重试即可

## 调试

- 渲染进程 console 已转发到主进程 stdout（`[RENDERER:ERROR]` 前缀）
- MPV 日志被有意静默（见硬性约束 3）；需要看 mpv 行为时，用独立脚本连 socket 测试（参考 `scripts/cdp-test.mjs` 里的 MpvSocket 类）
- CDP 调试：`scripts/dev.js` 可临时加 `--remote-debugging-port=9222`，配 `npm run test:ui`
- 用户数据库在 `~/.config/qy-player/qy-player.db`，可用 sqlite3 直接查证数据问题

## Git 规范

- 提交信息：`feat|fix|chore|docs: 中文或英文摘要`，一行说清动机
- 推送前 typecheck 必须过；文档（README/AGENTS.md）随行为变更同步更新
