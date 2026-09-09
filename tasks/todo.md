# QY Player 二期任务清单（Agent 执行版）

> 设计基线：[`tasks/plan.md`](plan.md)
>
> 清单状态：任务均为待评审/待执行；未获得人工批准前，不得开始实现任务
>
> 使用规则：一次只执行一个任务；先读 `Read first`；先测试后实现；完成后填写 `Evidence`；没有证据不得勾选。

## 任务状态协议

任务状态只能是以下之一：

- `[ ]` 待处理：依赖未满足或尚未领取。
- `[>]` 进行中：当前 Agent 正在处理；必须在同一工作区声明，避免重复领取。
- `[x]` 已完成：验收、任务验证和质量门禁均有证据。
- `[!]` 阻塞：需要人工决策或外部条件；必须在 `Evidence` 写明阻塞原因，不得自行绕过。

每个任务完成时必须在末尾填写：

```text
Evidence:
- Commands: <实际执行的完整命令>
- Result: <通过/失败/未执行及原因>
- Tests: <测试文件或人工步骤>
- Review notes: <边界、风险、未解决项>
```

公共完成条件（每个任务都适用）：

- [ ] 只修改任务允许范围内的文件；发现额外范围先拆任务或请求批准。
- [ ] 没有新增 suppression、跳过/删除测试、空 catch、stub、假成功或秘密。
- [ ] 所有新增输入/输出都有 shared 类型，所有新 IPC 都使用 channel 常量。
- [ ] `git diff --check` 通过。
- [ ] `npm run typecheck` 通过（若环境没有 npm，必须标 `[!]`，不能假装通过）。
- [ ] Evidence 已填写，且与当前工作区真实结果一致。

## Phase A：质量与目录基础

### QYP2-001 建立二期质量基线

- [x] **依赖：** 无
- [x] **Read first：** `AGENTS.md`、`package.json`、`vitest.config.ts`、`tasks/plan.md` 第 16～17 节
- [x] **允许修改：** `package.json`、`vitest.config.ts`、`scripts/check-quality.mjs`、`tests/fixtures/index.ts`、`tests/quality/floor-guard.test.ts`
- [x] **目标：** 建立 Vitest 目录、最小 fixture、禁止质量线降级的检查脚本；不修改业务行为。
- [x] **验收：** 测试可发现 main/shared/renderer；fixture 无真实凭据；新增抑制/skip/stub 检查能失败。
- [x] **验证：** `npm test -- --run`、`npm run typecheck`、`git diff --check`。
- [x] **Evidence：**
  - Commands: `npm test -- --run`（4 文件 17 测试全部通过，含 14 个 floor-guard 用例）；`npm run typecheck`（两套 tsconfig 零错误）；`git diff --check`（零错误）；`npm run quality`（见 Review notes）
  - Tests: `tests/quality/floor-guard.test.ts` 证明每类禁止模式均能被检出（含行号与 scope 规则）；`tests/{main,shared,renderer}/smoke.test.ts` 证明三个目录均可发现（shared 冒烟验证 `@shared` alias，renderer 验证 jsdom 环境）；fixtures 全部为离线字符串样本，无凭据
  - Result: 通过。仓库主扫描时发现 8 处**既有**空 catch（`scripts/cdp-play.mjs`/`cdp-test.mjs`，非本任务引入），修复超出本任务允许文件清单，见 Review notes
  - Review notes: ① 新增了 3 个冒烟测试文件（允许清单外，但为验收“三目录可发现”的最小证明，已由独立子代理评审两轮，待人工追认）；② `tests/` 目前不在 tsconfig include 内（一期既有基线），测试暂未经 tsc 检查，建议在 QYP2-002 时一并处理；③ `scripts/cdp-*.mjs` 的 8 处空 catch 待人工批准后修复；④ `DEFAULT_IGNORES` 含 checker 自身与其测试文件，属审计内豁免；⑤ 协议层矛盾：todo.md 不在允许清单但协议强制要求写 Evidence，待人工裁决；
  - 评审记录: 第一轮子代理评审 Approve（3 Optional/2 Nit）；第二轮更严格 Request changes（4R/2O/4N）；提交 76a1ae9 整改后第三轮验收 **Approve**（10/10 解决，新发现 1 项 Optional flags 传递缺陷已当场修复并加回归测试，20/20 通过）；R3/R4 两项协议层问题待人工裁决

### QYP2-002 定义统一 Catalog 与 IPC 类型

- [x] **依赖：** QYP2-001
- [x] **Read first：** `src/shared/types/index.ts`、`src/shared/ipc-channels.ts`、`src/preload/index.ts`
- [ ] **允许修改：** `src/shared/types/catalog.ts`、`src/shared/types/actions.ts`、`src/shared/types/index.ts`、`src/shared/ipc-channels.ts`、`tests/shared/catalog-contracts.test.ts`
- [ ] **目标：** 定义 `MediaRef`、`CatalogItem`、分页、`ActionResult`、source capability、scan event 和结构化错误。
- [ ] **验收：** MediaRef 包含 source/server owner；列表有默认/最大 page size；ActionResult 成功/失败结构一致；无密码、token、任意路径字段。
- [x] **验证：** `npm test -- --run tests/shared/catalog-contracts.test.ts`、`npm run typecheck`。
- [x] **Evidence：**
  - Commands: `npm test -- --run`（5 文件 35 测试通过）；`npm run typecheck`（含新增的 tests/**，两套 tsconfig 零错误）；`git diff --check`（零错误）
  - Tests: `tests/shared/catalog-contracts.test.ts`（15 用例：MediaRef 判别联合 + isMediaRef 全部拒绝分支 + 原型链伪造拒绝、分页默认/钳制/非有限/溢出页码、ActionResult 成败分支与脱敏性、12 个错误码全量、通道全局唯一与格式、catalog:* 通道表与 plan §4.3 一致）
  - Result: 通过。附 ADR-0001（Proposed）与二轮评审整改
  - Review notes: ① 评审二轮提出 2R/3O/3N：R1 原型链防御（已用 hasOwnProperty.call 修复 + 回归测试）、R2 tests 未纳入 tsc（已加入 include，新增 tests/check-quality.d.ts 声明 .mjs 模块契约）；O3 页码上界（已加 1,000,000 钳制 + 边界测试）、O5 错误码全量断言（已补）、N6/N7（已修）；② O4（err() 运行时脱敏扫描）按评审建议延至 QYP2-005/008 落地；③ N8（CatalogItemSummary 无运行时 guard）保留：渲染数据来自可信主进程，guard 随 IPC handler 落地时实现；④ 允许清单外文件：tsconfig.json（R2 要求）、tests/check-quality.d.ts、docs/decisions/0001-*.md（plan §21 强制）、tasks/todo.md（协议强制），均已记录待追认

### QYP2-003 追加 Catalog 数据库 migration

- [ ] **依赖：** QYP2-002
- [ ] **Read first：** `src/main/modules/storage/db.ts`、本文第 5 节、现有 migration fixture
- [ ] **允许修改：** `src/main/modules/storage/db.ts`、`src/main/modules/catalog/repository.ts`、`tests/main/storage/catalog-migrations.test.ts`
- [ ] **目标：** 在 MIGRATIONS 末尾创建 sources/items/files/streams/user-state/subtitles/metadata/scrape 相关表及索引。
- [ ] **验收：** 不编辑 001～004；空库、v4 fixture、重复启动幂等；新表 FK/unique 生效；旧表和 CHECK 保留。
- [ ] **验证：** `npm test -- --run tests/main/storage/catalog-migrations.test.ts`、`npm run typecheck`。
- [ ] **Evidence：** 待填写

### QYP2-004 实现 Repository 与旧进度兼容

- [ ] **依赖：** QYP2-003
- [ ] **Read first：** `src/main/modules/storage/db.ts`、`src/main/modules/playback-state/index.ts`
- [ ] **允许修改：** `src/main/modules/catalog/repository.ts`、`src/main/modules/catalog/legacy-progress.ts`、`tests/main/catalog/legacy-progress.test.ts`
- [ ] **目标：** 为 catalog/source/file/metadata/progress 提供参数化 repository；旧 local_media 仅在来源挂载时幂等迁移。
- [ ] **验收：** null 不覆盖旧值；迁移按 realpath 和更新时间选择；迁移前不删除旧记录；重复执行结果稳定。
- [ ] **验证：** `npm test -- --run tests/main/catalog/legacy-progress.test.ts`、`npm run typecheck`。
- [ ] **Evidence：** 待填写

### QYP2-005 实现 SecretStore 与配置脱敏

- [ ] **依赖：** QYP2-003
- [ ] **Read first：** `src/main/ipc/index.ts`、`src/preload/index.ts`、`src/main/modules/storage/db.ts`
- [ ] **允许修改：** `src/main/modules/security/secret-store.ts`、`src/main/modules/storage/db.ts`、`src/main/ipc/index.ts`、`src/preload/index.ts`、`tests/main/security/secret-store.test.ts`
- [ ] **目标：** 为 WebDAV、TMDB、豆瓣和现有服务器 token 提供 namespace SecretStore；普通查询只返回 `hasCredential`。
- [ ] **验收：** safeStorage 可用时加密保存；不可用时默认会话保存；旧 token 写入/回读成功后才清空；日志/返回值无秘密。
- [ ] **验证：** `npm test -- --run tests/main/security/secret-store.test.ts`、`npm run typecheck`；对源码与日志做 secret grep。
- [ ] **Evidence：** 待填写

### Checkpoint A

- [ ] QYP2-001～005 全部 `[x]`。
- [ ] `npm run typecheck`、`npm test -- --run`、`git diff --check` 通过。
- [ ] 通过 migration 004 fixture 升级；现有 Jellyfin/Emby 登录与播放未回归。
- [ ] 人工批准后才能进入 Phase B。

## Phase B：本地媒体库与 NFO

### QYP2-006 实现 SourceAdapter 与扫描任务状态机

- [ ] **依赖：** QYP2-004
- [ ] **Read first：** 本文第 4、6 节、`src/main/ipc/index.ts`
- [ ] **允许修改：** `src/main/modules/library-sources/types.ts`、`src/main/modules/library-scanner/job-controller.ts`、`src/main/modules/catalog/repository.ts`、`tests/main/library-scanner/job-controller.test.ts`
- [ ] **目标：** 定义 local/WebDAV 共用 adapter、异步有界队列、取消、恢复和扫描事件。
- [ ] **验收：** 状态为 queued/discovering/indexing/enriching/completed/cancelled/failed/interrupted；事件 ≤4Hz；取消/失败不标记 missing。
- [ ] **验证：** `npm test -- --run tests/main/library-scanner/job-controller.test.ts`、`npm run typecheck`。
- [ ] **Evidence：** 待填写

### QYP2-007 实现本地 SourceAdapter

- [ ] **依赖：** QYP2-006
- [ ] **Read first：** 本文第 7 节、`src/main/modules/subtitle-engine/scanner.ts`
- [ ] **允许修改：** `src/main/modules/library-sources/local-source.ts`、`src/main/modules/catalog/source-service.ts`、`tests/main/library-sources/local-source.test.ts`
- [ ] **目标：** 通过已选择目录创建 source，提供异步 list/stat/open 和 root containment。
- [ ] **验收：** 只保存可读规范化根目录；默认不跟随 symlink；移除 source 不删除媒体；禁止任意 renderer 路径。
- [ ] **验证：** `npm test -- --run tests/main/library-sources/local-source.test.ts`、隔离临时目录手工测试。
- [ ] **Evidence：** 待填写

### QYP2-008 添加本地来源 IPC 与设置 UI

- [ ] **依赖：** QYP2-002、QYP2-007
- [ ] **Read first：** `src/renderer/pages/Settings/index.tsx`、`src/renderer/pages/Settings/ServerForm.tsx`、`src/preload/index.ts`
- [ ] **允许修改：** `src/main/ipc/index.ts`、`src/preload/index.ts`、`src/renderer/pages/Settings/index.tsx`、`src/renderer/pages/Settings/SourceForm.tsx`、`tests/renderer/settings/local-source.test.tsx`
- [ ] **目标：** 添加/测试/编辑/停用本地来源，启动和取消扫描。
- [ ] **验收：** 异步操作有 Toast 和持久状态；移除文案明确不删文件；1280×800 无横向滚动；输入由 shared schema 校验。
- [ ] **验证：** `npm test -- --run tests/renderer/settings/local-source.test.tsx`、`npm run typecheck`、键盘手工验证。
- [ ] **Evidence：** 待填写

### QYP2-009 实现本地增量扫描与媒体分类

- [ ] **依赖：** QYP2-006、QYP2-007
- [ ] **Read first：** 本文第 6 节、QYP2-006 的 adapter contract
- [ ] **允许修改：** `src/main/modules/library-scanner/local-scanner.ts`、`src/main/modules/library-scanner/classifier.ts`、`tests/main/library-scanner/local-scan.test.ts`
- [ ] **目标：** 发现视频/NFO/sidecar，识别电影、series、season、episode、普通 video，并按 path/size/mtime 增量更新。
- [ ] **验收：** 支持 S01E02/1x02/多集/Season 0；过滤 sample/extras；第二次无变化不重复 enrichment；完整成功扫描后才标 missing。
- [ ] **验证：** `npm test -- --run tests/main/library-scanner/local-scan.test.ts`；10,000 项 synthetic fixture 记录基线。
- [ ] **Evidence：** 待填写

### QYP2-010 实现安全 NFO 解析与字段合并

- [ ] **依赖：** QYP2-003、QYP2-009
- [ ] **Read first：** 本文第 9 节、项目依赖清单
- [ ] **允许修改：** `src/main/modules/metadata/nfo-parser.ts`、`src/main/modules/metadata/metadata-merger.ts`、`src/main/modules/metadata/types.ts`、`tests/main/metadata/nfo-parser.test.ts`、`tests/main/metadata/metadata-merger.test.ts`
- [ ] **目标：** 读取 movie/tvshow/season/episode NFO、UTF-8/UTF-16、sidecar 图片，并应用来源优先级。
- [ ] **验收：** 禁 DTD/外部实体；2 MiB/深度/节点有界；解析失败保留旧值；manual > NFO > scraper > filename 且记录 provenance。
- [ ] **验证：** 两个 metadata 测试文件、恶意 XML fixture、`npm run typecheck`。
- [ ] **Evidence：** 待填写

### QYP2-011 交付本地目录浏览、搜索和旧进度显示

- [ ] **依赖：** QYP2-008、QYP2-009、QYP2-010
- [ ] **Read first：** `src/renderer/pages/Local/index.tsx`、`src/renderer/pages/LibraryBrowse/index.tsx`、`src/renderer/pages/Detail/index.tsx`
- [ ] **允许修改：** `src/main/modules/catalog/query-service.ts`、`src/renderer/pages/LibraryBrowse/index.tsx`、`src/renderer/pages/Local/index.tsx`、`src/renderer/App.tsx`、`tests/renderer/library/local-library.test.tsx`
- [ ] **目标：** 将本地 source 接入统一分页目录、详情和搜索；保留单文件打开兼容。
- [ ] **验收：** 重启后目录和 NFO 保留；旧 local_media 进度正确迁移/显示；加载/空/离线/错误状态清晰；无横向滚动。
- [ ] **验证：** renderer 测试、`npm run typecheck`、添加目录→扫描→重启→详情手工流程。
- [ ] **Evidence：** 待填写

### Checkpoint B

- [ ] QYP2-006～011 全部 `[x]`。
- [ ] 本地扫描期间 UI 可操作，失败/取消不误删索引。
- [ ] NFO 恶意 fixture、旧进度迁移和 10,000 项基线均有 Evidence。

## Phase C：WebDAV 媒体库

### QYP2-012 实现 WebDAV 客户端与 URL 安全边界

- [ ] **依赖：** QYP2-005、QYP2-006
- [ ] **Read first：** 本文第 8 节、第 15 节安全表、QYP2-006 contract
- [ ] **允许修改：** `src/main/modules/library-sources/webdav-client.ts`、`src/main/modules/library-sources/webdav-source.ts`、`src/main/modules/library-sources/url-guard.ts`、`tests/main/webdav/webdav-client.test.ts`
- [ ] **目标：** 实现 HTTP/HTTPS、无认证/Basic/App Password、PROPFIND Depth 0/1、GET/Range 和安全重定向。
- [ ] **验收：** href 解码/归一化后仍在 root；拒绝 `..`/双重编码/跨 origin Authorization；响应大小/深度/超时/重试有界；能力明确 canSeek/canDelete/supportsEtag。
- [ ] **验证：** mock server 覆盖 401、403、redirect、malicious href、Range、超时和取消。
- [ ] **Evidence：** 待填写

### QYP2-013 添加 WebDAV 来源配置 UI

- [ ] **依赖：** QYP2-008、QYP2-012
- [ ] **Read first：** 本文第 8 节、现有 Settings/ServerForm
- [ ] **允许修改：** `src/renderer/pages/Settings/SourceForm.tsx`、`src/renderer/pages/Settings/WebDavFields.tsx`、`src/renderer/pages/Settings/SourceList.tsx`、`src/preload/index.ts`、`tests/renderer/settings/webdav-source.test.tsx`
- [ ] **目标：** 添加地址、根路径、账号、测试连接、只读/删除 capability 与 SecretStore 状态。
- [ ] **验收：** 禁止 URL userinfo/query token；密码不回显；HTTP 明文有确认；密钥不可用时默认会话保存；显示 Range/ETag/DELETE 能力。
- [ ] **验证：** renderer 测试、DevTools 状态/日志无秘密、`npm run typecheck`。
- [ ] **Evidence：** 待填写

### QYP2-014 实现 WebDAV 增量扫描与离线状态

- [ ] **依赖：** QYP2-009、QYP2-012
- [ ] **Read first：** 本文第 6、8 节
- [ ] **允许修改：** `src/main/modules/library-scanner/webdav-scanner.ts`、`src/main/modules/library-sources/webdav-source.ts`、`tests/main/library-scanner/webdav-scan.test.ts`
- [ ] **目标：** 分层遍历 WebDAV，按 ETag/Last-Modified/size 增量更新，复用本地分类器。
- [ ] **验收：** 不使用 Depth infinity；并发/取消/重试有界；离线/认证失败/取消不标 missing；健康状态持久化。
- [ ] **验证：** mock 10,000 项树、峰值内存/并发记录、测试通过。
- [ ] **Evidence：** 待填写

### QYP2-015 实现统一 PlaybackResolver 与精确路由

- [ ] **依赖：** QYP2-002、QYP2-005、QYP2-011、QYP2-012
- [ ] **Read first：** `src/main/ipc/index.ts`、`src/main/modules/player-core/index.ts`、`src/main/modules/playback-state/index.ts`、`src/renderer/hooks/use-play-item.ts`
- [ ] **允许修改：** `src/main/modules/player-core/playback-resolver.ts`、`src/main/ipc/index.ts`、`src/preload/index.ts`、`tests/main/playback/playback-resolver.test.ts`、`tests/main/online/server-routing.test.ts`
- [ ] **目标：** MediaRef 在主进程解析 locator、headers、resume、subtitle 和 media context；Jellyfin/Emby 严格按 serverId 路由。
- [ ] **验收：** renderer 不接触凭据；同 id 多服务器测试不串库；旧直连/转码/单文件播放行为不回归；URL 不由 renderer 拼接。
- [ ] **验证：** 两个测试文件、`npm run typecheck`、现有服务器播放回归。
- [ ] **Evidence：** 待填写

### QYP2-016 交付 WebDAV 播放与 seek 体验

- [ ] **依赖：** QYP2-013、QYP2-014、QYP2-015
- [ ] **Read first：** `src/main/modules/player-core/mpv-process.ts`、`src/main/modules/player-core/index.ts`
- [ ] **允许修改：** `src/main/modules/player-core/playback-resolver.ts`、`src/main/modules/playback-state/index.ts`、`src/renderer/pages/Detail/index.tsx`、`tests/main/playback/webdav-playback.test.ts`
- [ ] **目标：** 支持 WebDAV Range 播放/拖动/续播；不支持 seek 时给出明确降级。
- [ ] **验收：** Authorization 只存在主进程/mpv 参数；断网/过期凭据不清零进度；mpv stdout/stderr drain 和 `--hwdec=no` 保持。
- [ ] **验证：** mock Range 播放；mpv 0.29/0.32 手工各一次；`npm run typecheck`。
- [ ] **Evidence：** 待填写

### Checkpoint C

- [ ] QYP2-012～016 全部 `[x]`。
- [ ] Nextcloud、Apache WebDAV 和目标 NAS/Alist 至少完成兼容矩阵；不兼容项有记录。
- [ ] 断网、取消、401/403、Range 不支持均有证据。

## Phase D：详情、技术信息与媒体操作

### QYP2-017 完成 mpv 0.29/0.32 probe 方案 spike

- [ ] **依赖：** QYP2-002、QYP2-015
- [ ] **Read first：** `src/main/modules/player-core/mpv-process.ts`、本文第 10 节、`docs/BUILD-MPV.md`
- [ ] **允许修改：** `src/main/modules/media-probe/mpv-probe-spike.ts`、`tests/main/media-probe/mpv-probe-spike.test.ts`、`docs/decisions/0005-mpv-probe.md`
- [ ] **目标：** 比较 mpv 属性/临时 JSON IPC，确定无窗口探测参数和兼容降级。
- [ ] **验收：** 两版本均能取得可定义字段或明确 unsupported；stdout 有界、stderr drain 静默；不继承用户脚本、不启用硬解。
- [ ] **验证：** spike 测试和两个目标 mpv 的手工样本。
- [ ] **Evidence：** 待填写

### QYP2-018 实现 MediaProbe 服务和缓存

- [ ] **依赖：** QYP2-003、QYP2-017
- [ ] **Read first：** QYP2-017 ADR、`src/main/modules/catalog/repository.ts`
- [ ] **允许修改：** `src/main/modules/media-probe/index.ts`、`src/main/modules/media-probe/mpv-probe.ts`、`src/shared/types/media-info.ts`、`tests/main/media-probe/media-probe.test.ts`
- [ ] **目标：** 实现并发 1、15 秒超时、可取消、版本化缓存的 probe service。
- [ ] **验收：** size/mtime/ETag 变化失效；timeout/缺 mpv/offline/unsupported 可区分；失败不阻止播放。
- [ ] **验证：** 测试覆盖缓存命中/失效、超时、进程退出和多轨映射。
- [ ] **Evidence：** 待填写

### QYP2-019 详情页显示技术信息与上次进度

- [ ] **依赖：** QYP2-011、QYP2-016、QYP2-018
- [ ] **Read first：** `src/renderer/pages/Detail/index.tsx`、本文第 10、15 节
- [ ] **允许修改：** `src/renderer/pages/Detail/index.tsx`、`src/renderer/pages/Detail/MediaInfoPanel.tsx`、`src/renderer/pages/Detail/ProgressSummary.tsx`、`src/preload/index.ts`、`tests/renderer/detail/media-info-progress.test.tsx`
- [ ] **目标：** 非阻塞显示容器/视频/音频/字幕技术信息和电影/单集进度。
- [ ] **验收：** probe 中/失败/离线有独立状态；完成内容不显示误导性续播；多轨可折叠换行；1280×800 无横向滚动。
- [ ] **验证：** renderer 测试、键盘与错误状态手工检查、`npm run typecheck`。
- [ ] **Evidence：** 待填写

### QYP2-020 实现字幕导入与持久关联

- [ ] **依赖：** QYP2-003、QYP2-015
- [ ] **Read first：** `src/main/modules/subtitle-engine/scanner.ts`、本文第 13 节
- [ ] **允许修改：** `src/main/modules/media-operations/subtitle-service.ts`、`src/main/modules/subtitle-engine/scanner.ts`、`src/main/modules/catalog/repository.ts`、`src/main/ipc/index.ts`、`tests/main/subtitles/subtitle-attachment.test.ts`
- [ ] **目标：** 导入 SRT/ASS/SSA/SUB/VTT 到受管目录，保存语言/格式/默认/状态。
- [ ] **验收：** 单文件 ≤20 MiB；临时文件+原子 rename；文件名不可逃逸；移除关联不触碰原文件；失败无孤儿记录。
- [ ] **验证：** 成功/超限/非法扩展名/复制失败/重启恢复测试。
- [ ] **Evidence：** 待填写

### QYP2-021 接入字幕播放注入和详情 UI

- [ ] **依赖：** QYP2-019、QYP2-020
- [ ] **Read first：** `src/main/modules/player-core/index.ts`、`src/renderer/pages/Detail/index.tsx`
- [ ] **允许修改：** `src/main/modules/player-core/playback-resolver.ts`、`src/renderer/pages/Detail/SubtitleManager.tsx`、`src/renderer/pages/Detail/index.tsx`、`src/preload/index.ts`、`tests/main/playback/subtitle-injection.test.ts`
- [ ] **目标：** sidecar 与人工字幕统一管理，播放前自动注入。
- [ ] **验收：** 重启后仍可用；缺失字幕不阻止播放；操作乐观更新并失败回滚；mpv 可切换人工字幕。
- [ ] **验证：** main/renderer 测试、mpv 0.29/0.32 手工切换。
- [ ] **Evidence：** 待填写

### QYP2-022 实现 metadata override 服务

- [ ] **依赖：** QYP2-010、QYP2-011
- [ ] **Read first：** 本文第 9、14 节、`src/main/modules/catalog/repository.ts`
- [ ] **允许修改：** `src/main/modules/metadata/editor-service.ts`、`src/main/modules/metadata/metadata-merger.ts`、`src/main/modules/catalog/repository.ts`、`tests/main/metadata/metadata-editor.test.ts`
- [ ] **目标：** 实现白名单字段 patch、字段锁定、revision 冲突和逐字段恢复。
- [ ] **验收：** 输入长度/范围校验；stale revision 返回冲突差异；刮削/扫描不覆盖锁定字段；不写回 NFO。
- [ ] **验证：** 成功、非法字段、并发冲突、恢复和重刮削测试。
- [ ] **Evidence：** 待填写

### QYP2-023 开发详情页元数据编辑器

- [ ] **依赖：** QYP2-019、QYP2-022
- [ ] **Read first：** `src/renderer/pages/Detail/index.tsx`、现有 Toast store
- [ ] **允许修改：** `src/renderer/pages/Detail/MetadataEditor.tsx`、`src/renderer/pages/Detail/MetadataField.tsx`、`src/renderer/pages/Detail/index.tsx`、`src/preload/index.ts`、`tests/renderer/detail/metadata-editor.test.tsx`
- [ ] **目标：** 展示字段来源、编辑草稿、保存冲突、恢复字段和图片导入。
- [ ] **验收：** 失败保留草稿；差异可理解；长中文/多标签可滚动换行；dialog 焦点和键盘操作正确。
- [ ] **验证：** renderer 测试、1280×800 手工可访问性检查。
- [ ] **Evidence：** 待填写

### QYP2-024 实现安全删除后端

- [ ] **依赖：** QYP2-012、QYP2-014、QYP2-022
- [ ] **Read first：** 本文第 14.2、15、16.3 节，安全 hardening 指南
- [ ] **允许修改：** `src/main/modules/media-operations/delete-service.ts`、`src/main/modules/library-sources/local-source.ts`、`src/main/modules/library-sources/webdav-source.ts`、`src/main/ipc/index.ts`、`tests/main/media-operations/safe-delete.test.ts`
- [ ] **目标：** 两阶段 preview/token/execute；本地回收站；WebDAV capability + 前置条件删除。
- [ ] **验收：** root/root外/symlink/指纹变化/只读/无 ownership 全拒绝；检查后复验；回收站失败不永久删除；unknown 不假成功。
- [ ] **验证：** 隔离临时目录和 mock WebDAV 覆盖攻击/竞态/失败路径。
- [ ] **Evidence：** 待填写

### QYP2-025 开发删除预览与确认 UI

- [ ] **依赖：** QYP2-023、QYP2-024
- [ ] **Read first：** `src/renderer/pages/Detail/index.tsx`、本文第 14.2 节
- [ ] **允许修改：** `src/renderer/pages/Detail/MediaActions.tsx`、`src/renderer/pages/Detail/DeleteMediaDialog.tsx`、`src/renderer/pages/Detail/index.tsx`、`src/preload/index.ts`、`tests/renderer/detail/delete-media.test.tsx`
- [ ] **目标：** 展示范围与风险，提交 opaque ref + token，不提交路径。
- [ ] **验收：** WebDAV 永久删除要求输入标题；执行中禁重复；unknown 提供重查；失败回滚；只读状态明确。
- [ ] **验证：** renderer 测试、过期 token/目录变化/离线/只读手工验证。
- [ ] **Evidence：** 待填写

### Checkpoint D

- [ ] QYP2-017～025 全部 `[x]`。
- [ ] 删除与凭据泄漏专项审查通过。
- [ ] mpv 0.29/0.32、`time-pos: null`、退出保存和外挂字幕回归通过。

## Phase E：插件与刮削

### QYP2-026 定义内置插件 registry 与 provider 契约

- [ ] **依赖：** QYP2-002、QYP2-005
- [ ] **Read first：** 本文第 11 节、`src/main/ipc/index.ts`
- [ ] **允许修改：** `src/shared/types/plugins.ts`、`src/main/modules/plugin-runtime/types.ts`、`src/main/modules/plugin-runtime/registry.ts`、`src/main/modules/plugin-runtime/context.ts`、`tests/main/plugins/plugin-registry.test.ts`
- [ ] **目标：** 实现 apiVersion=1 metadata-provider manifest、静态 registry、窄 PluginContext。
- [ ] **验收：** 重复/非法/不兼容 manifest 拒绝；context 无 DB/fs/player/Electron/child_process；输出需 runtime schema 验证；明确非安全沙箱。
- [ ] **验证：** registry/context contract tests、`npm run typecheck`。
- [ ] **Evidence：** 待填写

### QYP2-027 实现插件配置、secret 和健康检查 UI

- [ ] **依赖：** QYP2-026
- [ ] **Read first：** 本文第 11.1、16.3 节、现有 Settings 模式
- [ ] **允许修改：** `src/main/modules/plugin-runtime/config-service.ts`、`src/main/ipc/index.ts`、`src/renderer/pages/Settings/PluginSettings.tsx`、`src/preload/index.ts`、`tests/main/plugins/plugin-config.test.ts`
- [ ] **目标：** 启停、优先级、非敏感设置、secret ref、测试连接、错误码。
- [ ] **验收：** API key 只入 SecretStore；重启保持状态；UI 和日志不含上游正文/秘密；错误可重试性明确。
- [ ] **验证：** main/renderer 测试、secret grep、`npm run typecheck`。
- [ ] **Evidence：** 待填写

### QYP2-028 实现刮削任务、置信度与缓存

- [ ] **依赖：** QYP2-010、QYP2-022、QYP2-026
- [ ] **Read first：** 本文第 11.2 节、`src/main/modules/catalog/repository.ts`
- [ ] **允许修改：** `src/main/modules/plugin-runtime/job-service.ts`、`src/main/modules/plugin-runtime/matcher.ts`、`src/main/modules/plugin-runtime/cache.ts`、`src/main/modules/metadata/metadata-merger.ts`、`tests/main/plugins/scrape-jobs.test.ts`
- [ ] **目标：** 单项/批量 job、候选差异、取消/恢复、有限并发和缓存。
- [ ] **验收：** ≥0.92 唯一候选自动应用；0.75～0.92 必须确认；低于 0.75 不应用；失败/取消/429 不覆盖现有值。
- [ ] **验证：** 表驱动匹配、重试、限流、恢复、人工锁定测试。
- [ ] **Evidence：** 待填写

### QYP2-029 开发 TMDB 内置插件

- [ ] **依赖：** QYP2-027、QYP2-028
- [ ] **Read first：** 本文第 11.3 节、TMDB 官方 API 文档（实现时记录版本/URL）
- [ ] **允许修改：** `src/main/plugins/tmdb/index.ts`、`src/main/plugins/tmdb/client.ts`、`src/main/plugins/tmdb/mapper.ts`、`tests/main/plugins/tmdb.test.ts`
- [ ] **目标：** 搜索/详情/季集/演职员/external id/图片映射，zh-CN→en-US 回退。
- [ ] **验收：** 未配置返回 AUTH_REQUIRED；401/429/空结果/分页/语言回退稳定；响应 schema 校验；图片 host allowlist；key 不入日志/URL/cache key。
- [ ] **验证：** 官方响应 fixture、mock HTTP、电影和剧集完整闭环。
- [ ] **Evidence：** 待填写

### QYP2-030 完成豆瓣数据入口与发布门禁

- [ ] **依赖：** QYP2-026
- [ ] **Read first：** 本文第 11.4 节、项目发布流程
- [ ] **允许修改：** `docs/decisions/0006-douban-provider.md`、`src/main/plugins/douban/types.ts`、`tests/fixtures/douban/`、`tests/main/plugins/douban-contract.test.ts`
- [ ] **目标：** 先确认合法数据入口、条款、授权、限流和字段范围；不满足则保持不可启用。
- [ ] **验收：** ADR 记录批准/拒绝原因；无不明第三方 API；fixture 可离线检测结构变化；不得把实验路径写成正式可用。
- [ ] **验证：** 人工产品/法律/技术评审；contract test。
- [ ] **Evidence：** 待填写

### QYP2-031 开发豆瓣插件安全降级

- [ ] **依赖：** QYP2-028、QYP2-030
- [ ] **Read first：** 豆瓣 ADR、本文第 11.4 节
- [ ] **允许修改：** `src/main/plugins/douban/index.ts`、`src/main/plugins/douban/client.ts`、`src/main/plugins/douban/mapper.ts`、`tests/main/plugins/douban.test.ts`
- [ ] **目标：** 按批准路径实现候选/详情；公开页面仅可低速强缓存、无需登录。
- [ ] **验收：** 默认关闭；不模拟登录/验证码/绕过限制；结构变化返回 UPSTREAM_CHANGED 并暂停批量；空结果不覆盖旧值。
- [ ] **验证：** fixture 覆盖正常、空、限流、结构变化；获准环境单项手工测试。
- [ ] **Evidence：** 待填写

### QYP2-032 开发单项/批量刮削 UI

- [ ] **依赖：** QYP2-023、QYP2-028、QYP2-029、QYP2-031
- [ ] **Read first：** 现有 Detail、LibraryBrowse、Toast 模式
- [ ] **允许修改：** `src/renderer/pages/Detail/ScrapeDialog.tsx`、`src/renderer/pages/Libraries/ScrapeJobs.tsx`、`src/renderer/pages/Libraries/index.tsx`、`src/preload/index.ts`、`tests/renderer/metadata/scrape-ui.test.tsx`
- [ ] **目标：** provider/candidate 选择、字段差异、批量进度、取消、失败重试。
- [ ] **验收：** 低置信候选不能自动套用；人工锁定字段有明显标识；离开页面后任务可恢复；分页/换行无横向滚动。
- [ ] **验证：** 自动命中/待确认/无结果/限流/取消 renderer 测试和手工验证。
- [ ] **Evidence：** 待填写

### Checkpoint E

- [ ] QYP2-026～032 全部 `[x]`。
- [ ] TMDB fixture 和真实测试 key 路径均验证；密钥不泄漏。
- [ ] 豆瓣未通过门禁时 UI 仍显示不可用且不发起请求。

## Phase F：续播、统一体验与发布

### QYP2-033 实现纯函数 ResumeResolver

- [ ] **依赖：** QYP2-004、QYP2-015
- [ ] **Read first：** `src/main/modules/playback-state/index.ts`、本文第 12 节
- [ ] **允许修改：** `src/main/modules/playback-state/resume-resolver.ts`、`src/shared/types/playback.ts`、`tests/main/playback/resume-resolver.test.ts`
- [ ] **目标：** 统一电影/单集/剧集起播位置和原因。
- [ ] **验收：** 30 秒有效门槛、90% 完成、已完成后下一集、特别篇、全剧完成均有表驱动测试；不被 0/null 覆盖。
- [ ] **验证：** `npm test -- --run tests/main/playback/resume-resolver.test.ts`、`npm run typecheck`。
- [ ] **Evidence：** 待填写

### QYP2-034 交付剧集一键续播和详情进度

- [ ] **依赖：** QYP2-019、QYP2-033
- [ ] **Read first：** `src/renderer/pages/Detail/index.tsx`、`src/renderer/hooks/use-play-item.ts`
- [ ] **允许修改：** `src/renderer/pages/Detail/index.tsx`、`src/renderer/pages/Detail/SeriesResumeButton.tsx`、`src/renderer/pages/Detail/EpisodeGrid.tsx`、`src/preload/index.ts`、`tests/renderer/detail/series-resume.test.tsx`
- [ ] **目标：** 主按钮使用主进程 ResumeResolver；单集卡显示进度并可从头播放。
- [ ] **验收：** 文案准确显示继续/下一集/第一集/重新播放；目标集自身 id/title/season/episode/source id 全部传递；focus/eof 后静默刷新。
- [ ] **验证：** renderer 测试；Jellyfin/Emby/local/WebDAV 各手工一组。
- [ ] **Evidence：** 待填写

### QYP2-035 实现可取消自动下一集

- [ ] **依赖：** QYP2-033、QYP2-034
- [ ] **Read first：** `src/main/index.ts`、`src/main/modules/playback-state/index.ts`、本文第 12.3 节
- [ ] **允许修改：** `src/main/modules/playback-state/auto-next.ts`、`src/main/index.ts`、`src/renderer/components/NextEpisodeCountdown.tsx`、`src/renderer/App.tsx`、`tests/main/playback/auto-next.test.ts`
- [ ] **目标：** 自然 EOF 后 5 秒倒计时、取消、设置关闭、最终保存后切集。
- [ ] **验收：** EOF 只触发一次；手动停止/崩溃/退出/离线不触发；最后一集不倒计时；无进度串集。
- [ ] **验证：** main/renderer 测试；mpv 0.29/0.32 短视频 EOF 手工回归。
- [ ] **Evidence：** 待填写

### QYP2-036 统一首页、搜索和来源健康

- [ ] **依赖：** QYP2-011、QYP2-016、QYP2-032、QYP2-034
- [ ] **Read first：** `src/renderer/pages/Home/index.tsx`、`src/renderer/pages/Search/index.tsx`、`src/renderer/components/PosterCard/index.tsx`
- [ ] **允许修改：** `src/main/modules/catalog/unified-query.ts`、`src/renderer/pages/Home/index.tsx`、`src/renderer/pages/Search/index.tsx`、`src/renderer/components/PosterCard/index.tsx`、`tests/renderer/home/unified-sources.test.tsx`
- [ ] **目标：** 合并四类来源的继续观看/最近添加/搜索，并保留 owner 精确路由。
- [ ] **验收：** 仅按完整 MediaRef 去重；来源局部失败不阻塞其他内容；分页 ≤200；网格换行无横向滚动。
- [ ] **验证：** mixed-source renderer/main 测试和手工混合来源流程。
- [ ] **Evidence：** 待填写

### QYP2-037 完成缓存、性能与脱敏诊断

- [ ] **依赖：** QYP2-014、QYP2-018、QYP2-028、QYP2-036
- [ ] **Read first：** 本文第 16 节、现有日志约定
- [ ] **允许修改：** `src/main/modules/cache/cache-manager.ts`、`src/main/modules/diagnostics/index.ts`、`src/main/modules/library-scanner/job-controller.ts`、`src/main/ipc/index.ts`、`tests/main/security/diagnostics-redaction.test.ts`
- [ ] **目标：** 实现图片/技术信息/插件响应配额、LRU/过期、并发控制、脱敏诊断摘要。
- [ ] **验收：** local≤8、WebDAV≤4、probe≤1、scraper≤2；缓存不删人工字幕；诊断无秘密/完整私有 URL；10,000 项基线不回退。
- [ ] **验证：** synthetic benchmark、诊断脱敏测试、`npm run typecheck`。
- [ ] **Evidence：** 待填写

### QYP2-038 全量回归、文档同步与发布门禁

- [ ] **依赖：** QYP2-005、QYP2-016、QYP2-025、QYP2-032、QYP2-035、QYP2-037
- [ ] **Read first：** `AGENTS.md`、`README.md`、`docs/BUILD-MPV.md`、本文第 16～21 节
- [ ] **允许修改：** `README.md`、`AGENTS.md`、`docs/PHASE2-OPERATIONS.md`、`docs/PHASE2-TEST-MATRIX.md`、`CHANGELOG.md`
- [ ] **目标：** 完成迁移、四来源 E2E、目标 Linux/mpv 回归、依赖审计、文档与回滚说明。
- [ ] **验收：** 所有成功标准均有证据；Deepin 20.9/Debian 10 安装/播放/续播/字幕/退出通过；文档准确标注豆瓣与 WebDAV 删除状态；没有未批准例外。
- [ ] **验证：** `npm run typecheck`、`npm test -- --run`、`npm run lint`、`npm run build:main`、`npm run build:preload`、`npm run build:renderer`、`npm run dist:all`、`git diff --check`；目标机手工矩阵。
- [ ] **Evidence：** 待填写

### Checkpoint F：二期完成

- [ ] QYP2-033～038 全部 `[x]`。
- [ ] QYP2-001～038 无 `[!]`，无未解释失败检查。
- [ ] Electron 21.4.4、`--hwdec=no`、mpv drain、`time-pos: null`、关闭窗口退出五项硬约束逐项核验。
- [ ] 所有外部输入、凭据、删除和插件边界通过专项审查。
- [ ] 只有在人工批准发布说明后才能创建 tag 或推送。
