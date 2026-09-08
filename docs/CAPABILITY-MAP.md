# 能力映射图：QY-Player

## 概述

以 MPV 为播放内核的跨平台本地/在线混合媒体播放器，支持海报墙、外挂字幕、进度续播、多码率切换等核心能力。

## 模块划分

| 模块 ID | 职责 | 依赖 |
|---|---|---|
| `player-core` | MPV 进程生命周期管理、JSON IPC 通信、播放控制（播放/暂停/seek/音量/全屏）、音视频输出 | — |
| `storage` | SQLite 本地数据库、配置持久化、文件缓存管理 | — |
| `playback-state` | 播放进度持久化、断点续播、观看历史、播放统计 | `player-core`, `storage` |
| `subtitle-engine` | 外挂字幕扫描与匹配、字幕加载/切换、字幕延迟调整、字幕样式设置 | `player-core` |
| `media-library` | 本地文件浏览（打开文件/文件夹）、最近播放记录、播放列表管理 | `storage` |
| `online-connector` | Jellyfin/Emby 服务器发现、REST API 客户端、媒体库同步、转码流 URL 获取 | `storage` |
| `poster-wall` | 海报墙网格展示（数据源：Jellyfin/Emby API）、分类筛选、排序、搜索、媒体详情页、季/集浏览 | `online-connector` |
| `settings` | 播放偏好（分辨率/音轨/字幕默认语言）、主题、快捷键、服务器配置 | `player-core`, `subtitle-engine`, `online-connector` |
| `ui-shell` | 主窗口框架、路由导航、主题系统、窗口模式切换（浏览↔播放）、系统托盘 | `poster-wall`, `settings`, `player-core` |

## 构建顺序

```
storage
  └── player-core
        ├── playback-state
        ├── subtitle-engine
        ├── media-library      # 轻量级，仅本地文件浏览
        └── online-connector
              ├── poster-wall  # 核心海报墙，完全依赖 online-connector
              ├── settings
              └── ui-shell
```

**阶段化构建：**
1. **基础层** (M1): `storage` → `player-core`
2. **播放能力层** (M2): `playback-state` + `subtitle-engine`
3. **数据源层** (M3): `online-connector` → `media-library`（轻量级本地文件浏览）
4. **展示层** (M4): `poster-wall`（基于 Jellyfin/Emby 数据）
5. **配置层** (M5): `settings`
6. **外壳层** (M6): `ui-shell` → 集成测试

## 窗口模型

采用**浏览/播放分离**的窗口策略：

- **浏览模式**：Electron 窗口展示海报墙（Jellyfin/Emby 数据）、详情页、设置页
- **播放模式**：Electron 窗口隐藏，MPV 独立窗口接管视频渲染与 OSC（On-Screen Controller）
- **遥控模式**（可选）：播放时显示一个可拖拽的迷你 Electron 悬浮窗作为遥控面板

**海报墙数据来源**：海报墙完全使用 Jellyfin/Emby 服务器提供的元数据与海报图片，播放器本身不进行任何本地刮削。本地视频通过"打开文件/文件夹"直接播放，或浏览最近播放记录访问。

此策略避免 X11 窗口嵌入的复杂性和 Z-Order 竞争问题，同时让 MPV 的原生 OSC 和控制逻辑完全可用。
