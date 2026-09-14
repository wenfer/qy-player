# 决策记录 0008 — 桌面歌词窗口

- 状态：Draft（三期规划，待评审）
- 日期：2026-09-14
- 关联：ADR-0007（音频引擎）、AGENTS.md 窗口/托盘约束；实现位于
  `src/renderer/pages/DeskLyrics/`（规划路径）

## 背景

三期要求桌面歌词：音频播放时在屏幕上显示置顶、可拖动、逐字高亮的
歌词浮窗。目标机为 Deepin 20.9 / Debian 10 + GNOME（X11）。

## 决策

1. **独立 BrowserWindow**（不复用主窗口）：
   `transparent: true + frameless + alwaysOnTop + skipTaskbar + resizable: false`；
   Linux X11 下依赖 ARGB visual（GNOME 默认合成器满足）。
2. **鼠标穿透**：默认 `setIgnoreMouseEvents({ forward: true })`；按住
   歌词窗口内专有拖动把手（或全局快捷键）临时关闭穿透进行拖动/调整，
   释放后恢复。穿透窗口不拦截播放器热键。
3. **渲染与同步**：两行式（当前行+下一行），逐字渐变高亮；进度事件由
   主进程统一分发（renderer 引擎 timeupdate / mpv time-pos），更新
   ≤ 30fps；无歌词/纯音乐自动隐藏，恢复播放自动显示。
4. **歌词来源优先级**：内嵌歌词（ID3v2 USLT/SYLT、FLAC
   UNSYNCEDLYRICS/LYRICS、m4a ©lyr）→ 同名 `.lrc` 边车 → 服务器
   （Jellyfin 10.9+ Lyrics 端点；Emby 静默无歌词）→ 手动导入。
   **不接入任何在线歌词 API**。
5. **持久化**：位置、字号、锁定、颜色方案存 `app_config`；下次启动恢复。
6. **降级**：启动时若合成器/ARGB 不可用（实测窗口黑底），降级为不透明
   纯黑小窗并在设置页提示；不假装透明。

## 后果

- 正面：歌词浮窗独立于主窗口生命周期；主窗口最小化时歌词照常刷新。
- 负面：多一个渲染进程常驻；无词/暂停时必须自动隐藏减少合成开销；
  穿透/拖动切换涉及 `setIgnoreMouseEvents` 与消息转发，需实机矩阵验证
  （GNOME/KDE/Xfce）。
- X11 Wayland 会话超出兼容范围（Electron 21 的 Wayland 支持不完整），
  明确不承诺；检测到 Wayland 时功能入口隐藏。
