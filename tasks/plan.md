# QY Player 二期迭代规划与技术设计

> 文档状态：Draft，待人工评审批准后执行
>
> 目标读者：实现、测试和审查本迭代的 AI Agent 与人类维护者
>
> 规范性：本文是二期范围、架构和质量要求的唯一事实来源；开发状态以 [`tasks/todo.md`](todo.md) 为准
>
> 特别说明：本文不包含工时、周期或人力估算

## 0. Agent 使用协议（开始工作前必读）

本文中的“必须 / MUST”“禁止 / MUST NOT”“应该 / SHOULD”具有规范性含义。

任何 Agent 在修改代码前必须按顺序执行：

1. 阅读根目录 `AGENTS.md`，其硬性约束优先级高于本文。
2. 阅读本文第 1、3、4、5、16、17 节。
3. 在 `tasks/todo.md` 中选择第一个依赖已完成的任务；一次只领取一个任务。
4. 阅读该任务列出的 `Read first` 文件；不得用记忆替代读取当前文件。
5. 运行 `git status --short` 和 `git diff -- <预计修改文件>`，确认不会覆盖用户或其他 Agent 的改动。
6. 先写能失败的测试或可重复验证 fixture，再写实现。
7. 完成后运行任务级验证和全局质量门禁，将真实命令与结果写入任务的 `Evidence`。
8. 只有验收条件和质量门禁全部满足时才能将 `[ ]` 改为 `[x]`。

Agent 必须停止并请求人工决策的情况：

- 需求与 `AGENTS.md`、本文或已有 ADR 冲突。
- 任务需要升级 Electron、改变 mpv 软件解码、删除 pipe drain 或改变关闭窗口退出语义。
- 任务需要修改已发布 migration，而不是追加 migration。
- 需要引入新运行时依赖但无法证明 Electron 21 / Node ABI / glibc 2.28 兼容。
- 豆瓣数据路径需要绕过登录、验证码、访问限制或使用来源不明的第三方 API。
- 删除目标无法证明严格属于已配置媒体源，或 WebDAV 删除结果处于未知状态。
- 现有失败测试与当前任务无关，且无法在不扩大范围的情况下修复。
- 工作区存在与当前任务重叠的未提交改动，无法安全合并。

Agent 禁止为了让检查变绿而：

- 添加 `@ts-ignore`、`@ts-expect-error`、`eslint-disable`、覆盖率忽略或类似抑制。
- 跳过、删除或削弱已有测试和断言。
- 添加空 `catch`、未实现 stub、假成功返回、永久 TODO 或硬编码测试数据到生产逻辑。
- 降低本文阈值、修改验收条件、扩大例外，或把阻断检查改为警告。
- 顺手重构与任务无关的模块。

## 1. 当前项目事实

### 1.1 技术与架构基线

- Electron 主进程、preload、React renderer 三进程结构，外部 mpv 通过 Unix Socket JSON IPC 通信。
- Electron 固定 21.4.4；目标系统是 Deepin 20.9 / Debian 10 / glibc 2.28。
- SQLite 使用 `better-sqlite3`，migration 位于 `src/main/modules/storage/db.ts`。
- 所有 `ipcMain.handle` 集中在 `src/main/ipc/index.ts`；preload 是 renderer 唯一允许使用的系统能力入口。
- `PlayerCore` 管理 mpv；`PlaybackStateManager` 管理 10 秒定时保存和 pause/eof/disconnect/crashed 保存。
- Jellyfin/Emby client 已支持浏览、详情、直连/转码、继续观看和进度回传。
- renderer 使用 React 18、Zustand、Tailwind 和中文 UI；异步反馈通过 toast store。
- Vitest 已配置，但当前仓库没有持久化测试目录；质量基础设施必须先补齐。

### 1.2 不得回归的已知机制

- mpv 永远使用 `--hwdec=no`。
- mpv stdout/stderr 必须持续 drain，且不得把 mpv 日志转发到主进程控制台。
- `time-pos: null` 不能把最后一次有效播放位置清零。
- 关闭主窗口必须退出应用；托盘只是显隐快捷方式。
- 容器播放必须先解析到真实子项，并把子项 id、标题、季集号和 mediaSourceId 写入播放上下文。
- 所有 renderer 构建必须走 `vite.renderer.config.ts`。
- TypeScript 严格模式和 `noUnusedLocals` 必须保持启用。

### 1.3 二期必须修正的结构性问题

| 当前事实 | 风险 | 二期处理 |
|---|---|---|
| “本地”页只是打开文件/同步递归目录并播放第一个文件 | 无持久库、会阻塞主进程、没有目录模型 | 新增媒体源与异步增量扫描 |
| renderer 消费 Jellyfin/Emby 原始字段 | 新来源会复制整套 UI 分支 | 新增统一 `CatalogItem` 与 provider adapter |
| 在线查询通过遍历服务器找第一个成功结果 | 多服务器同 id 时可能串库 | 所有媒体引用必须携带 owner id |
| 旧进度表的 `media_type` CHECK 只含 local/jellyfin/emby | 不能安全追加 WebDAV 类型 | 新建目录域用户状态表，保留旧表 |
| 服务配置可把 token 返回 renderer | WebDAV 和插件密钥会扩大泄漏面 | 新建 SecretStore，所有配置输出脱敏 |
| 字幕扫描器存在但未进入统一播放链路 | 详情挂载字幕无法稳定自动加载 | 由 PlaybackResolver 统一注入 |

## 2. 产品目标与范围

### 2.1 必须交付

- 持久挂载本地目录和远程 WebDAV 根目录。
- 可取消、可恢复、不会阻塞 UI 的增量扫描。
- 读取 Kodi 风格电影、剧集、季、单集 NFO 和本地 sidecar 图片。
- 查看容器、视频、音频和字幕轨道的编解码信息。
- 一套有版本契约的元数据插件系统，内置 TMDB 和豆瓣两个 provider。
- 电影/单集续播；剧集根据最近播放状态一键续播或播放下一集。
- 详情页展示上次进度，支持从头播放。
- 详情页导入、管理并持久挂载字幕。
- 本地/WebDAV 目录项支持人工编辑元数据。
- 本地/WebDAV 独立媒体目录支持受保护的删除操作。
- 首页、媒体库和搜索统一呈现 Jellyfin、Emby、本地与 WebDAV 内容。

### 2.2 追加的高价值需求

- 来源健康状态与离线缓存：断网不删除目录记录。
- 自动刮削置信度门槛和待确认队列，降低误匹配风险。
- 元数据逐字段来源、人工锁定和恢复来源值。
- 扫描、probe、刮削任务的进度、取消、错误摘要与重试。
- 图片、技术信息和插件响应的有界磁盘缓存。
- 自然播放结束后的可取消自动下一集。
- 分页、过滤、排序和统一搜索。
- 可导出的脱敏诊断摘要。

### 2.3 明确不做

- 不升级 Electron，不增加硬解开关，不改变 mpv 日志策略。
- 不实现 SMB/NFS/S3/FUSE；系统已挂载目录可作为本地来源添加。
- 不实现服务端转码基础设施、离线下载、云同步或多用户权限。
- 不写回 NFO，不向 WebDAV 上传海报或字幕。
- 不通过本应用编辑或删除 Jellyfin/Emby 服务端媒体。
- 不安装任意第三方 JavaScript 插件，不做插件商城、热更新或动态 UI 插件。
- 不把 `node:vm` 描述成安全沙箱。
- 不绕过豆瓣风控，不接入来源不明的“豆瓣 API”。

## 3. 架构决策与能力地图

模块 id 一旦评审通过不得改名；任务和后续 ADR 使用相同 id。

| 模块 id | 职责 | 依赖 |
|---|---|---|
| `quality-foundation` | 测试、fixture、覆盖率与质量防降级 | — |
| `catalog-foundation` | 统一引用、目录实体、repository、IPC 契约 | `quality-foundation` |
| `source-local` | 本地目录配置、遍历、增量识别 | `catalog-foundation` |
| `source-webdav` | WebDAV 认证、PROPFIND/GET/DELETE、范围保护 | `catalog-foundation` |
| `metadata-nfo` | NFO、文件名解析、字段来源与合并 | `catalog-foundation` |
| `media-probe` | mpv 技术信息探测与缓存 | `catalog-foundation` |
| `plugin-runtime` | manifest、provider 契约、配置、任务与缓存 | `catalog-foundation` |
| `scraper-tmdb` | TMDB 搜索、详情、剧集和图片映射 | `plugin-runtime`, `metadata-nfo` |
| `scraper-douban` | 豆瓣候选、详情映射和安全降级 | `plugin-runtime`, `metadata-nfo` |
| `resume-engine` | 单项/剧集续播解析和自动下一集 | `catalog-foundation` |
| `subtitle-attachment` | 字幕发现、导入、关联和播放注入 | `catalog-foundation` |
| `metadata-editor` | 人工 patch、字段锁定和版本冲突 | `metadata-nfo` |
| `safe-media-delete` | 预检、确认令牌、本地回收站、WebDAV 删除 | `source-local`, `source-webdav` |
| `unified-library-ui` | 首页、目录、搜索、详情和来源状态 | 所有用户能力模块 |

依赖方向：

```text
quality-foundation
        ↓
catalog-foundation
  ├─ source-local ── metadata-nfo ── metadata-editor
  ├─ source-webdav ────────────────── safe-media-delete
  ├─ media-probe
  ├─ subtitle-attachment
  ├─ resume-engine
  └─ plugin-runtime ── scraper-tmdb / scraper-douban
                         ↓
                unified-library-ui
```

### 3.1 分层与依赖规则

```text
renderer UI
    ↓ only window.electronAPI
preload typed wrappers
    ↓ only IPC_CHANNELS
src/main/ipc/index.ts
    ↓ application services
catalog / scanner / metadata / playback / plugin services
    ↓ repositories and source adapters
SQLite / local filesystem / WebDAV / external metadata APIs / mpv
```

必须遵守：

- renderer 不得导入 Electron、Node fs/path、数据库模块或网络凭据。
- preload 不包含业务逻辑，只做参数透传、事件订阅和类型边界。
- IPC 注册仍集中在 `src/main/ipc/index.ts`，但复杂逻辑必须下沉 service。
- domain/service 不依赖 React；纯解析和排序逻辑不得依赖 Electron。
- 数据库访问集中在 repository；UI 和 source adapter 不直接写 SQL。
- 外部来源只实现 `SourceAdapter`；不得在扫描器中按 local/WebDAV 散落分支。
- 所有远端响应即使有 TypeScript 类型也必须在运行时验证。

## 4. 核心领域模型与接口

### 4.1 不可歧义的媒体标识

禁止继续使用 `mediaType + itemId` 猜测所有者：

```ts
export type MediaRef =
  | { provider: 'catalog'; sourceId: number; itemId: string }
  | { provider: 'jellyfin' | 'emby'; serverId: number; itemId: string };

export interface CatalogItemSummary {
  ref: MediaRef;
  kind: 'movie' | 'series' | 'season' | 'episode' | 'video';
  title: string;
  year?: number;
  posterUrl?: string;
  availability: 'online' | 'offline' | 'missing';
  progress?: {
    position: number;
    duration: number;
    isFinished: boolean;
  };
}
```

数据库中的 catalog item id 使用稳定 opaque id。文件重命名匹配未确认前，禁止仅用可变绝对路径作为长期业务主键。

### 4.2 SourceAdapter

```ts
export interface SourceAdapter {
  readonly kind: 'local' | 'webdav';
  testConnection(signal: AbortSignal): Promise<SourceCapabilities>;
  list(relativePath: string, signal: AbortSignal): AsyncIterable<SourceEntry>;
  stat(locator: MediaLocator, signal: AbortSignal): Promise<SourceStat>;
  open(locator: MediaLocator, signal: AbortSignal): Promise<ReadableResource>;
  deleteDirectory?(
    locator: MediaLocator,
    precondition: DeletePrecondition
  ): Promise<DeleteResult>;
}
```

- 数据库只保存来源内相对路径；绝对路径和完整 URL 只在主进程解析。
- capability 必须显式表示 `canSeek`、`canDelete`、`supportsEtag`。
- 所有方法必须支持取消、超时和结构化错误。
- WebDAV 遍历固定使用 `Depth: 1`，禁止 `Depth: infinity`。

### 4.3 IPC 结果与边界

```ts
export type ActionResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: { code: string; message: string; retryable: boolean };
    };
```

新 IPC 必须：

- 先在 `src/shared/ipc-channels.ts` 声明常量。
- 在 shared 定义输入与输出，不使用裸 `unknown` 作为已完成契约。
- 在 `src/main/ipc/index.ts` 校验 sender 和所有不可信输入。
- 在 `src/preload/index.ts` 只暴露最小包装方法。
- 列表默认分页 60，单次最大 200。
- renderer 只提交 `MediaRef`，不得提交任意真实路径、URL、HTTP Header 或删除目标。
- 事件推送最多 4Hz，并提供 unsubscribe。

建议领域通道：

| 领域 | 操作 |
|---|---|
| Source | list/test/save/remove、start/cancel scan、scan progress |
| Catalog | list/get/search、source health |
| Playback | resolve resume、play media、play next episode |
| Metadata | search candidates、apply scrape、update/reset fields |
| Media | technical info、list/attach/remove subtitle |
| Delete | preview deletion、execute deletion |
| Plugin | list/config/test、start/cancel scrape job |

## 5. 数据模型与 migration 规则

二期只能在 `MIGRATIONS` 数组末尾追加 SQL。不得编辑 migration 001～004，不得直接放宽旧 `playback_progress.media_type` CHECK。

建议新表：

| 表 | 必需约束 | 目的 |
|---|---|---|
| `library_sources` | kind/name/root/secret_ref/read_only/options；root 不含凭据 | 来源配置 |
| `catalog_items` | unique `(source_id, source_key)`；parent FK；metadata revision | 电影/剧集/季/集目录 |
| `catalog_files` | unique `(source_id, relative_path)`；item FK | 真实视频文件 |
| `catalog_streams` | unique `(file_id, stream_index)` | 技术轨道缓存 |
| `catalog_external_ids` | unique `(provider, external_id, item_id)` | TMDB/豆瓣/IMDb 映射 |
| `catalog_user_state` | unique `item_id` | 本地/WebDAV 进度 |
| `catalog_subtitles` | item FK；managed path；状态 | sidecar 与人工字幕 |
| `catalog_metadata_sources` | item/field/provider/value/revision | 字段来源 |
| `catalog_metadata_overrides` | unique item；patch/base revision | 人工锁定字段 |
| `scan_runs` | source/status/cursor/count/error/timestamps | 扫描恢复和诊断 |
| `plugin_configs` | plugin/enabled/priority/settings/secret_ref | 插件设置 |
| `plugin_cache` | plugin/key/value/etag/expiry | 有界缓存 |

迁移必须满足：

- 空库、migration 004 fixture 和重复启动三种路径均通过。
- migration 在事务内执行；失败不留下半迁移状态。
- 连接启用并验证 `PRAGMA foreign_keys = ON` 后才能依赖 FK。
- 所有 upsert 防止 null 覆盖旧有效元数据。
- 旧表保留；当用户挂载包含旧本地路径的来源时再幂等迁移进度。
- 旧进度复制成功前不得删除旧记录；冲突取 `updated_at` 较新的有效记录。
- schema 变更必须同时提交 migration 测试和数据回滚说明。

## 6. 扫描、分类与离线语义

### 6.1 扫描状态机

```text
queued → discovering → indexing → enriching → completed
                    ↘ cancelled / failed / interrupted
```

- 主进程必须使用异步迭代和有界队列；禁止同步递归 `readdirSync/statSync` 扫描整个库。
- 发现视频后先建立最小可浏览索引；NFO、probe 和在线刮削分别异步补充。
- 本地变化指纹至少包含相对路径、size、mtime。
- WebDAV 优先使用规范化 href、ETag、Last-Modified、Content-Length；无 ETag 时明确降级。
- 只有一次完整扫描成功后才可标记缺失项。
- 离线、401/403、超时、取消和崩溃不得批量标记 missing。
- missing 条目默认保留 30 天；历史和人工元数据仍可查询。
- scan run 持久化计数、当前阶段和脱敏错误摘要；应用重启将 running 修正为 interrupted。

### 6.2 分类规则

- 视频扩展集中维护，禁止每个 adapter 复制一份集合。
- 支持 `S01E02`、`1x02`、多集文件、Season 0 和常见季目录。
- 电影主文件根据 sample/extras 标记、大小和时长选择，不得简单取目录第一个文件。
- 低置信内容归为 `video` 并允许人工修正，禁止高置信误猜。
- 剧集排序固定为 season、episode、absolute number、规范化标题。

## 7. 本地来源

- 仅通过 Electron 目录选择器创建根目录；保存前规范化并确认可读。
- source root 本身可扫描但永远不能作为媒体删除目标。
- symlink 默认不跟随；若未来允许，必须单独设计循环检测和 root containment。
- 移除来源只移除索引和受管缓存，绝不删除真实媒体。
- 不可访问子目录记录错误后继续，不得让整个扫描假成功。
- 单文件“打开并播放”继续兼容一期，不要求先挂载媒体库。

## 8. WebDAV 来源

### 8.1 支持边界

- 应用内逻辑挂载，不依赖 FUSE、sudo 或目标机额外命令。
- 首批支持 HTTP/HTTPS、无认证和 Basic/App Password；其他认证必须另立规格。
- HTTPS 是默认；保存 HTTP 来源前必须显示明文传输风险。
- `PROPFIND Depth: 0/1` 用于探测与遍历，`GET` 用于媒体/NFO/图片/字幕，`DELETE` 只在显式开启后用于独立目录。
- 播放前探测 Range/seek；不支持 seek 时可以播放，但必须在 UI 标明拖动和续播不可靠。

### 8.2 URL、凭据与响应约束

- base URL 固定为 origin + 根路径，禁止 userinfo、query token、fragment 和非 HTTP(S) scheme。
- 只允许访问已由用户保存的 source；播放/扫描 IPC 不接受任意 URL。
- 重定向不得跨 origin 携带 Authorization；跨 origin 默认拒绝。
- WebDAV href 解码并规范化后必须仍位于 source root 下，拒绝 `..`、双重编码和恶意 absolute href。
- XML/目录响应有大小、深度、超时和并发上限。
- 401/403 不做无界重试；幂等读取最多有限重试并支持 AbortSignal。
- renderer 只看到 `hasCredential`，看不到密码、token 或 Authorization。

### 8.3 SecretStore

- WebDAV 密码、插件密钥和迁移后的媒体服务器 token 使用同一抽象，按 namespace 隔离。
- 安全系统存储可用时使用加密持久化；不可用时默认仅会话保存并提示重新输入。
- 禁止把不可逆 hash 当成可恢复密码存储方案。
- 任何明文持久化降级都必须由人工另行批准；本文不授权自动降级。
- 旧 token 只有在新存储写入并回读验证成功后才可清空。

## 9. NFO 与元数据合并

### 9.1 支持范围

- 读取 `movie.nfo`、`tvshow.nfo`、`season.nfo` 和与 episode 视频同名的 NFO。
- 字段至少覆盖 title、originalTitle、sortTitle、year、premiered、plot、tagline、runtime、rating、contentRating、genres、studios、country、actors、directors、season、episode、uniqueid、set。
- 支持 UTF-8/UTF-16；单文件最大 2 MiB。
- 支持本地 `poster.*`、`fanart.*` 和同名 sidecar 图片。
- 本期只读，不写回 NFO，不读取 NFO 中任意外部 URL。

### 9.2 安全与合并规则

- XML parser 必须禁用 DTD、外部实体和实体展开；限制深度与节点数量。
- 解析失败保留上一次有效值，并记录到 scan run，不得清空元数据。
- 每个字段保存 provider、更新时间和 revision。
- 固定优先级：人工 override > NFO > 用户确认的 scraper > 文件名推断。
- 重新扫描或刮削只更新未人工锁定字段。
- 人工编辑使用乐观 revision；冲突必须返回差异，禁止 last-write-wins 静默覆盖。

## 10. 媒体编解码信息

- 不新增目标机 `ffprobe` 强依赖；优先用已要求存在的 mpv 单独探测。
- 先完成 mpv 0.29/0.32 spike，再锁定探测参数和兼容字段。
- probe 与播放进程隔离，无窗口、禁用户脚本、有限超时、并发默认为 1。
- probe 仍必须 `--hwdec=no`；stderr 持续 drain 且静默，stdout 只收集有上限的协议结果。
- 技术信息以本地 size+mtime 或 WebDAV ETag/Last-Modified 为缓存版本。
- probe 失败、超时、离线和不支持是不同状态；任何状态都不能阻止正常播放。

详情展示：

- 容器：格式、时长、文件大小、总码率。
- 视频：codec、profile、分辨率、帧率、码率、位深、像素格式、色彩/HDR。
- 音频：codec、语言、声道布局、采样率、码率。
- 字幕：内封/外挂、格式、语言、标题、默认/强制。

## 11. 插件系统

### 11.1 二期安全边界

二期插件系统只承载 `metadata-provider` capability，并且只加载随应用构建、进入静态 registry 的内置插件。这里的“默认插件”是“随应用打包并注册”，不代表无需配置或默认联网。

```ts
export interface MetadataProviderPlugin {
  readonly manifest: {
    id: string;
    name: string;
    version: string;
    apiVersion: 1;
    capability: 'metadata-provider';
  };
  search(
    input: MetadataSearchInput,
    context: PluginContext
  ): Promise<MetadataCandidate[]>;
  getDetails(
    id: string,
    input: MetadataLookupInput,
    context: PluginContext
  ): Promise<MetadataPayload>;
}
```

`PluginContext` 只提供：

- 带 host allowlist、超时、AbortSignal、限流、最大响应体和脱敏错误的 HTTP client。
- 按插件隔离的 cache 与 secret reader。
- locale 和只读运行上下文。

禁止提供数据库、文件系统、播放器、Electron 对象、`child_process` 或任意模块加载能力。插件输出经过运行时 schema 校验和 metadata merger 后才能入库。

统一错误码：`AUTH_REQUIRED`、`RATE_LIMITED`、`NOT_FOUND`、`UPSTREAM_CHANGED`、`NETWORK_ERROR`、`INVALID_RESPONSE`、`CANCELLED`。

### 11.2 匹配与任务规则

- 电影按标题、原名、年份评分；剧集先匹配 series，再按季集号映射。
- 唯一候选置信度 `>= 0.92` 才允许自动应用。
- `0.75 <= score < 0.92` 必须进入人工确认队列。
- `< 0.75` 不应用，保留现有元数据。
- 批量刮削必须可取消、可恢复、有限并发；失败不得覆盖已有字段。
- 手工重新刮削先展示字段差异，人工锁定字段默认不变。

### 11.3 TMDB 内置插件

- 只使用 TMDB 官方 API，用户自行提供合法 key/token。
- 未配置时插件保持已安装但不可用，必须给出 `AUTH_REQUIRED`。
- 支持电影、剧集、季、集、演职员、external id、海报和背景图。
- locale 首选 `zh-CN`，缺失字段回退 `en-US`。
- 外部响应必须 schema 校验；图片 host allowlist；401、429、分页和语言回退有 fixture 测试。
- 密钥只进入 SecretStore，不进入 renderer、日志、URL 诊断或普通 cache key。

### 11.4 豆瓣内置插件

- 插件代码和 manifest 必须随应用提供；默认关闭并标记“实验性”。
- 实现前必须先记录数据入口、服务条款、授权方式、速率和字段范围。
- 若存在合法稳定接口，按接口实现；若仅能访问公开页面，只能读取无需登录的公开搜索/详情，低速强缓存。
- 禁止模拟登录、处理验证码、伪造用户、绕过限制或使用不明代理 API。
- 页面结构变化返回 `UPSTREAM_CHANGED` 并暂停批量任务，不能用空结果覆盖目录。
- 若发布门禁未通过，插件保持“已内置但不可启用”，不得宣称功能正式可用。

## 12. 续播与自动下一集

### 12.1 进度规则

- 有效续播：position 至少 30 秒且 duration 有效、未完成。
- 完成阈值沿用当前 90%，不得在二期无迁移地改变。
- “从头播放”不预先清除历史；新播放产生有效状态后正常覆盖。
- Jellyfin/Emby 优先使用服务端 UserData；本地状态仅在时间更新且数据有效时回退。

### 12.2 剧集主按钮解析算法

1. 最近播放单集未完成：继续该集和该位置。
2. 最近播放单集已完成且存在下一集：从 0 播放下一集。
3. 没有历史：播放排序后的第一集未播放内容。
4. 全部完成：按钮显示“重新播放”，确认后从第一集开始。

解析结果必须包含目标 `MediaRef`、position、reason、season/episode/title，renderer 不得复制算法。按钮文案必须明确，例如“继续播放 S01E05 · 23:18”或“播放下一集 S01E06”。

### 12.3 自动下一集

- 仅自然 EOF 触发；手动停止、mpv 崩溃、来源离线和应用退出不触发。
- 默认显示 5 秒倒计时，可取消，并可在设置中关闭。
- 必须先完成当前集最终进度保存，再切换 current media，再 loadfile。
- 同一个 EOF 只能触发一次；最后一集不显示无效倒计时。
- 必须有针对 `time-pos: null` 和退出竞态的回归测试。

## 13. 字幕挂载

- 允许 SRT/ASS/SSA/SUB/VTT，单文件最大 20 MiB。
- renderer 只能触发系统文件选择器，不得提供任意路径参数。
- 导入字幕复制到 `userData/subtitles/<opaque-item-id>/`；使用临时文件 + 原子 rename。
- 保存语言、标题、格式、来源、默认状态和健康状态。
- sidecar 与人工字幕统一展示；人工移除只删除受管副本/关联，不触碰原文件。
- WebDAV 媒体可以挂载本机字幕；不向 WebDAV 上传。
- PlaybackResolver 在主进程加载视频后注入有效字幕，并按用户语言偏好选择默认轨。
- 字幕缺失或损坏不得阻止视频播放。

## 14. 元数据编辑与媒体删除

### 14.1 元数据编辑

- 仅编辑 QY Player 对本地/WebDAV 目录的元数据，不写 Jellyfin/Emby。
- 可编辑 title、originalTitle、sortTitle、year、premiered、plot、tagline、rating、contentRating、genres、country、cast 摘要、season/episode 和 external id。
- 保存为 override patch，不覆盖 NFO/scraper 原值。
- 支持逐字段恢复来源值和整体移除 override。
- 支持导入有大小/格式限制的本地海报与背景图到受管缓存。
- 保存必须校验 revision；冲突返回字段差异。

### 14.2 两阶段安全删除

删除默认禁用，来源默认 `readOnly = true`。只允许删除拥有独立目录的本地/WebDAV 电影或剧集；禁止由季、单集或共享文件推导删除上级目录。

固定流程：

1. `previewMediaDeletion(MediaRef)` 从 catalog ownership 计算目标、文件数、大小、来源和删除方式。
2. 主进程读取 ownership 证据并解析 realpath/href，验证目标严格位于允许根目录下一层以上。
3. 返回短时效确认令牌，绑定 source、item、target fingerprint 和 operation。
4. UI 显示真实媒体标题与范围；WebDAV 永久删除要求输入媒体标题。
5. `executeMediaDeletion(token)` 重新执行全部验证。
6. 本地优先进入系统回收站；回收站失败不得自动永久删除。
7. WebDAV 使用 capability 允许的 DELETE 和前置条件；结果未知时标记 unknown，禁止假成功重试。
8. 成功后才标记 missing 并清理受管缓存；失败不先删索引。

绝对禁止：

- renderer 提交绝对路径、href 或递归删除参数。
- 删除媒体源根目录、挂载点、`/`、`$HOME` 或 root 外目标。
- 仅靠字符串前缀判断 containment。
- 在检查后允许 symlink/ancestor 被替换而不复验。
- 把 WebDAV DELETE 描述为可恢复操作。

## 15. 统一用户体验

- 首页展示所有来源的“继续观看”“最近添加”和来源健康摘要。
- 媒体库按来源、类型、排序过滤，默认分页 60。
- 搜索合并 provider 结果时以完整 `MediaRef` 去重，禁止仅按 item id 去重。
- 某一来源失败只显示局部错误，不阻塞其他来源。
- 详情页统一展示元数据、进度、季集、技术信息、字幕和合法操作。
- 所有列表使用换行 grid/flex-wrap，1280×800 不出现横向滚动条。
- 异步操作必须 Toast；长任务同时具有持久状态、取消和错误摘要。
- 新交互必须支持键盘、可见焦点、语义 label 和合理的 loading/empty/error 状态。

## 16. 二期质量契约

本节是二期 Agent 的最低质量线。除非人工在独立变更中修改本文，否则所有规则均阻断任务完成。

### 16.1 立即生效的质量底线

- TypeScript 两套配置零错误：`npm run typecheck`。
- 相关测试全部通过；里程碑结束运行 `npm test -- --run`。
- 构建相关变更必须通过 main、preload、renderer 三个 build。
- `git diff --check` 零错误。
- 不新增抑制、跳过测试、空 catch、未实现 stub 或永久 TODO。
- 不删除失败测试；测试变更必须在 Evidence 说明行为原因。
- 不提交密钥、密码、token、Authorization、带凭据 URL 或真实用户数据 fixture。
- 不修改/降低本节质量线来完成同一个功能任务。

### 16.2 测试与覆盖率

- `quality-foundation` 完成前，其他功能任务不得开始。
- 所有新增或修改的业务分支必须有自动化测试；纯样式变更至少有 renderer 行为测试或明确人工可访问性证据。
- 引入覆盖率工具后，变更业务代码的 changed-line coverage 必须 `>= 80%`。
- 首次完整覆盖率只记录真实基线；之后总覆盖率只升不降，允许 `0.5%` 测量漂移。
- migration、路径 containment、NFO、续播算法、删除、凭据脱敏和插件响应必须达到分支全覆盖；不得用整体 80% 掩盖危险分支缺失。
- 测试必须包含成功、边界、失败、取消/超时和恢复路径。
- fixture 必须最小、离线可复现、无真实凭据。

### 16.3 安全门禁

- 新依赖必须评审维护状态、许可、install scripts、传递依赖和 Electron 21/老 Linux 兼容性。
- 发布前运行 lockfile 对应的依赖审计；不得自动执行强制大版本修复。
- 不允许新增可达的 high/critical 漏洞；历史漏洞必须记录可达性和缓解，不得静默忽略。
- 所有 IPC、XML、WebDAV、插件响应和用户表单在边界验证。
- SQL 全部参数化；URL/path 不得进入 shell。
- 日志和诊断必须脱敏；mpv 日志继续静默。
- 删除攻击用例和凭据泄漏检查是发布阻断项。

### 16.4 性能与可靠性门禁

- 扫描不得同步递归整个目录，不得把完整目录树一次性加载到 renderer。
- 本地扫描并发默认不超过 8，WebDAV 不超过 4，probe 不超过 1，scraper 不超过 2；调整必须有基准证据。
- 扫描/任务事件推送不超过 4Hz；列表单页不超过 200。
- 10,000 项 synthetic fixture 建立扫描与分页基线；记录后只允许持平或改善，回退需要人工批准。
- 缓存必须有配额和 LRU/过期策略；不得清理人工导入字幕。
- 网络请求必须有 timeout、有限重试、AbortSignal；非幂等删除不得盲重试。
- 扫描、probe、刮削失败不能阻塞播放或删除已有有效元数据。

### 16.5 UI 与可访问性门禁

- 新页面在 1280×800 不出现横向滚动。
- 所有 button/input/dialog 有可访问名称；只用图标的按钮必须有 `aria-label`。
- 键盘可完成添加来源、播放、挂字幕、编辑和取消删除。
- dialog 管理初始焦点、焦点约束和关闭后焦点恢复。
- loading 使用 `aria-busy` 或可理解状态，错误使用适当 live region/alert。
- 自动化可访问性工具建立后，新增 UI 零 critical/serious 问题；建立前必须提供人工键盘验证证据。

### 16.6 架构门禁

- 每个任务最多修改约 5 个实现/测试文件；超出时先拆任务或说明不可分原因。
- 新 IPC 必须成套修改 channel、shared type、main handler、preload wrapper 和 contract test。
- 新数据库表必须成套提交 migration、repository、migration test。
- provider 特有字段不得泄漏到通用 UI；必须在 adapter/mapper 内归一化。
- renderer 不得新增 Node/Electron 权限；插件不得越过 PluginContext。
- 复杂纯逻辑优先纯函数；不得为未来假设引入未使用抽象。

### 16.7 质量线防篡改审查

任务交付前必须审查 diff 是否出现：

- 新的 suppression/ignore。
- `.skip`、`.only`、测试删除或断言减少。
- 阈值下降、检查命令删除、验收文字变弱。
- stub、空 catch、吞错或假成功。
- 新依赖、migration 或权限扩大未在任务中授权。

发现任一项时任务保持未完成，先修复或请求人工批准；禁止自行创建永久例外。

## 17. 验证矩阵与完成定义

### 17.1 测试层级

| 层级 | 必测内容 |
|---|---|
| Unit | path/URL 规范化、文件名/NFO、字段合并、匹配评分、续播、删除 guard |
| Contract | SourceAdapter、PluginProvider、IPC input/output、错误码 |
| Integration | migration 004 升级、本地临时目录、mock WebDAV、SecretStore、mpv probe |
| Renderer | 详情进度、字幕、编辑冲突、删除确认、统一来源状态 |
| E2E | 添加来源 → 扫描 → 详情 → 刮削 → 字幕 → 续播；删除仅用隔离 fixture |
| Target Linux | mpv 0.29/0.32、glibc 2.28、安装包、关闭退出、断网恢复 |

### 17.2 标准命令

```bash
npm run typecheck
npm test -- --run
npm run lint
npm run build:main
npm run build:preload
npm run build:renderer
npm run dist:all
git diff --check
```

`npm run lint` 当前可能缺少可执行配置；必须由 `quality-foundation` 修复后才能成为稳定门禁。命令不可用属于基础设施缺口，不等于检查通过。

### 17.3 每任务 Definition of Done

任务完成必须同时满足：

- 任务依赖均为 `[x]`。
- 先失败后通过的测试或等价可重复证据存在。
- 所有 acceptance criteria 均可指向代码、测试或运行证据。
- 任务级验证、`npm run typecheck`、`git diff --check` 通过。
- 没有违反第 16.7 节的防篡改行为。
- 用户可见行为使用中文、异步有反馈、错误不泄漏内部信息。
- 文档、类型和行为一致。
- `tasks/todo.md` 的 Evidence 写明命令、结果和未执行项原因。

里程碑完成还必须运行全量测试和三进程构建。发布任务必须额外完成目标 Linux、mpv 0.29/0.32 与打包验证。

## 18. 风险与失败策略

| 风险 | 必须采取的策略 |
|---|---|
| WebDAV 实现差异 | mock contract + 明确兼容矩阵；capability 决定 UI，不猜支持情况 |
| 老系统安全存储不可用 | 默认会话凭据；不自动明文持久化 |
| 大库扫描阻塞 | 异步有界队列、分阶段索引、持久状态、取消和基准 ratchet |
| NFO/XML 攻击 | 有界读取、禁实体/DTD、错误保留旧值 |
| 多服务器 item id 冲突 | MediaRef 永远包含 sourceId/serverId |
| mpv probe 阻塞/产生日志 | 独立进程、超时、并发 1、stdout 有界、stderr 静默 drain |
| 刮削误匹配 | 置信度门槛、人工确认、字段 provenance/lock |
| 豆瓣上游变化或合规问题 | 实验性默认关闭、先做发布门禁、结构变化 fail closed |
| 删除越界或结果未知 | ownership + realpath/href containment + 短时令牌 + 执行前复验 |
| 自动下一集进度串集 | 先最终保存、再切上下文、再 loadfile；重复 EOF 防护 |

## 19. 开放决策与默认值

在人工修改前，Agent 按“默认值”设计；不得把开放项扩成额外能力。

| 决策 | 默认值 |
|---|---|
| WebDAV 认证 | 无认证 + Basic/App Password |
| HTTP WebDAV | 允许，但保存前必须确认明文风险 |
| WebDAV 删除 | 来源默认只读；单独开启；永久删除输入标题确认 |
| 安全存储不可用 | 仅会话保存，重启重新输入 |
| 插件开放范围 | 只加载内置 metadata provider |
| TMDB | 内置，用户配置 key 后启用 |
| 豆瓣 | 内置、实验性、默认关闭、通过发布门禁后可启用 |
| NFO | 只读，不写回 |
| Jellyfin/Emby 写操作 | 二期不编辑、不删除服务端媒体 |
| 完成阈值 | 保持 90% |
| 自动下一集 | 默认开启，5 秒可取消，设置可关闭 |
| missing 保留 | 完整成功扫描后标记，保留 30 天 |
| symlink | 本地扫描默认不跟随 |

## 20. 实施阶段与检查点

详细任务见 [`tasks/todo.md`](todo.md)。严格按依赖执行：

| 阶段 | 任务范围 | 出口 |
|---|---|---|
| A 质量与目录基础 | QYP2-001～005 | 质量门禁、契约、schema、secret 与 repository 可用 |
| B 本地媒体库与 NFO | QYP2-006～011 | 本地库可持久浏览、增量扫描、NFO 和旧进度迁移可用 |
| C WebDAV | QYP2-012～016 | 可安全配置、扫描、seek 播放和离线恢复 |
| D 详情与媒体操作 | QYP2-017～025 | 技术信息、进度、字幕、编辑与受保护删除可用 |
| E 插件与刮削 | QYP2-026～032 | runtime、TMDB、豆瓣、候选确认与批量任务可用 |
| F 续播、统一体验与发布 | QYP2-033～038 | 剧集续播、自动下一集、统一搜索和发布门禁完成 |

任何检查点失败时，不得继续后续阶段；先修复当前阶段或记录为人工确认的阻断。

## 21. ADR 要求

以下决策在实现前必须写 Proposed ADR；仓库当前无 ADR 约定，因此默认使用 `docs/decisions/NNNN-title.md`，一旦创建后不得另起命名体系：

1. 统一 MediaRef、catalog schema 与旧进度迁移。
2. 内置 metadata provider 插件边界及不开放任意第三方代码的原因。
3. SecretStore 与老 Linux 降级策略。
4. 本地/WebDAV 两阶段安全删除。
5. mpv 0.29/0.32 技术信息探测方案。
6. 豆瓣数据路径与发布门禁。

ADR 记录上下文、决策、备选方案、后果和状态。改变已接受决策时新增 superseding ADR，禁止删除历史 ADR。
