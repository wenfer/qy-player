# Spec: QY-Player

## Objective

为 Deepin 20.9（Debian 10）开发一款以 MPV 为播放内核的本地媒体播放器，同时支持 Jellyfin/Emby 媒体服务器接入。提供现代化海报墙浏览、智能字幕管理、断点续播、多码率切换等流行功能，打造本地与在线统一的观影体验。

**用户故事：**
- 作为用户，我希望通过精美的海报墙浏览本地电影和电视剧，而不是面对文件夹
- 作为用户，我希望播放器自动记住我看到哪里，下次点击直接续播
- 作为用户，我希望外挂字幕能自动匹配加载，并能微调同步
- 作为用户，我希望接入家里的 Jellyfin/Emby 服务器，像浏览本地库一样浏览在线库
- 作为用户，我希望根据网络状况选择在线视频的播放分辨率

**成功标准：**
- Jellyfin/Emby 海报墙浏览流畅，首屏加载 < 3s
- 支持本地文件直接播放，SRT/ASS/SUB/VTT 字幕自动匹配准确率 > 80%
- Jellyfin/Emby 媒体库浏览、搜索、播放、分辨率切换完整可用
- 播放进度保存与恢复延迟 < 500ms
- 应用在 Deepin 20.9 上可稳定运行，内存占用 < 400MB（非播放时）

## Tech Stack

| 层级 | 技术 | 版本/说明 |
|---|---|---|
| 桌面壳 | Electron | 21.4.4（最后一个支持 glibc 2.28 的版本） |
| 前端框架 | React | 18.3.x |
| 构建工具 | Vite | 5.x（前端），electron-builder（打包） |
| 语言 | TypeScript | 5.4.x |
| 样式 | Tailwind CSS | 3.4.x + shadcn/ui 组件库 |
| 状态管理 | Zustand | 4.5.x（前端），主进程用 EventEmitter |
| 路由 | React Router | 6.x |
| 数据库 | SQLite | 3.x（via `better-sqlite3`） |
| 播放器内核 | MPV | 0.29+（系统已安装 libmpv1） |
| 播放器通信 | MPV JSON IPC | Unix Domain Socket |
| HTTP 客户端 | axios | 1.6.x |
| 元数据 API | Jellyfin/Emby REST API | 服务器自带完整元数据与海报 |

## Commands

```bash
# 安装依赖
npm install

# 开发模式（同时启动 Vite dev server 和 Electron）
npm run dev

# 前端构建（生产环境）
npm run build

# 打包 Electron 应用（生成 .deb / AppImage）
npm run dist

# 仅打包 deb 包（Deepin 首选）
npm run dist:deb

# 代码检查
npm run lint
npm run typecheck

# 运行主进程单元测试
npm run test:main

# 运行渲染进程单元测试
npm run test:render
```

## Architecture Overview

### 进程架构

```
┌─────────────────────────────────────────────────────────────┐
│                      Electron Main Process                   │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────────┐ │
│  │ Player Core │  │ Media Library│  │ Online Connector    │ │
│  │  (MPV IPC)  │  │   (Scanner)  │  │ (Jellyfin/Emby API) │ │
│  └──────┬──────┘  └──────┬───────┘  └──────────┬──────────┘ │
│         │                │                     │            │
│  ┌──────▼──────┐  ┌──────▼───────┐  ┌──────────▼──────────┐ │
│  │Playback State│  │   Storage    │  │   Subtitle Engine   │ │
│  │  (SQLite)   │  │  (SQLite)    │  │    (File Matcher)   │ │
│  └─────────────┘  └──────────────┘  └─────────────────────┘ │
│                           │                                  │
│                    ┌──────▼───────┐                          │
│                    │   IPC Bus    │                          │
│                    └──────┬───────┘                          │
└───────────────────────────┼─────────────────────────────────┘
                            │ Electron IPC
┌───────────────────────────┼─────────────────────────────────┐
│                      Electron Renderer                       │
│  ┌─────────────┐  ┌──────▼───────┐  ┌─────────────────────┐ │
│  │  UI Shell   │  │  Poster Wall │  │  Settings / Detail  │ │
│  │  (React)    │  │   (React)    │  │     (React)         │ │
│  └─────────────┘  └──────────────┘  └─────────────────────┘ │
│                           │                                  │
│                    ┌──────▼───────┐                          │
│                    │   Zustand    │                          │
│                    └──────────────┘                          │
└─────────────────────────────────────────────────────────────┘

External:
  MPV Process (独立窗口，通过 Unix Socket 通信)
  Jellyfin/Emby Server (HTTP API)
  -- 无外部元数据 API，海报与元数据完全由 Jellyfin/Emby 服务器提供 --
```

### 窗口模型

| 模式 | 行为 | 窗口 |
|---|---|---|
| 浏览模式 | 用户浏览海报墙、设置、详情 | Electron 窗口正常显示 |
| 播放模式 | 视频开始播放 | Electron 主窗口隐藏；MPV 窗口弹出；可选显示迷你遥控悬浮窗 |
| 返回浏览 | 用户退出播放或影片结束 | MPV 窗口关闭；Electron 窗口恢复 |

MPV 启动参数模板：
```bash
mpv \
  --input-ipc-server=/tmp/qy-player-mpv.sock \
  --idle \
  --force-window=immediate \
  --keep-open \
  --save-position-on-quit=no \
  --hwdec=auto \
  --sub-auto=fuzzy \
  --fs=no
```

## Project Structure

```
qy-player/
├── docs/                        # 文档
│   ├── CAPABILITY-MAP.md
│   └── SPEC.md
├── tasks/                       # 开发计划与任务
│   ├── plan.md
│   └── todo.md
├── src/
│   ├── main/                    # Electron 主进程（Node.js 环境）
│   │   ├── index.ts             # 主入口，窗口生命周期
│   │   ├── ipc/                 # IPC 处理器注册
│   │   ├── modules/
│   │   │   ├── player-core/     # MPV 进程与 IPC 封装
│   │   │   ├── storage/         # SQLite 数据库与迁移
│   │   │   ├── playback-state/  # 进度保存与恢复
│   │   │   ├── subtitle-engine/ # 字幕扫描与加载
│   │   │   ├── media-library/   # 本地文件浏览与最近播放
│   │   │   └── online-connector/# Jellyfin/Emby 客户端
│   │   └── utils/               # 主进程工具函数
│   ├── preload/                 # Electron preload 脚本（安全桥梁）
│   │   └── index.ts
│   ├── renderer/                # 前端 React 应用
│   │   ├── main.tsx             # 渲染入口
│   │   ├── App.tsx              # 根组件与路由
│   │   ├── pages/
│   │   │   ├── Home/            # 海报墙首页
│   │   │   ├── Detail/          # 影片详情页
│   │   │   ├── Settings/        # 设置页
│   │   │   └── PlayerOverlay/   # 迷你遥控面板（可选）
│   │   ├── components/          # 共享 UI 组件
│   │   ├── stores/              # Zustand 状态管理
│   │   ├── hooks/               # 自定义 React Hooks
│   │   └── utils/               # 前端工具函数
│   └── shared/                  # 主进程与渲染进程共享代码
│       ├── types/               # TypeScript 类型定义
│       ├── constants/           # 共享常量
│       └── ipc-channels.ts      # IPC 通道名常量
├── resources/                   # 静态资源（图标、默认配置）
├── scripts/                     # 构建与开发脚本
├── electron.vite.config.ts      # 主进程/Preload Vite 配置
├── vite.renderer.config.ts      # 渲染进程 Vite 配置
├── package.json
├── tsconfig.json
└── .eslintrc.cjs
```

## Code Style

### TypeScript 规范

```typescript
// 命名规范
// - 类型/接口：PascalCase
// - 函数/变量：camelCase
// - 常量：SCREAMING_SNAKE_CASE
// - IPC 通道名：kebab-case，在 ipc-channels.ts 集中定义

// 示例：播放器状态类型
export interface PlayerState {
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  isMuted: boolean;
  isFullscreen: boolean;
  currentTrack?: MediaTrack;
}

// 示例：MPV IPC 命令封装
export class MpvClient {
  private socketPath: string;

  async loadFile(path: string, options?: LoadOptions): Promise<void> {
    await this.command('loadfile', [path, 'replace', options?.flags ?? '']);
  }

  private async command(name: string, args: unknown[] = []): Promise<unknown> {
    // IPC 实现...
  }
}
```

### 关键约定

1. **严格 null 检查**：`tsconfig.json` 开启 `strictNullChecks` 和 `strictPropertyInitialization`
2. **IPC 类型安全**：所有 IPC 调用必须通过 typed IPC bridge，禁止直接 `ipcRenderer.send`
3. **数据库访问**：主进程唯一访问 SQLite，渲染进程通过 IPC 请求数据
4. **错误处理**：所有 async 函数必须处理错误，使用 Result/Either 模式或 try-catch + 用户通知
5. **资源释放**：MPV 进程、数据库连接、文件句柄必须在窗口关闭时正确释放

## Testing Strategy

| 层级 | 框架 | 范围 | 目标覆盖率 |
|---|---|---|---|
| 主进程单元 | Vitest | `src/main/modules/*` 纯逻辑函数 | 60% |
| 渲染进程单元 | Vitest + React Testing Library | `src/renderer/**` 组件与 Hooks | 50% |
| IPC 集成 | Vitest（主进程侧） | IPC handler 端到端 | 核心流程覆盖 |
| E2E | Playwright（可选后期） | 完整用户场景 | 关键路径 |

**测试原则：**
- 业务逻辑（字幕匹配、进度计算、URL 构建）必须有单元测试
- 涉及 MPV IPC 的测试使用 mock socket
- 涉及文件系统的测试使用临时目录并在测试后清理

## Module Specifications

### M1: storage（数据持久化层）

**职责：** 提供 SQLite 数据库访问、Schema 迁移、配置管理。

**Schema 设计：**

```sql
-- 本地播放记录（轻量级，不存储完整元数据）
CREATE TABLE local_media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,
  title TEXT,              -- 从文件名提取的显示标题
  duration INTEGER,        -- 秒，首次播放时提取
  file_size INTEGER,
  last_played INTEGER,     -- unixepoch
  created_at INTEGER DEFAULT (unixepoch())
);

-- 播放进度
CREATE TABLE playback_progress (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  media_type TEXT NOT NULL CHECK(media_type IN ('local', 'jellyfin', 'emby')),
  local_media_id INTEGER REFERENCES local_media(id),
  server_id TEXT, -- 在线服务的条目ID
  position REAL NOT NULL DEFAULT 0, -- 秒
  duration REAL,
  is_finished INTEGER DEFAULT 0,
  updated_at INTEGER DEFAULT (unixepoch())
);

-- 观看历史
CREATE TABLE watch_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  media_type TEXT NOT NULL,
  media_id TEXT NOT NULL,
  title TEXT,
  poster_url TEXT,
  watched_at INTEGER DEFAULT (unixepoch()),
  position REAL,
  duration REAL
);

-- 在线服务器配置
CREATE TABLE servers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK(type IN ('jellyfin', 'emby')),
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  api_key TEXT,
  username TEXT,
  user_id TEXT,
  is_active INTEGER DEFAULT 1,
  created_at INTEGER DEFAULT (unixepoch())
);

-- 应用配置
CREATE TABLE app_config (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at INTEGER DEFAULT (unixepoch())
);
```

**接口：**
```typescript
interface Storage {
  // 本地媒体 CRUD
  upsertLocalMedia(media: LocalMedia): LocalMedia;
  getLocalMediaById(id: number): LocalMedia | undefined;
  getLocalMediaByPath(path: string): LocalMedia | undefined;
  queryLocalMedia(filter: MediaFilter): LocalMedia[];
  deleteLocalMedia(id: number): void;

  // 进度
  saveProgress(progress: PlaybackProgress): void;
  getProgress(mediaType: string, mediaId: string): PlaybackProgress | undefined;
  getContinueWatching(limit?: number): WatchHistoryItem[];

  // 服务器
  saveServer(server: ServerConfig): ServerConfig;
  getServers(): ServerConfig[];
  deleteServer(id: number): void;

  // 配置
  getConfig(key: string): string | undefined;
  setConfig(key: string, value: string): void;
}
```

### M2: player-core（播放内核封装）

**职责：** 管理 MPV 进程生命周期，封装 JSON IPC 通信协议，暴露播放控制 API。

**状态机：**
```
[IDLE] --loadFile--> [LOADING] --file-loaded--> [PLAYING]
  ^                                              |
  |                                              |
  +-----------pause/resume-----------------------+
  |
  +-----------stop-------------------------------+
```

**关键 API：**
```typescript
interface PlayerCore {
  start(options?: MpvOptions): Promise<void>;
  quit(): Promise<void>;
  loadFile(path: string, startPosition?: number): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  togglePause(): Promise<void>;
  seek(seconds: number, type?: 'relative' | 'absolute'): Promise<void>;
  setVolume(volume: number): Promise<void>;
  setFullscreen(fullscreen: boolean): Promise<void>;
  cycleSubtitle(): Promise<void>;
  addSubtitle(path: string): Promise<void>;
  setProperty(name: string, value: unknown): Promise<void>;
  getProperty(name: string): Promise<unknown>;
  observeProperty(name: string, callback: (value: unknown) => void): void;

  // 事件
  on(event: 'time-pos' | 'duration' | 'pause' | 'eof' | 'error', handler: Function): void;
}
```

**MPV IPC 实现细节：**
- 使用 Node.js `net.createConnection('/tmp/qy-player-mpv.sock')`
- 每个 JSON 命令追加 `\n`，监听 `data` 事件按行解析 JSON
- 命令格式：`{"command": ["loadfile", "/path/to/file.mp4"], "request_id": 1}\n`
- 响应格式：`{"data": null, "error": "success", "request_id": 1}`
- 事件格式：`{"event": "property-change", "name": "time-pos", "data": 123.4}`
- 通过 `request_id` 将异步响应与 Promise 关联

**需观察的 MPV 属性：**
- `time-pos`：当前播放位置（秒），用于进度保存
- `duration`：总时长
- `pause`：暂停状态
- `volume`：音量
- `fullscreen`：全屏状态
- `track-list`：音轨/字幕轨列表
- `current-tracks`：当前选中轨道
- `eof-reached`：播放结束

### M3: playback-state（进度管理）

**职责：** 自动保存播放进度，支持断点续播和观看历史。

**行为：**
- 每 5 秒或暂停时保存当前进度到 SQLite
- 若进度 > 90% 且接近结尾，标记为"已看完"
- 加载影片时自动查询上次进度，通过 MPV `start` 参数恢复
- 提供"继续观看"列表（最近 20 条未看完记录）

**接口：**
```typescript
interface PlaybackStateManager {
  init(player: PlayerCore): void; // 注册属性监听
  getResumePosition(mediaId: string, mediaType: string): number;
  markFinished(mediaId: string, mediaType: string): void;
  getContinueWatching(): ContinueWatchingItem[];
}
```

### M4: subtitle-engine（字幕引擎）

**职责：** 自动发现并加载外挂字幕，支持多语言切换和同步微调。

**字幕扫描规则：**
- 同目录下与视频文件主名相同的字幕文件：
  - `Movie.mkv` → `Movie.srt`, `Movie.ass`, `Movie.zh.srt`, `Movie.en.ass`
- 同目录下的 `Subs/` 或 `Subtitles/` 子文件夹
- 支持格式：`.srt`, `.ass`, `.ssa`, `.sub`, `.vtt`

**语言识别：**
- 从文件名提取语言标签：`Movie.chs.srt` → 简体中文
- 支持常见标签映射：`chs/zh-cn/Chinese` → 中文, `eng/en` → 英文, `jpn/jp` → 日文

**接口：**
```typescript
interface SubtitleEngine {
  scanForSubtitles(videoPath: string): SubtitleTrack[];
  autoLoadSubtitle(videoPath: string, preferredLang?: string): Promise<void>;
  addSubtitleTrack(path: string, title?: string): Promise<void>;
  setSubtitleDelay(delayMs: number): Promise<void>;
  cycleSubtitles(): Promise<void>;
}
```

### M5: media-library（本地文件浏览）

**职责：** 提供本地文件快速访问入口（打开文件/文件夹），管理最近播放记录和播放列表。海报墙完全由 Jellyfin/Emby 服务器提供，本地视频不构建独立的海报墙数据库。

**本地播放入口：**
1. **打开文件**：文件选择器选择单个视频文件
2. **打开文件夹**：选择文件夹后列出其中视频文件（单层或递归）
3. **最近播放**：从 `watch_history` 表读取最近播放的本地和在线视频
4. **播放列表**：用户可创建自定义播放列表，添加本地文件

**文件识别：**
- 支持扩展名：`.mp4`, `.mkv`, `.avi`, `.mov`, `.wmv`, `.m2ts`, `.ts`, `.flv`, `.webm`
- 文件夹浏览时过滤非视频文件

**接口：**
```typescript
interface MediaLibrary {
  // 文件浏览
  openFile(): Promise<string | null>;        // 返回选择的文件路径
  openFolder(): Promise<string[]>;           // 返回文件夹内视频路径列表
  listVideosInFolder(path: string): string[];

  // 最近播放
  getRecentlyPlayed(limit?: number): WatchHistoryItem[];
  addToHistory(item: WatchHistoryItem): void;

  // 播放列表
  createPlaylist(name: string): Playlist;
  addToPlaylist(playlistId: number, filePath: string): void;
  getPlaylist(playlistId: number): Playlist;
}
```

### M6: online-connector（在线服务接入）

**职责：** 连接 Jellyfin/Emby 服务器，同步媒体库，获取流媒体 URL。

**Jellyfin API 要点：**
- 服务器发现：`GET {baseUrl}/system/info/public`
- 认证：`POST {baseUrl}/Users/AuthenticateByName`（用户名+密码）→ 返回 `AccessToken`
- 用户视图：`GET {baseUrl}/Users/{userId}/Views`
- 项目列表：`GET {baseUrl}/Users/{userId}/Items?ParentId={viewId}`
- 流媒体 URL：`GET {baseUrl}/Videos/{itemId}/master.m3u8?MediaSourceId={id}&api_key={token}`
- 图片 URL：`{baseUrl}/Items/{itemId}/Images/Primary?maxHeight=500`

**Emby API 要点：**
- 与 Jellyfin API 高度兼容（同源项目），主要差异在认证端点和部分字段名
- 认证：`POST {baseUrl}/Users/AuthenticateByName`
- 流媒体 URL 结构类似

**转码与直接播放：**
- 优先尝试 DirectPlay（原码流）
- 如不支持，请求 HLS 转码流，通过 `MaxStreamingBitrate` 参数控制分辨率/码率
- 分辨率选项映射：原画 / 1080p (10Mbps) / 720p (4Mbps) / 480p (2Mbps)

**接口：**
```typescript
interface OnlineConnector {
  discoverServers(timeout?: number): Promise<DiscoveredServer[]>;
  connect(server: ServerConfig): Promise<ConnectionResult>;
  getLibraries(): Promise<MediaLibraryView[]>;
  getItems(parentId: string, options?: ItemQuery): Promise<MediaItem[]>;
  getItemDetails(itemId: string): Promise<MediaItem>;
  getStreamingUrl(itemId: string, mediaSourceId: string, bitrate?: number): string;
  getPosterUrl(itemId: string): string;
  getContinueWatching(): Promise<MediaItem[]>;
  getNextUp(): Promise<MediaItem[]>;
}
```

### M7: poster-wall（海报墙）

**职责：** 以网格/列表形式展示 Jellyfin/Emby 媒体库内容，支持分类、筛选、搜索。海报和元数据完全由服务器提供，播放器不做任何本地刮削。

**视图设计：**
- 首页：横向滚动分类行（继续观看、最近添加、电影、电视剧）— 数据来自在线服务器
- 电影页：海报网格，支持按类型/年份/评分筛选
- 电视剧页：海报网格，点击进入季/集选择
- 搜索页：实时搜索（仅在线服务器内容；本地文件通过"打开文件"入口访问）
- 详情页：大背景图 + 海报 + 简介 + 演职员 + 播放/续播按钮
- 本地入口页："打开文件"、"打开文件夹"、"最近播放"快捷入口

**数据来源：**
- 所有海报、背景图、元数据通过 Jellyfin/Emby API 实时获取
- 海报图片直接使用服务器图片 URL（如 `{baseUrl}/Items/{id}/Images/Primary`）
- 播放器本地不缓存海报图片，依赖浏览器/HTTP 缓存

**交互：**
- 海报悬停：放大 + 显示标题 + 评分
- 键盘导航：方向键浏览，Enter 播放，Backspace 返回
- 遥控器/手柄支持（通过 MPV 的 input 事件转发）

### M8: settings（设置中心）

**职责：** 管理应用配置和用户偏好。

**配置项：**
- **在线服务器**：Jellyfin/Emby 服务器添加/编辑/删除
- **播放偏好**：默认字幕语言、默认音轨语言、自动加载同名字幕
- **流媒体**：默认分辨率（原画/1080p/720p/480p）
- **字幕**：字体大小、颜色、描边、延迟步长
- **界面**：主题（暗色/亮色/自动）、海报墙网格大小
- **高级**：日志级别、缓存清理、MPV 启动参数自定义

### M9: ui-shell（应用外壳）

**职责：** 窗口管理、系统托盘、全局快捷键、路由导航。

**窗口行为：**
- 浏览模式：可调整大小窗口，最小 1024x768
- 播放模式：Electron 主窗口隐藏（或最小化到托盘）
- 关闭按钮：最小化到系统托盘，托盘图标右键菜单（显示/退出）
- 启动时恢复上次窗口位置和大小

**全局快捷键（系统级）：**
- `MediaPlayPause`：播放/暂停
- `MediaNextTrack`：下一集（电视剧）
- `MediaPreviousTrack`：上一集
- `Ctrl+Shift+Q`：显示/隐藏播放器

**路由结构：**
```
/              → 首页（混合推荐）
/movies        → 电影海报墙
/tvshows       → 电视剧海报墙
/detail/:type/:id → 详情页
/search        → 搜索页
/settings      → 设置页
```

## Data Model

### 核心实体关系

```
LocalMedia (1) ───< (*) PlaybackProgress
  │
  ├── type: movie | tvshow | episode
  ├── parent_id → LocalMedia (tvshow/season)
  └── indexed by: path

ServerConfig (1) ───< (*) 在线媒体项（运行时内存，不持久化完整元数据）

PlaybackProgress (1) per (media_type + media_id)
  ├── media_type: local | jellyfin | emby
  └── position, is_finished
```

## Internal API Design (IPC)

所有主进程 ↔ 渲染进程通信通过类型安全的 IPC bridge：

```typescript
// src/shared/ipc-channels.ts
export const IPC_CHANNELS = {
  PLAYER: {
    LOAD_FILE: 'player:load-file',
    CONTROL: 'player:control',      // play, pause, seek, volume
    GET_STATE: 'player:get-state',
    ON_STATE_CHANGE: 'player:on-state-change',
  },
  LIBRARY: {
    GET_MOVIES: 'library:get-movies',
    GET_TVSHOWS: 'library:get-tvshows',
    GET_EPISODES: 'library:get-episodes',
    SCAN: 'library:scan',
    ON_SCAN_PROGRESS: 'library:on-scan-progress',
  },
  ONLINE: {
    GET_LIBRARIES: 'online:get-libraries',
    GET_ITEMS: 'online:get-items',
    GET_STREAM_URL: 'online:get-stream-url',
    GET_CONTINUE_WATCHING: 'online:get-continue-watching',
  },
  PROGRESS: {
    SAVE: 'progress:save',
    GET: 'progress:get',
    GET_CONTINUE: 'progress:get-continue',
  },
  SETTINGS: {
    GET: 'settings:get',
    SET: 'settings:set',
    GET_SERVERS: 'settings:get-servers',
    SAVE_SERVER: 'settings:save-server',
  },
  WINDOW: {
    ENTER_PLAYER_MODE: 'window:enter-player-mode',
    EXIT_PLAYER_MODE: 'window:exit-player-mode',
    SET_FULLSCREEN: 'window:set-fullscreen',
  },
} as const;
```

## Boundaries

### Always（必须遵守）
- 所有代码使用 TypeScript 严格模式，禁止隐式 `any`
- 数据库 Schema 变更必须写迁移脚本，禁止直接修改旧数据
- MPV 进程启动失败时必须回退到错误提示，不能崩溃主进程
- 所有网络请求（Jellyfin/Emby）必须设置超时（10s）和重试（最多 3 次）
- 用户敏感数据（API Key、密码）必须加密存储（使用 `safe-storage` 或主进程密钥加密）

### Ask First（改动前需确认）
- 新增 npm 依赖（尤其是原生模块）
- 修改 IPC 接口或通道名
- 更改数据库 Schema
- 升级 Electron 版本
- 添加遥测/网络上报功能

### Never（禁止）
- 在渲染进程直接访问 Node.js API 或文件系统（必须通过 IPC）
- 将用户密码/Token 明文存储到 SQLite
- 在 preload 中暴露通用 `eval` 或 `require` 桥梁
- 自动向第三方发送用户观影数据
- 使用未经审查的 MPV 用户脚本（安全性风险）

## Success Criteria

| # | 标准 | 验证方式 |
|---|---|---|
| 1 | Jellyfin/Emby 海报墙首屏加载 < 3s | 性能测试 |
| 2 | 支持 MP4/MKV/AVI/MOV/WMV/FLV/WEBM 格式播放 | 功能测试 |
| 3 | 本地文件可通过"打开文件/文件夹"直接播放 | 功能测试 |
| 4 | 外挂字幕自动匹配准确率 > 80% | 单元测试 + 人工抽检 |
| 5 | 支持 SRT/ASS/SUB/VTT 字幕加载与切换 | 功能测试 |
| 6 | 字幕延迟调整范围 ±10s，步进 50ms | 功能测试 |
| 7 | 播放进度保存与恢复延迟 < 500ms | 性能测试 |
| 8 | Jellyfin/Emby 浏览、搜索、播放、分辨率切换完整可用 | 集成测试（需测试服务器） |
| 9 | Deepin 20.9 安装后可直接运行，内存占用 < 400MB（非播放） | 系统测试 |
| 10 | 应用打包为 .deb 安装包 | 构建验证 |

## Open Questions

1. **在线服务认证**：Jellyfin/Emby 是否只支持 API Key 认证，还是需要用户名/密码登录？
2. **多服务器**：是否支持同时连接多个 Jellyfin/Emby 服务器？
3. **多用户**：播放器是否为单用户设计，还是需要支持多个本地用户配置隔离？
4. **本地海报需求**：本地视频是否需要一个简单的文件列表视图（显示文件名+缩略图），还是完全通过"打开文件"即可？
