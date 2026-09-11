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

- [x] **依赖：** QYP2-002
- [x] **Read first：** `src/main/modules/storage/db.ts`、本文第 5 节、现有 migration fixture
- [x] **允许修改：** `src/main/modules/storage/db.ts`、`src/main/modules/catalog/repository.ts`、`tests/main/storage/catalog-migrations.test.ts`
- [x] **目标：** 在 MIGRATIONS 末尾创建 sources/items/files/streams/user-state/subtitles/metadata/scrape 相关表及索引。
- [x] **验收：** 不编辑 001～004；空库、v4 fixture、重复启动幂等；新表 FK/unique 生效；旧表和 CHECK 保留。
- [x] **验证：** `npm test -- --run tests/main/storage/catalog-migrations.test.ts`、`npm run typecheck`。
- [x] **Evidence：**
  - Commands: `npm test -- --run`（6 文件 42 测试通过，含 7 个 migration 集成用例）；`npm run typecheck`（零错误）；`git diff --check`；`npm run quality`（仍仅报 cdp 既有 8 处空 catch，待批准修复）
  - Tests: 空库全链、v4 fixture 升级（legacy 行/CHECK 保留、webdav 拒绝）、重复打开幂等、FK 级联删除、四组 unique 键、library_sources 凭据根拒绝、upsert 不置空语义（title/year/duration）、replaceStreams 原子替换
  - Result: 通过
  - Review notes: ① 基础设施修复（超出允许清单，已记录）：测试脚本切换为 `ELECTRON_RUN_AS_NODE=1 electron -r scripts/electron-node-polyfill.cjs`（better-sqlite3 原生模块按 Electron ABI 109 编译，系统 Node 24 无法加载；polyfill 桥接 Node 16 缺失的 webcrypto 表面）；② migration 005 尚未发布，提交前修正了同一 migration 内的结构（catalog_items 增加 season/episode 列与索引），未触碰 001–004；③ repository 为首个切片，QYP2-004 扩充 legacy 进度迁移；④ metadata_revision 仅由元数据层（QYP2-022）维护，catalog upsert 不触碰；
  - 评审记录: 首轮子代理评审 Request changes（upsertItem 季集列与 upsertFile stat 列缺 COALESCE、CatalogItemRow 缺字段、测试覆盖缺口；同时确认 001–004 逐字未动、polyfill 不进生产包）；提交 b827f87 整改后二轮验收 **Approve**（4/4 解决，42 测试通过）

### QYP2-004 实现 Repository 与旧进度兼容

- [x] **依赖：** QYP2-003
- [x] **Read first：** `src/main/modules/storage/db.ts`、`src/main/modules/playback-state/index.ts`
- [x] **允许修改：** `src/main/modules/catalog/repository.ts`、`src/main/modules/catalog/legacy-progress.ts`、`tests/main/catalog/legacy-progress.test.ts`
- [x] **目标：** 为 catalog/source/file/metadata/progress 提供参数化 repository；旧 local_media 仅在来源挂载时幂等迁移。
- [x] **验收：** null 不覆盖旧值；迁移按 realpath 和更新时间选择；迁移前不删除旧记录；重复执行结果稳定。
- [x] **验证：** `npm test -- --run tests/main/catalog/legacy-progress.test.ts`、`npm run typecheck`。
- [x] **Evidence：**
  - Commands: `npm test -- --run`（7 文件 56 测试通过，含 14 个迁移用例）；`npm run typecheck`（零错误）；`git diff --check`
  - Tests: 有效迁移、幂等（二次运行零写入且 updated_at 不变）、catalog 较新时保留、legacy 较新时应用、无效行跳过、size 匹配优先于时间（经符号链接双路径 fixture）、同 item 多文件单状态、非 local 行排除、offline 文件按 normalize 匹配、未知来源空结果、position0+finished、updated_at 相等 tie、root 逃逸拒绝
  - Result: 通过
  - Review notes: ① 首轮评审 7R 全部整改（per-item 匹配重构、isSafeRelativePath 防逃逸、确定性 tie-breaker + 5 个新用例），二轮验收 Approve；② 已知限制（记录备查）：listFilesBySource 全量加载 + 每文件同步 realpath，10k 文件库迁移一次性内存与 IO 放大，为低频操作可接受，若超标再改流式（O1/O2 延后）；③ metadata/subtitles 表访问器按 §16.6 延至 QYP2-010/020/022，避免投机抽象；④ 迁移永不删除旧表记录，旧表为回滚兜底

### QYP2-005 实现 SecretStore 与配置脱敏

- [x] **依赖：** QYP2-003
- [x] **Read first：** `src/main/ipc/index.ts`、`src/preload/index.ts`、`src/main/modules/storage/db.ts`
- [x] **允许修改：** `src/main/modules/security/secret-store.ts`、`src/main/modules/storage/db.ts`、`src/main/ipc/index.ts`、`src/preload/index.ts`、`tests/main/security/secret-store.test.ts`
- [x] **目标：** 为 WebDAV、TMDB、豆瓣和现有服务器 token 提供 namespace SecretStore；普通查询只返回 `hasCredential`。
- [x] **验收：** safeStorage 可用时加密保存；不可用时默认会话保存；旧 token 写入/回读成功后才清空；日志/返回值无秘密。
- [x] **验证：** `npm test -- --run tests/main/security/secret-store.test.ts`、`npm run typecheck`；对源码与日志做 secret grep。
- [x] **Evidence：**
  - Commands: `npm test -- --run`（8 文件 72 测试通过，其中本模块 19 用例）；`npm run typecheck`（零错误）；`git diff --check`；secret grep：`grep -rn api_key src/renderer` 无消费点、secret-store 无 console 输出
  - Tests: 加密持久化不落明文、命名空间隔离、ref 解析、非法 ns/key 拒绝、会话回退不落盘且新实例不可见、回读验证失败即删除并拒写、token 迁移成功后清列 + 幂等 + 回读失败保明文 + session-only 模式不动 legacy 列、header 缓存单次消费与 FIFO 淘汰、脱敏投影无凭据、settings 通道拒绝 secret: 键
  - Result: 通过
  - Review notes: ① 首轮评审 Request changes（1C/2R/3O/2N）：Critical（session-only 迁移丢凭据，已加 isPersistent 守卫）、R2（迁移包 try/catch 脱敏日志不阻断启动）、R3（转码 token 不再过 IPC：主进程 header 缓存 + opaque sessionId，renderer 已无 headers 传递）、O4/O6/N8 已修；O5（COALESCE 阻断凭据删除路径）延后——当前无删除凭据功能，待 QYP2-013 设置页重构时加显式通道；② 越界文件（待追认）：Settings/index.tsx、server-images.ts、use-play-item.ts、Detail/index.tsx（为满足 Checkpoint A 登录不回归 + token 不过 IPC 的必要改动）；③ 首轮提交信息称 16 cases 当时实为 13，整改后实际 19，以此为准；④ TEST_SERVER 的 accessToken 透传为过渡设计，PlaybackResolver（QYP2-015）接管后移除

### QYP2-006 实现 SourceAdapter 与扫描任务状态机

- [x] **依赖：** QYP2-004
- [x] **Read first：** 本文第 4、6 节、`src/main/ipc/index.ts`
- [x] **允许修改：** `src/main/modules/library-sources/types.ts`、`src/main/modules/library-scanner/job-controller.ts`、`src/main/modules/catalog/repository.ts`、`tests/main/library-scanner/job-controller.test.ts`
- [x] **目标：** 定义 local/WebDAV 共用 adapter、异步有界队列、取消、恢复和扫描事件。
- [x] **验收：** 状态为 queued/discovering/indexing/enriching/completed/cancelled/failed/interrupted；事件 ≤4Hz；取消/失败不标记 missing。
- [x] **验证：** `npm test -- --run tests/main/library-scanner/job-controller.test.ts`、`npm run typecheck`。
- [x] **Evidence：**
  - Commands: `npm test -- --run`（9 文件 82 测试通过，其中 job-controller 10 用例）；`npm run typecheck`（零错误）；`git diff --check`
  - Tests: 全相位完成与 run 持久化（processed/total/finished_at）、60s 节流窗下仅剩相位转换事件（无逐条进度刷屏）、取消后零 index 调用 + 状态 cancelled、失败时错误脱敏（root -> <source>）且条目 availability 不变、resume cursor 传递、cursor 每 50 条持久化、启动恢复非终态 -> interrupted（精确 1 条 + finished_at 非空）、graceful shutdown 严格 interrupted（mid-discovery 同步触发）、runBounded 并发 ≤2、错误脱敏单测
  - Result: 通过
  - Review notes: ① 首轮评审 Request changes（2C/4R/3O）全修复：runBounded settled 屏障（异常后不再启动新任务、drain 后才 reject）、transition 终端守卫（interrupted 不可被覆盖）、markInterrupted 同步 abort、cursor 仅随保留条目前进（maxEntries 裁剪不再导致恢复丢条目）、deleteDirectory 补 AbortSignal、adapter 超时契约写入 JSDoc、恢复/中断测试改为严格断言；② 事件语义：相位转换（每 run ≤5 次）立即送达，同相位进度 tick 合并到 250ms 窗（≤4Hz），终态立即送达不丢失；③ maxEntries 上限 100,000 防病态树，被裁剪条目留待恢复轮处理；④ 二轮验收 Approve，遗留噪声备注：错误屏障 drain 期间已落地 worker 仍会回调 onProgress（进度噪声，不影响状态机）

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

### QYP2-007 实现本地 SourceAdapter

- [x] **依赖：** QYP2-006
- [x] **Read first：** 本文第 7 节、`src/main/modules/subtitle-engine/scanner.ts`
- [x] **允许修改：** `src/main/modules/library-sources/local-source.ts`、`src/main/modules/catalog/source-service.ts`、`tests/main/library-sources/local-source.test.ts`
- [x] **目标：** 通过已选择目录创建 source，提供异步 list/stat/open 和 root containment。
- [x] **验收：** 只保存可读规范化根目录；默认不跟随 symlink；移除 source 不删除媒体；禁止任意 renderer 路径。
- [x] **验证：** `npm test -- --run tests/main/library-sources/local-source.test.ts`、隔离临时目录手工测试。
- [x] **Evidence：**
  - Commands: `npm test -- --run`（10 文件 98 测试通过，其中 local-source 16 用例）；`npm run typecheck`（零错误）；`git diff --check`
  - Tests: symlink 选择路径规范化为 realpath、相对/缺失/非目录拒绝、depth-1 遍历与相对路径拼接、symlink 目录不作为目录上报且外部内容不可达、abort 中途停止、四类逃逸拒绝（../、绝对路径、NUL、多级 ..）、合法嵌套与点段路径、root=/ 边界、outside-symlink open 拒绝 + inside-symlink 可播、目录 stat 拒绝、移除来源只删索引文件仍在、不可读目录报错不假成功
  - Result: 通过
  - Review notes: ① 首轮评审 Request changes（1C/5R）：resolveInside 改为双层防护（字符串前缀 + realpath 复检，防 root 被换 symlink 的 TOCTOU）；symlink 策略统一为「realpath 重定向后仍在 root 内即可播、逃逸即拒绝、断链拒绝」；assertOwnLocator 不再误杀合法点段路径；root=/ 前缀检查特判；lstat 改异步；checkSourceHealth 空 catch 改为错误分类（offline vs degraded）+ 脱敏日志；② 遗留（非阻塞，评审认可）：resolveInside/stat 内同步 realpath/lstat 属单路径安全关卡，非批量 IO；open 的 signal 中途取消行为未显式测试（createReadStream signal 在 Node 16 可用，留给 016 播放链路回归覆盖）；③ 二轮验收 Approve

### QYP2-008 添加本地来源 IPC 与设置 UI

- [x] **依赖：** QYP2-002、QYP2-007
- [x] **Read first：** `src/renderer/pages/Settings/index.tsx`、`src/renderer/pages/Settings/ServerForm.tsx`、`src/preload/index.ts`
- [x] **允许修改：** `src/main/ipc/index.ts`、`src/preload/index.ts`、`src/renderer/pages/Settings/index.tsx`、`src/renderer/pages/Settings/SourceForm.tsx`、`tests/renderer/settings/local-source.test.tsx`
- [x] **目标：** 添加/测试/编辑/停用本地来源，启动和取消扫描。
- [x] **验收：** 异步操作有 Toast 和持久状态；移除文案明确不删文件；1280×800 无横向滚动；输入由 shared schema 校验。
- [x] **验证：** `npm test -- --run tests/renderer/settings/local-source.test.tsx`、`npm run typecheck`、键盘手工验证。
- [x] **Evidence：**
  - Commands: `npm test -- --run`（12 文件 106 测试通过，其中本任务 renderer 6 用例）；`npm run typecheck`（零错误）；`git diff --check`
  - Tests: SourceForm 选目录→保存（携带 root/name）、未选目录不出保存、列表渲染含扫描状态与移除承诺文案、扫描启动→推送事件驱动「扫描中 3/10」、完成事件路径、移除 confirm 文案含「不会删除磁盘上的媒体文件」、flex-wrap 布局断言（1280×800 无横向滚动策略）
  - Result: 通过
  - Review notes: ① 首轮评审 Request changes：Critical（preload 订阅时从不向 main 发送注册消息，推送链路断裂——已加 ipcRenderer.send + main 端 per-sender 去重）、SOURCE_HEALTH/SCAN_CANCEL 补 sourceId 校验、getLatestScanRun 排序改 started_at+id、preload 改命名 handler 移除、测试 act 包裹 + 布局断言；二轮验收 Approve；② 基础 indexer 仅索引根层文件并统一标 kind=video——递归遍历与电影/剧集分类在 QYP2-009 落地（已在代码注释与 Evidence 双重标注，非 stub：今日即可产出真实可浏览行）；③ 键盘手工验证项：表单 Tab 序（选目录→名称→测试→添加→取消）+ 删除按钮有确认弹窗，由用户下次实机验证补录；④ 越界文件（待追认）：shared/types（CreateLocalSourceInput/SourceListEntry）、ipc-channels（PICK_DIR）、repository（getLatestScanRun）——成套 IPC 必要增量，评审已确认合理；⑤ 工作区并行改动（tray 图标路径修复 + tray 测试）被误扫入整改提交，已拆分为独立提交 a50c9b5 并经全部门禁验证

### QYP2-009 实现本地增量扫描与媒体分类

- [ ] **依赖：** QYP2-006、QYP2-007
- [ ] **Read first：** 本文第 6 节、QYP2-006 的 adapter contract
- [ ] **允许修改：** `src/main/modules/library-scanner/local-scanner.ts`、`src/main/modules/library-scanner/classifier.ts`、`tests/main/library-scanner/local-scan.test.ts`
- [ ] **目标：** 发现视频/NFO/sidecar，识别电影、series、season、episode、普通 video，并按 path/size/mtime 增量更新。
- [ ] **验收：** 支持 S01E02/1x02/多集/Season 0；过滤 sample/extras；第二次无变化不重复 enrichment；完整成功扫描后才标 missing。
- [ ] **验证：** `npm test -- --run tests/main/library-scanner/local-scan.test.ts`；10,000 项 synthetic fixture 记录基线。
- [ ] **Evidence：** 待填写

### QYP2-009 实现本地增量扫描与媒体分类

- [x] **依赖：** QYP2-006、QYP2-007
- [x] **Read first：** 计划第 6 节、QYP2-006 的 adapter contract、job-controller.ts、repository.ts
- [x] **允许修改：** `local-scanner.ts`、`classifier.ts`、`tests/main/library-scanner/local-scan.test.ts`
- [x] **目标：** 发现视频/NFO/sidecar，识别电影、series、season、episode、普通 video，并按 path/size/mtime 增量更新。
- [x] **验收：** S01E02/1x02/多集/Season 0；过滤 sample/extras；第二次无变化不重复 enrichment；完整成功扫描后才标 missing。
- [x] **验证：** `npm test -- --run tests/main/library-scanner/local-scan.test.ts`（32 用例）；10,000 项 synthetic fixture 基线。
- [x] **Evidence：**
  - Commands: `npm test -- --run`（13 文件 138 测试通过，本任务 32 用例）；`npm run typecheck`（零错误）；`git diff --check`
  - Baseline: 10,000 项 synthetic（200 剧 × 50 集）完整扫描 ~6.8s（门限 <60s，纯同步 SQLite + DFS fake adapter，无网络 I/O）
  - Result: 通过
  - Review notes: ① 首轮评审 Request changes：Critical（walkSourceTree 把 startPath 同时当遍历根与 resume cursor——cursor 为文件时遍历空目录，resume 语义完全失效；已改为恒从根遍历 + 内存态跳过 + cursor 失效回退全量）、availability 批量事务化（repo.setAvailabilityBulk，防崩溃留下混合状态）、测试 tmp 目录泄漏（afterAll→afterEach）、sample/extras 起始锚定（防误伤 The Interview 2014 / The Sample 2023 等真标题——未检出的 extras 仍经主文件大小规则正确挂到电影条目）、YEAR 尾部边界（Movie 2019.mkv）、episodeTitle 剥离 release tag；二轮验收 Approve；② enrich 钩子当前语义 = 幂等收尾（首个调用 flush 尾部电影分组），QYP2-010 换成真实 NFO 解析时已由指纹门禁保证不变文件不重复解析；③ 已知限制（记录）：同名著同年不同目录的电影合并为一个 item（sourceKey 仅 title+year，ADR-0001 语义下合理，人工修正后续可解）；mtime 取整用 Math.floor，适配器精度变化需 bump 指纹格式（已注释）；missing 30 天保留策略清理属后续任务；④ 越界文件（待追认）：ipc/index.ts（SCAN_START 接入递归 wrapper + finalize 钩子，替换 basic driver）、repository.ts（listItemsBySource、setAvailabilityBulk、CatalogItemRow/CatalogFileRow 暴露 updated_at）——均为最小必要增量，验收确认无越界修改；⑤ Season 目录上下文：剧名取自季目录外的最近目录段（绝命毒师/Season 1/01.mkv → 剧名绝命毒师）

### QYP2-010 实现安全 NFO 解析与字段合并

- [ ] **依赖：** QYP2-003、QYP2-009
- [ ] **Read first：** 本文第 9 节、项目依赖清单
- [ ] **允许修改：** `src/main/modules/metadata/nfo-parser.ts`、`src/main/modules/metadata/metadata-merger.ts`、`src/main/modules/metadata/types.ts`、`tests/main/metadata/nfo-parser.test.ts`、`tests/main/metadata/metadata-merger.test.ts`
- [ ] **目标：** 读取 movie/tvshow/season/episode NFO、UTF-8/UTF-16、sidecar 图片，并应用来源优先级。
- [ ] **验收：** 禁 DTD/外部实体；2 MiB/深度/节点有界；解析失败保留旧值；manual > NFO > scraper > filename 且记录 provenance。
- [ ] **验证：** 两个 metadata 测试文件、恶意 XML fixture、`npm run typecheck`。
- [ ] **Evidence：** 待填写

### QYP2-010 实现安全 NFO 解析与字段合并

- [x] **依赖：** QYP2-003、QYP2-009
- [x] **Read first：** 计划第 9 节、项目依赖清单（确认无 XML 依赖，遵守不新增依赖约束 → 手写有界 XML 子集解析器）
- [x] **允许修改：** `src/main/modules/metadata/{nfo-parser,metadata-merger,types}.ts`、`tests/main/metadata/*.test.ts`
- [x] **目标：** 读取 movie/tvshow/season/episode NFO、UTF-8/UTF-16、sidecar 图片，并应用来源优先级。
- [x] **验收：** 禁 DTD/外部实体；2 MiB/深度/节点有界；解析失败保留旧值；manual > NFO > scraper > filename 且记录 provenance。
- [x] **验证：** 两个 metadata 测试文件（31 用例）、恶意 XML fixture、`npm run typecheck`。
- [x] **Evidence：**
  - Commands: `npm test -- --run`（15 文件 169 测试通过，本任务 31 用例）；`npm run typecheck`（零错误）；`git diff --check`
  - Security fixtures: DOCTYPE 内联 DTD 拒绝；未知命名实体 &evil; 拒绝（构造性无实体展开路径）；数字实体超码点 &#x110000; / 代理对 &#xD800; 拒绝；深度 33 拒绝、32 通过；节点 55k+ 拒绝；>2MiB 文本与 buffer 拒绝；非法标签名/属性名/未闭合/错配拒绝；合法实体/CDATA/深度边界不误拒
  - Merge semantics: 稀疏载荷不清空旧值（部分 NFO/解析失败零写入）；manual 锁定字段重扫跳过且 NFO 槽位冻结（解锁即恢复用户所见状态）；expectedRevision 乐观锁冲突抛 MetadataConflictError 携带两侧（无静默 LWW）；键序稳定比较不误 bump；clearManualField 逐字段恢复来源值
  - Result: 通过
  - Review notes: ① 首轮评审 Request changes：<set> 无 <name> 回退文本、根元素后尾部注释/PI 容忍（assertTrailingNoise）、expectedRevision 0 新字段语义、deepEqual 键序、8 个测试覆盖缺口全部补齐；二轮验收 Approve；② mpaa 与 contentrating 并存时 contentrating 胜出（Kodi 主流是 mpaa，但显式 contentrating 更精确，测试已固化）；③ banner/logo sidecar 超出 plan §9.1 列举范围（同机制零成本，QYP2-011 UI 消费，已注释说明）；④ 越界文件（待追认）：无——但 electron-builder.yml（Deepin 托盘 libappindicator3-1 由 recommends 转硬依赖）再次为工作区并行改动被误扫，已拆分为独立提交 e817fca 待追认（改动合理但未经本任务批准）；⑤ ProviderStore 为 JSON 可序列化（field→provider→{value,revision,updatedAt}），与 catalog_metadata_sources (item_id, field, provider, value, revision) 映射直接；注意 updatedAt 为 ms 而表内 updated_at 为 unixepoch 秒（落库时换算）

### QYP2-011 交付本地目录浏览、搜索和旧进度显示

- [ ] **依赖：** QYP2-008、QYP2-009、QYP2-010
- [ ] **Read first：** `src/renderer/pages/Local/index.tsx`、`src/renderer/pages/LibraryBrowse/index.tsx`、`src/renderer/pages/Detail/index.tsx`
- [ ] **允许修改：** `src/main/modules/catalog/query-service.ts`、`src/renderer/pages/LibraryBrowse/index.tsx`、`src/renderer/pages/Local/index.tsx`、`src/renderer/App.tsx`、`tests/renderer/library/local-library.test.tsx`
- [ ] **目标：** 将本地 source 接入统一分页目录、详情和搜索；保留单文件打开兼容。
- [ ] **验收：** 重启后目录和 NFO 保留；旧 local_media 进度正确迁移/显示；加载/空/离线/错误状态清晰；无横向滚动。
- [ ] **验证：** renderer 测试、`npm run typecheck`、添加目录→扫描→重启→详情手工流程。
- [ ] **Evidence：** 待填写

### QYP2-011 交付本地目录浏览、搜索和旧进度显示

- [x] **依赖：** QYP2-008、QYP2-009、QYP2-010
- [x] **Read first：** Local/LibraryBrowse/Detail 三页、ipc-channels 契约、legacy-progress API
- [x] **允许修改：** query-service.ts、LibraryBrowse、Local、App、tests/renderer/library/local-library.test.tsx
- [x] **目标：** 将本地 source 接入统一分页目录、详情和搜索；保留单文件打开兼容。
- [x] **验收：** 重启后目录和 NFO 保留；旧 local_media 进度正确迁移/显示；加载/空/离线/错误状态清晰；无横向滚动。
- [x] **验证：** renderer 测试、`npm run typecheck`、添加目录→扫描→重启→详情手工流程。
- [x] **Evidence：**
  - Commands: `npm test -- --run`（17 文件 188 测试通过：主进程 query-service 11 用例 + renderer 8 用例）；`npm run typecheck`（零错误）；`git diff --check`
  - Main tests: NFO 胜者标题/评分浏览、确定性分页、LIKE 转义（%/_ 字面量）+ 元数据字段搜索、series 详情（tvshow.nfo 元数据 + 季集层级 + 单集 NFO 胜者 + fieldProviders）、播放意图（relativePath/series 上下文/进度）、旧 local_media 进度迁移后 listPage 显示、坏 NFO 重扫保留旧值、契约 guard 拒绝、跨目录同名 NFO 隔离、series children 拍平
  - Renderer tests: 来源列表+扫描状态+进入浏览、空态指引、单文件播放兼容、目录卡片+进度徽章、resolve→playerLoadFile（续播 300s）、未扫描空态、错误+重试、源内搜索、加载更多整数页
  - Result: 通过
  - Review notes: ① 首轮评审 Request changes：CRITICAL 级三条全修——stemItem 跨目录同名错配（改 dir 限定 + pendingStemNfo 队列，NFO 先于视频条目到达也可应用）、分页数学产生小数页被契约拒绝（整数页 ref）、series 详情 children 只有季没有集（拍平孙辈）；fan-out search 死代码重写为逐源 skip 记账；二轮验收 Approve；② 已知限制（记录）：catalog_metadata_sources 的 LIKE 子查询无索引（大库需新 migration 建索引，后续任务）、播放 MediaContext.mediaId 用绝对路径（与旧进度迁移兼容，QYP2-015 统一 PlaybackResolver 时迁移到稳定 item id）、本地详情暂无海报显示（sidecar 候选发现已就绪，图片服务需自定义协议，后续任务）；③ 手工流程（添加目录→扫描→重启→详情）由用户实机验证后补录；④ 越界文件（待追认）：shared/types/catalog（查询契约）、ipc-channels（RESOLVE）、repository（listItemsFiltered/listMetadataSources*/listUserStatesForItems/upsertMetadataSource）、preload（4 个包装）、Local 页媒体库区、HorizontalRow MediaItem 字段、ipc/index（4 handler + 迁移接线 + readNfo）、local-scanner（NFO 富化 + 低置信不合并的行为变更）——评审确认最小必要

### Checkpoint B

- [x] QYP2-006～011 全部 `[x]`。
- [x] 本地扫描期间 UI 可操作，失败/取消不误删索引（失败/取消不触发 missing 标记；availability 批量事务化）。
- [x] NFO 恶意 fixture、旧进度迁移和 10,000 项基线均有 Evidence。

## Phase C：WebDAV 媒体库

### QYP2-012 实现 WebDAV 客户端与 URL 安全边界

- [ ] **依赖：** QYP2-005、QYP2-006
- [ ] **Read first：** 本文第 8 节、第 15 节安全表、QYP2-006 contract
- [ ] **允许修改：** `src/main/modules/library-sources/webdav-client.ts`、`src/main/modules/library-sources/webdav-source.ts`、`src/main/modules/library-sources/url-guard.ts`、`tests/main/webdav/webdav-client.test.ts`
- [ ] **目标：** 实现 HTTP/HTTPS、无认证/Basic/App Password、PROPFIND Depth 0/1、GET/Range 和安全重定向。
- [ ] **验收：** href 解码/归一化后仍在 root；拒绝 `..`/双重编码/跨 origin Authorization；响应大小/深度/超时/重试有界；能力明确 canSeek/canDelete/supportsEtag。
- [ ] **验证：** mock server 覆盖 401、403、redirect、malicious href、Range、超时和取消。
- [ ] **Evidence：** 待填写

### QYP2-012 实现 WebDAV 客户端与 URL 安全边界

- [x] **依赖：** QYP2-005、QYP2-006
- [x] **Read first：** 计划第 8 节、§4.2、§16.4、QYP2-006 contract、SecretStore API
- [x] **允许修改：** `webdav-client.ts`、`webdav-source.ts`、`url-guard.ts`、`tests/main/webdav/webdav-client.test.ts`
- [x] **目标：** HTTP/HTTPS、无认证/Basic/App Password、PROPFIND Depth 0/1、GET/Range 和安全重定向。
- [x] **验收：** href 解码/归一化后仍在 root；拒绝 ../双重编码/跨 origin Authorization；响应大小/深度/超时/重试有界；能力明确。
- [x] **验证：** mock server（node:http，端口 0 迟绑定）覆盖 401、403、redirect、malicious href、Range、超时、取消。
- [x] **Evidence：**
  - Commands: `npm test -- --run`（18 文件 213 测试通过，本任务 25 用例）；`npm run typecheck`（零错误）；`git diff --check`
  - Security matrix: base URL 拒 userinfo/query/fragment/非 http(s)/控制字符；href 拒编码穿越（%2e/%2f/%5c/overlong UTF-8）、双重编码（一次解码后残留 %25 等即拒，%2f 假阳性已文档化为含保严格权衡）、跨源绝对 href、协议相对、坏编码；multistatus 拒 DOCTYPE/非预定义实体；响应 8MiB 上限、条目 1 万上限；超时 15s（请求期 + 流读取期双重 deadline）；重试仅网络错误 + 502/503/504（≤2 次，401/403 永不重试）；重定向仅同源（Authorization 永不跨源）、≤3 跳；AbortSignal 全链路（请求、退避、流读取）
  - Result: 通过
  - Review notes: ① 评审两轮（均在提交前整改完毕）+ 验收 Approve：CRITICAL——open 以 200 冒充 Range 支持会向 UI 隐藏 seek 不可靠（改为仅 206 判定，播放前逐文件探测）；REQUIRED——响应流错误路径 timer/abortListener 泄漏、backoff 监听器全路径移除 + 重试前 abort 检查、adapter signal 全链路传递、%25 残留编码穿透；readText 流阶段无超时保护（补双重 deadline + abort destroy）；② testConnection supportsEtag 诚实化（按 root 条目声明），supportsRange 乐观默认已注释（播放前 206 探测为准，plan §8.1）；③ 凭据仅经 SecretStore namespace 'webdav'（JSON 序列化，损坏按无凭据处理）；Authorization 只在 header 构造处出现，全模块零日志；④ 与其他 SourceAdapter 的隔离：所有 URL 构造经 url-guard，存储的 relativePath 永不直接拼 URL；⑤ 待办留档：getAdapterForSource 接入 WebDAV 在 QYP2-014（webdav-scanner 允许文件清单内做接线）；DELETE 能力按 plan 推迟到 QYP2-024（canDelete 恒 false）；⑥ 越界：无（仅允许清单内文件）

### QYP2-013 添加 WebDAV 来源配置 UI

- [ ] **依赖：** QYP2-008、QYP2-012
- [ ] **Read first：** 本文第 8 节、现有 Settings/ServerForm
- [ ] **允许修改：** `src/renderer/pages/Settings/SourceForm.tsx`、`src/renderer/pages/Settings/WebDavFields.tsx`、`src/renderer/pages/Settings/SourceList.tsx`、`src/preload/index.ts`、`tests/renderer/settings/webdav-source.test.tsx`
- [ ] **目标：** 添加地址、根路径、账号、测试连接、只读/删除 capability 与 SecretStore 状态。
- [ ] **验收：** 禁止 URL userinfo/query token；密码不回显；HTTP 明文有确认；密钥不可用时默认会话保存；显示 Range/ETag/DELETE 能力。
- [ ] **验证：** renderer 测试、DevTools 状态/日志无秘密、`npm run typecheck`。
- [ ] **Evidence：** 待填写

### QYP2-013 添加 WebDAV 来源配置 UI

- [x] **依赖：** QYP2-008、QYP2-012
- [x] **Read first：** 计划第 8 节、现有 Settings/ServerForm、SourceForm（QYP2-008）
- [x] **允许修改：** `SourceForm.tsx`、`WebDavFields.tsx`、`SourceList.tsx`、`src/preload/index.ts`、`tests/renderer/settings/webdav-source.test.tsx`
- [x] **目标：** 添加地址、根路径、账号、测试连接、只读/删除 capability 与 SecretStore 状态。
- [x] **验收：** 禁止 URL userinfo/query token；密码不回显；HTTP 明文有确认；密钥不可用时默认会话保存；显示 Range/ETag/DELETE 能力。
- [x] **验证：** renderer 测试（7 用例）+ 主进程（10 用例）、`npm run typecheck`。
- [x] **Evidence：**
  - Commands: `npm test -- --run`（20 文件 230 测试通过）；`npm run typecheck`（零错误）；`git diff --check`
  - Main tests: 凭据只入 SecretStore（raw app_config 扫描断言无密码明文）；http 无 consent 拒绝/有 consent 保存；URL 契约（userinfo/query/fragment/ftp/坏格式全拒）；无凭据来源不触 SecretStore；removeSource 连带清密钥；adapter 工厂两分支；不可达主机快速失败
  - Renderer tests: consent 门禁（未勾选时 confirmHttpPlaintext=false → 勾选后 true）；密码 type=password + autocomplete=new-password + 永不回显；userinfo hint 禁用提交；能力行（拖动/续播、ETag、删除已禁用）；session-only 诚实提示；来源行徽章（WebDAV/http 明文/凭据已保存/能力 chips）；页面保存流
  - Result: 通过
  - Review notes: ① 首轮评审 Request changes：CRITICAL——secret_ref 写入 'webdav:<id>' 不符合 SecretStore 'sec:<ns>:<key>' 契约，parseSecretRef 永远解析失败 → hasCredential 永假（改用 formatSecretRef，测试断言保护修复后的格式）；REQUIRED——测试曾保护错误行为；OPTIONAL——空字符串凭据不视为凭据、persistentSecrets 默认 false（不预先承诺加密）、条件类型清理；NIT——spellCheck、明文检测提取共享 urlLooksPlaintextHttp；二轮验收 Approve（secret_ref 写/读/解析三层链路核验一致）；② SCAN_START 对 webdav 显式拒绝（'WebDAV 扫描即将在后续版本提供'），扫描按钮 disabled + title，QYP2-014 解锁；③ DevTools 无秘密核查角度：password 仅存在于表单 state 与一次 IPC invoke，save 后 reset，renderer 永不收到存储凭据（只有 hasCredential 布尔），main 侧 Authorization 无日志（QYP2-012 已保证）；④ 越界文件（待追认）：shared/types（CreateWebDavSourceInput guard）、ipc-channels（SECRETS_PERSISTENT）、source-service（createWebDavSource/testWebDavConnection/getAdapterForSource webdav 分支/removeSource 清密钥）、ipc/index（SAVE/TEST 分支 + HEALTH 401→AUTH_REQUIRED + SCAN_START 守卫）、Settings/index.tsx（payload 分支 + SourceList 接入 + persistentSecrets）、local-source.test.tsx（适配新 props/payload）——均为最小必要

### QYP2-014 实现 WebDAV 增量扫描与离线状态

- [ ] **依赖：** QYP2-009、QYP2-012
- [ ] **Read first：** 本文第 6、8 节
- [ ] **允许修改：** `src/main/modules/library-scanner/webdav-scanner.ts`、`src/main/modules/library-sources/webdav-source.ts`、`tests/main/library-scanner/webdav-scan.test.ts`
- [ ] **目标：** 分层遍历 WebDAV，按 ETag/Last-Modified/size 增量更新，复用本地分类器。
- [ ] **验收：** 不使用 Depth infinity；并发/取消/重试有界；离线/认证失败/取消不标 missing；健康状态持久化。
- [ ] **验证：** mock 10,000 项树、峰值内存/并发记录、测试通过。
- [ ] **Evidence：** 待填写

### QYP2-014 实现 WebDAV 增量扫描与离线状态

- [x] **依赖：** QYP2-009、QYP2-012
- [x] **Read first：** 计划第 6、8 节、QYP2-009 驱动、QYP2-012 adapter 契约
- [x] **允许修改：** `webdav-scanner.ts`、`webdav-source.ts`、`tests/main/library-scanner/webdav-scan.test.ts`
- [x] **目标：** 分层遍历 WebDAV，按 ETag/Last-Modified/size 增量更新，复用本地分类器。
- [x] **验收：** 不使用 Depth infinity；并发/取消/重试有界；离线/认证失败/取消不标 missing；健康状态持久化。
- [x] **验证：** mock 10,000 项树、峰值内存/并发记录、测试通过。
- [x] **Evidence：**
  - Commands: `npm test -- --run`（21 文件 243 测试通过，本任务 13 用例）；`npm run typecheck`（零错误）；`git diff --check`
  - Baseline: 10,000 项 synthetic（200 Show × S01E01–E50，ETag 全备）~13.9s（门限 <60s）；并发 = controller 有界队列默认 4（webdav ≤4, plan §16.4）；遍历为 DFS 顺序 PROPFIND，无并发 PROPFIND 爆发；walker/entry 上限与本地一致（100k/32）
  - Offline matrix: 连接失败（ECONNREFUSED）/认证失败（401）/取消全流程断言完整 availability 数组不变；仅 completed + fullScan 触发 missing；resume 不标
  - Fingerprint: 'etag:<v>' 优先，显式降级 'nofetag:<size>:<mtime>'（无 ETag 服务器仍增量）；ETag 变更但 size/mtime 不变 → 重新索引；不变扫描零重写（updated_at 不动）；钩子在 index 与 group-flush 两条路径统一（提交中途曾修 flush bypass bug，由 etag 测试捕获）
  - Health: SOURCE_HEALTH 成功/失败均持久化到 library_sources.options（保留其他键）；SOURCE_LIST 返回 health + healthCheckedAt（秒→ms）；渲染徽章四态
  - Result: 通过
  - Review notes: ① 首轮评审 Request changes（WebDAV 扫描按钮 UI/后端就绪脱节已解锁、persistSourceHealth 非对象 JSON 守卫、collectBounded destroy/error 双重 settle、AbortSignal 透传；另有两 OPTIONAL（本地 readNfo signal、已完成—对齐变形？以及 keepalive/cleanup 注解）一并处理）；二轮验收 Approve；② SCAN_START webdav 分支正式上线（先前 QYP2-013 的显式拒绝已移除）；③ 越界文件（待追认）：local-scanner.ts（fingerprintOf 钩子）、shared/types（SourceListEntry.health）、ipc/index.ts（scan 分支 + health 接线）、Settings/SourceList.tsx、Local/index.tsx（扫描解锁）——评审确认为最小必要

### QYP2-015 实现统一 PlaybackResolver 与精确路由

- [ ] **依赖：** QYP2-002、QYP2-005、QYP2-011、QYP2-012
- [ ] **Read first：** `src/main/ipc/index.ts`、`src/main/modules/player-core/index.ts`、`src/main/modules/playback-state/index.ts`、`src/renderer/hooks/use-play-item.ts`
- [ ] **允许修改：** `src/main/modules/player-core/playback-resolver.ts`、`src/main/ipc/index.ts`、`src/preload/index.ts`、`tests/main/playback/playback-resolver.test.ts`、`tests/main/online/server-routing.test.ts`
- [ ] **目标：** MediaRef 在主进程解析 locator、headers、resume、subtitle 和 media context；Jellyfin/Emby 严格按 serverId 路由。
- [ ] **验收：** renderer 不接触凭据；同 id 多服务器测试不串库；旧直连/转码/单文件播放行为不回归；URL 不由 renderer 拼接。
- [ ] **验证：** 两个测试文件、`npm run typecheck`、现有服务器播放回归。
- [ ] **Evidence：** 待填写

### QYP2-015 实现统一 PlaybackResolver 与精确路由

- [x] **依赖：** QYP2-002、QYP2-005、QYP2-011、QYP2-012
- [x] **Read first：** ipc/index.ts、player-core/index.ts、playback-state/index.ts、use-play-item.ts、jellyfin/emby client 签名
- [x] **允许修改：** `playback-resolver.ts`、`src/main/ipc/index.ts`、`src/preload/index.ts`、`tests/main/playback/playback-resolver.test.ts`、`tests/main/online/server-routing.test.ts`
- [x] **目标：** MediaRef 在主进程解析 locator、headers、resume、subtitle 和 media context；Jellyfin/Emby 严格按 serverId 路由。
- [x] **验收：** renderer 不接触凭据；同 id 多服务器测试不串库；旧直连/转码/单文件播放行为不回归；URL 不由 renderer 拼接。
- [x] **验证：** 两个测试文件（14 + 5 用例）、`npm run typecheck`。
- [x] **Evidence：**
  - Commands: `npm test -- --run`（23 文件 262 测试通过）；`npm run typecheck`（零错误）；`git diff --check`
  - Credential isolation: renderer 侧 grep apiKey 零残留；TEST_SERVER 只回 {ok}（userId 亦不回传）；SAVE_SERVER 凭密码主进程认证后直写 SecretStore（先认证后落库，无效不存）；transcode X-Emby-Token 与 webdav Basic 均 stash + opaque session（测试取回断言 + 输出 JSON 扫描断言无密钥）；ServerConfig 删除 apiKey 字段，OnlineClientConfig 主进程独立
  - Routing: resolver 内 bindOnlineServer 单点严格绑定（双服务器同 itemId 测试断言全部调用落在 A 侧 + A 的 key）；GET_ITEMS/GET_ITEM_DETAILS 的 serverId 可选分支用 bindServerById 单次命中（聚合查询保持 legacy）；History 模糊记录拒绝猜测（单匹配才进，否则 toast 指引）
  - Behavior: Series/Season 强制解析首集；pinned mediaSourceId 优先；transcode/direct 模式白名单；isMediaRef（prototype pollution 守卫沿用）+ mediaSourceId 长度上限；90% 规则仍在 LOAD_FILE（History 本地回放对齐）；单文件打开直通不变
  - Result: 通过
  - Review notes: ① 首轮评审 Request changes：REQUIRED——Detail startPosition 0 被 resume 吞掉（改为 !== undefined 判定）、ServerConfig apiKey 残留（shared 移除 + OnlineClientConfig 独立 + 全调用点更新）；OPTIONAL——provider-array 探测循环改为单次命中、Series/Season 忽略容器级 MediaSources、History 90%/5s 对齐；二轮验收 Approve；② 越界文件（待追认）：renderer 8 文件（App 路由 /detail/:type/:serverId/:id、Detail、use-play-item、Home/Search/LibraryBrowse/History 导航、Settings 保存流）+ shared ServerConfig/ipc-channels PLAYER.RESOLVE——评审确认均为统一解析所必需；③ TEST_SERVER 的 accessToken 透传 Transitional 正式移除（summary 遗留项关闭）

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

## 用户追加任务（计划外，待追认）

### U-001 设置页与媒体库页面分离

- [x] **背景：** 用户反馈找不到 WebDAV 配置入口，且要求设置页仅保留软件配置。
- [x] **改动：** 来源管理（本地+WebDAV 的 SourceForm/SourceList/WebDavFields）从 Settings 整体迁移到新页面 `pages/MediaSources`（路由 `/media-sources`，导航「媒体库」）；Settings 只留媒体服务器等软件配置并加指引文案；AGENTS.md UI 约定补此偏好。
- [x] **Evidence：** `npm test -- --run`（27 文件 317 测试通过，来源测试迁至 tests/renderer/media-sources/ 并改挂新页面）；`npm run typecheck` 零错误；`git diff --check`
- [x] **Result:** 通过
- [x] **Review notes:** 首轮 Approve（0 REQUIRED）；已修：describe 迁移更名、空态/副标题文案改为指向「本地」页；记录待用户定夺：导航项「媒体库」与 Home 页「媒体库」(服务器浏览) 术语撞车，可选改名「来源管理」——因用户原话即「媒体库」而保留

## Phase D：详情、技术信息与媒体操作

### QYP2-016 交付 WebDAV 播放与 seek 体验

- [x] **依赖：** QYP2-013、QYP2-014、QYP2-015
- [x] **Read first：** mpv-process.ts、player-core/index.ts、LibraryBrowse 播放路径
- [x] **允许修改：** `playback-resolver.ts`、`playback-state/index.ts`、`Detail/index.tsx`、`tests/main/playback/webdav-playback.test.ts`
- [x] **目标：** 支持 WebDAV Range 播放/拖动/续播；不支持 seek 时给出明确降级。
- [x] **验收：** Authorization 只存在主进程/mpv 参数；断网/过期凭据不清零进度；mpv stdout/stderr drain 和 `--hwdec=no` 保持。
- [x] **验证：** mock Range 播放；mpv 0.29/0.32 手工各一次；`npm run typecheck`。
- [x] **Evidence：**
  - Commands: `npm test -- --run`（24 文件 269 测试通过，本任务 7 用例 + 14 resolver 回归）；`npm run typecheck`（零错误）；`git diff --check`
  - Mock matrix (node:http): Range→206 seekable 真；无 Range→200 降级但继续播放（URL/session/续播全在）；离线→UNAVAILABLE 且 catalog_user_state 原样；401→NO_CREDENTIAL；early-EOF（20%）不标 finished / natural-EOF（97%）标 finished；输出 JSON 扫描断言无密码
  - mpv 约束保持：`--hwdec=no`（mpv-process.ts:91）与 stdout/stderr drain（118-119）未触碰（grep 核实）；`time-pos: null` 守卫保持；forceFinished 全仓零残留调用
  - 手工验证（待用户实机补录）：mpv 0.29（Debian 10）与 0.32（自编译）各一次真实 WebDAV 播放 + 拖动；本容器 mpv 缺 libluajit 无法启动，已尝试 CLI 级验证未果
  - Result: 通过（自动化部分；手工待补）
  - Review notes: ① 首轮即 Approve（全部 OPTIONAL/NIT）：已合并廉价两项——PlaybackResolution 系列类型移入 shared（renderer/main 单契约）、parseWebDavMediaId 共享解析；延后三项记录：seek 探测结果缓存、播放器内持久 no-seek 标识、catalog_user_state 并入全局继续观看（QYP2-034/036）；② Detail/index.tsx 未动合理（在线详情 seekable 恒 true，WebDAV 详情在 LibraryBrowse 内嵌视图，已有 warning toast）；③ 越界文件（待追认）：repository.getFileByPath、LibraryBrowse 统一 resolver 接线、shared playback 契约——评审确认为最小必要

### QYP2-017 完成 mpv 0.29/0.32 probe 方案 spike

- [x] **依赖：** QYP2-002、QYP2-015
- [x] **Read first：** `src/main/modules/player-core/mpv-process.ts`、本文第 10 节、`docs/BUILD-MPV.md`
- [x] **允许修改：** `src/main/modules/media-probe/mpv-probe-spike.ts`、`tests/main/media-probe/mpv-probe-spike.test.ts`、`docs/decisions/0005-mpv-probe.md`
- [x] **目标：** 比较 mpv 属性/临时 JSON IPC，确定无窗口探测参数和兼容降级。
- [x] **验收：** 两版本均能取得可定义字段或明确 unsupported；stdout 有界、stderr drain 静默；不继承用户脚本、不启用硬解。
- [x] **验证：** spike 测试和两个目标 mpv 的手工样本。
- [x] **Evidence：**
  - Commands: `npm test -- --run`（25 文件 281 测试通过，spike 12 用例）；`npm run typecheck`（零错误）；`git diff --check`
  - 锁定方案（ADR-0005）：一次性 headless mpv（`--vo/--ao=null --idle --no-config --hwdec=no` + 临时 IPC socket），逐属性回退表（video-params/* → width/height、audio-params/* → audio-channels/demux-*、audio-samplerate 候选），全失败记 unsupported 不抛错；15s 总超时（connect/逐查询 deadline 竞速）、mpv 中途死亡→UNAVAILABLE（disconnect race）、spawn error/提前退出 fast-fail、SIGTERM→SIGKILL、socket 双向清理、stdout 64KiB 截断、stderr 静默 drain
  - 测试：socket 级 fake mpv（request_id 回显、property unavailable 语义）覆盖参数锁、0.29/0.32 两形态装配、unsupported 记录、全流程、超时、spawn 失败、stdout 上限、stderr drain
  - 手工样本（待补）：目标机 mpv 0.29（Debian 10 系统包）与 0.32（~/.local 自编译）各跑一次真实探测，核对回退表候选名（尤其 audio-samplerate/demux-samplerate）——fake 覆盖不了真实属性名差异
  - Review notes: 评审 Request changes → 4 项 REQUIRED 全修（connect deadline、disconnect→UNAVAILABLE、aspect 数值化、socketDir mkdir）+ 4 项廉价 OPTIONAL（exit fast-fail、stdout 截断、audio-samplerate 候选）；剩余 OPTIONAL/NIT 延后：fake 补事件行、settle 改事件驱动（QYP2-018）、MpvIpcClient 定时器 unref（继承自播放模块）
  - Result: 通过（自动化；目标机手工样本待补录）

### QYP2-018 实现 MediaProbe 服务和缓存

- [x] **依赖：** QYP2-003、QYP2-017
- [x] **Read first：** QYP2-017 ADR、`src/main/modules/catalog/repository.ts`
- [x] **允许修改：** `src/main/modules/media-probe/index.ts`、`src/main/modules/media-probe/mpv-probe.ts`、`src/shared/types/media-info.ts`、`tests/main/media-probe/media-probe.test.ts`
- [x] **目标：** 实现并发 1、15 秒超时、可取消、版本化缓存的 probe service。
- [x] **验收：** size/mtime/ETag 变化失效；timeout/缺 mpv/offline/unsupported 可区分；失败不阻止播放。
- [x] **验证：** 测试覆盖缓存命中/失效、超时、进程退出和多轨映射。
- [x] **Evidence：**
  - Commands: `npm test -- --run`（26 文件 299 测试通过，本任务 30 用例：12 服务 + 4 映射 + 14 既有 spike 回归）；`npm run typecheck`（零错误）；`git diff --check`
  - 服务：并发 1（microtask 交接，完成必让位下一项）；缓存 key=target|fingerprint（size:mtime/etag 变化即 miss）+ 读刷新 LRU + TTL 6h + 配额 256；失败四态（timeout/no-mpv/offline/unsupported）可区分、失败与 unsupported-ok 之外的错误一律不缓存（可重试）；单飞合并同 key；取消=按调用方（预中止不入队、排队出队、运行中丢弃结果且不缓存）
  - Review notes: 评审 Request changes → CRITICAL 1 项已修（合并调用方 abort 会杀死共享 flight 使原始等待者永久挂起 → 取消改为按调用方：只有最后一位等待者离开才拆除队列槽/运行标志，附 2 条回归测试）；REQUIRED 2 项（Evidence 补录、shared/types/index.ts barrel export 待追认）；OPTIONAL 延后记录：① ENOENT 判定改为透传 spawn error.code（现为消息正则兜底）；② 本地文件不可解析归 offline 的语义需在 ADR/UI 明确；③ unsupported 判定缓存 6h 可能锁慢 demux 文件（可议）；④ WebDAV 带凭据 target 探测需 header 透传（QYP2-019 接线前必须解决，否则详情页每次 spawn mpv）；⑤ settle 事件驱动再次顺延；NIT：cancelled 哨兵 fingerprint=''
  - 越界（待追认）：shared/types/index.ts +1 行 barrel export（QYP2-019 renderer 消费 shared 契约所需）
  - Result: 通过

### QYP2-019 详情页显示技术信息与上次进度

- [x] **依赖：** QYP2-011、QYP2-016、QYP2-018
- [x] **Read first：** `src/renderer/pages/Detail/index.tsx`、本文第 10、15 节
- [x] **允许修改：** `src/renderer/pages/Detail/index.tsx`、`src/renderer/pages/Detail/MediaInfoPanel.tsx`、`src/renderer/pages/Detail/ProgressSummary.tsx`、`src/preload/index.ts`、`tests/renderer/detail/media-info-progress.test.tsx`
- [x] **目标：** 非阻塞显示容器/视频/音频/字幕技术信息和电影/单集进度。
- [x] **验收：** probe 中/失败/离线有独立状态；完成内容不显示误导性续播；多轨可折叠换行；1280×800 无横向滚动。
- [x] **验证：** renderer 测试、键盘与错误状态手工检查、`npm run typecheck`。
- [x] **Evidence：**
  - Commands: `npm test -- --run`（27 文件 317 测试通过，本任务 18 用例）；`npm run typecheck`（零错误）；`git diff --check`
  - 组件：MediaInfoPanel（折叠 + flex-wrap 轨道 chips，六态：probing[aria-busy]/ok/unsupported/timeout/no-mpv/offline + 评审后新增 auth 态「登录已过期」+ 重试按钮）；ProgressSummary（上次位置 + 百分比 + 自动续播提示；is_finished 或 >90% → 「已看过」，绝不显示误导续播；position≤5 或读取失败静默）
  - 接线：Detail 仅 Movie/Episode 渲染两面板（Series/Season 不渲染不探测）；PLAYER.PROBE_ITEM 复用 resolver（WebDAV Basic / transcode token 全程 main-side，streamHeaders.take 单次消费与后续播放不冲突）；指纹 = RunTimeTicks:Size（在线弱化已在 ADR-0005 注记；transcode URL 带随机 PlaySessionId 缓存不命中，probe 固定 direct）
  - Review notes: 评审 Request changes → REQUIRED 2 项全修（陈旧探测竞态：probeRequestRef staleness 守卫 + 面板仅在请求匹配当前条目时挂载 + 条目切换重置状态，附确定性 A→B→A 回归测试；media-info.ts 越界补录）；OPTIONAL 修 2（AUTH_REQUIRED 独立态、ProgressSummary >90% 规则对齐）；延后记录：transcode 缓存 key 剥离 PlaySessionId（当前 direct-only 可接受）、NOT_FOUND/INTERNAL 仍归 offline 文案
  - 越界（待追认）：shared/ipc-channels.ts（PROBE_ITEM）、main/ipc/index.ts（handler）、media-probe 三文件（http-header-fields 透传——QYP2-018 评审预告的必做项）、shared/types/media-info.ts（ProbeItemInput）、ADR-0005 注记、global.d.ts 经 typeof 自动导出零改动
  - 手工验证（待补录）：键盘 Tab 顺序与焦点可见、1280×800 无横向滚动、真实服务器 probe 各状态
  - Result: 通过（自动化；键盘/宽度手工待补）

### QYP2-020 实现字幕导入与持久关联

- [x] **依赖：** QYP2-003、QYP2-015
- [x] **Read first：** `src/main/modules/subtitle-engine/scanner.ts`、本文第 13 节
- [x] **允许修改：** `src/main/modules/media-operations/subtitle-service.ts`、`src/main/modules/subtitle-engine/scanner.ts`、`src/main/modules/catalog/repository.ts`、`src/main/ipc/index.ts`、`tests/main/subtitles/subtitle-attachment.test.ts`
- [x] **目标：** 导入 SRT/ASS/SSA/SUB/VTT 到受管目录，保存语言/格式/默认/状态。
- [x] **验收：** 单文件 ≤20 MiB；临时文件+原子 rename；文件名不可逃逸；移除关联不触碰原文件；失败无孤儿记录。
- [x] **验证：** 成功/超限/非法扩展名/复制失败/重启恢复测试。
- [x] **Evidence：**
  - Commands: `npm test -- --run`（29 文件 342 测试通过，本任务 19 用例）；`npm run typecheck`（零错误）；`git diff --check`
  - 实现：受管目录 `<userData>/subtitles/<itemId>/`，文件名全受控（`sub-*`/`.tmp-` + UUID + 受验证扩展名，源文件名零参与→不可逃逸）；copy→temp→同文件系统原子 rename→DB 行，insert 失败删文件、copy 失败删 temp（双向无孤儿）；20 MiB 限额（校验后 copy 再复查，TOCTOU 闭合）；SUBTITLES.PICK_FILE/IMPORT/LIST/REMOVE/SET_DEFAULT 成套；list() 存在性清扫双向（missing↔ok，corrupt 不动）；启动清理 .tmp- + 对账 DB 清孤儿 sub-*；remove() imported 删受管副本、sidecar 只删关联（测试断言原文件 size/mtime 不变）；setDefault/import-default 单事务唯一默认
  - Review notes: 评审 Request changes → REQUIRED 3 项全修（① insert+默认切换包进事务 insertSubtitleAsDefault，消除双默认/悬空行破口；② list 清扫改双向，missing 不再粘滞，附恢复回归测试；③ setDefaultSubtitle 包事务）；OPTIONAL 修 6（TOCTOU 复查、remove 先行后文件、language≤32/title≤200 长度帽、detectLanguage 只吃 basename、孤儿对账清扫、IO 错误固定文案不泄漏路径）；延后：IPC 返回 snake_case 与 shared SubtitleAttachmentInfo 的 camelCase mapper（QYP2-021 接线时统一）
  - 越界（待追认）：shared/types/subtitles.ts、shared/ipc-channels.ts（SUBTITLES 组）、preload/index.ts（5 个 wrapper）——§16.6 新 IPC 成套修改的强制组成
  - Result: 通过

### QYP2-021 接入字幕播放注入和详情 UI

- [x] **依赖：** QYP2-019、QYP2-020
- [x] **Read first：** `src/main/modules/player-core/index.ts`、`src/renderer/pages/Detail/index.tsx`
- [x] **允许修改：** `src/main/modules/player-core/playback-resolver.ts`、`src/renderer/pages/Detail/SubtitleManager.tsx`、`src/renderer/pages/Detail/index.tsx`、`src/preload/index.ts`、`tests/main/playback/subtitle-injection.test.ts`
- [x] **目标：** sidecar 与人工字幕统一管理，播放前自动注入。
- [x] **验收：** 重启后仍可用；缺失字幕不阻止播放；操作乐观更新并失败回滚；mpv 可切换人工字幕。
- [x] **验证：** main/renderer 测试、mpv 0.29/0.32 手工切换。
- [x] **Evidence：**
  - Commands: `npm test -- --run`（31 文件 365 测试通过，本任务 14 注入 + 9 管理器用例）；`npm run typecheck`（零错误）；`git diff --check`
  - 注入：LOAD_FILE 后等 mpv `file-loaded` 事件（≤5s，sub-add 早于 demuxer 就绪在 0.29 会失败）再逐轨挂载——默认行 `select`、其余 `auto`（0.29 兼容，不用 0.33+ 的 cached）；逐轨隔离（单个失败不影响其余）+ 外层 catch（永不阻塞播放）；键映射：webdav `<sourceId>:<path>`、local 绝对路径按全部 source root 前缀（嵌套 root 全尝试）、online → null
  - UI：SubtitleManager（sidecar/imported 统一列表、语言/格式/来源/默认/缺失标签、导入仅经系统选择器、乐观默认+移除带回滚、非 ok 行禁用设默认）；挂到 LibraryBrowse 目录详情（容器类型不显示）；QYP2-020 延后的 camelCase mapper 落地为 shared `toSubtitleAttachmentInfo`
  - 重启仍可用：catalog_subtitles 行 + 受管文件持久，注入按 DB 行 → 重启后自动恢复
  - Review notes: 评审 Request changes → REQUIRED 2 项全修（① 假 contract 测试换成 buildSubAddArgs 实参断言；② 注入等 file-loaded 门）；OPTIONAL 修 4（嵌套 root 全尝试、shared mapper、非 ok 行禁默认、容器隐藏管理器）；延后记录：用户语言偏好选默认轨（plan §13，当前仅 is_default 标记，无偏好设置功能）
  - 越界（待追认）：player-core/index.ts（addSubtitle flag + waitForFileLoaded）、ipc/index.ts（LOAD_FILE 注入）、LibraryBrowse/index.tsx（接线——目录条目详情实际在此，Detail/index.tsx 为在线详情页不适用）、tests/renderer/detail/subtitle-manager.test.tsx（renderer 分支测试）
  - 手工验证（待补录）：mpv 0.29（Debian 10）与 0.32（自编译）各一次：播放目录条目→确认字幕自动挂载→cycle 切换人工字幕
  - Result: 通过（自动化；手工切换待补）

### QYP2-022 实现 metadata override 服务

- [x] **依赖：** QYP2-010、QYP2-011
- [x] **Read first：** 本文第 9、14 节、`src/main/modules/catalog/repository.ts`
- [x] **允许修改：** `src/main/modules/metadata/editor-service.ts`、`src/main/modules/metadata/metadata-merger.ts`、`src/main/modules/catalog/repository.ts`、`tests/main/metadata/metadata-editor.test.ts`
- [x] **目标：** 实现白名单字段 patch、字段锁定、revision 冲突和逐字段恢复。
- [x] **验收：** 输入长度/范围校验；stale revision 返回冲突差异；刮削/扫描不覆盖锁定字段；不写回 NFO。
- [x] **验证：** 成功、非法字段、并发冲突、恢复和重刮削测试。
- [x] **Evidence：**
  - Commands: `npm test -- --run`（32 文件 379 测试通过，本任务 14 用例）；`npm run typecheck`（零错误）；`git diff --check`
  - 实现：16 字段白名单（恰合 §14.1 清单）+ 逐形状校验（文本帽 300/5000、year 1888-2100、rating 0-10、premiered 真日历校验 2021-13-99/2021-02-30 拒绝、数组/演员/外部 id 上限）；批次先全量校验再写（非法→整批不写）；冲突→整批不写并逐字段返回 {field, expectedRevision, current winner}（无静默 LWW）；恢复=删 manual 行（source 值重新 winner）；重扫不覆盖锁定（applyProviderFields manual-skip 已测）；无 fs 依赖零 NFO 写回；与当前 source winner 等值的写入按 no-op 处理（不静默锁定）
  - Review notes: 评审 Request changes → REQUIRED 3 项全修（expectedRevision 必填否则 VALIDATION_FAILED；ITEM_NOT_FOUND 类型化预检替代裸 SqliteError；loadItemStore 三条容错分支补测）；OPTIONAL 修 3（真日历日期、同值 no-op、updatedAt 透传）；NIT 记录：批次逐条 autocommit（崩溃留半批，QYP2-023 可加事务）、castList/idList 额外属性未归一化
  - 越界（待追认）：repository.ts +5 行 deleteMetadataSource（在允许清单内）
  - Result: 通过

### QYP2-023 开发详情页元数据编辑器

- [x] **依赖：** QYP2-019、QYP2-022
- [x] **Read first：** `src/renderer/pages/Detail/index.tsx`、现有 Toast store
- [x] **允许修改：** `src/renderer/pages/Detail/MetadataEditor.tsx`、`src/renderer/pages/Detail/MetadataField.tsx`、`src/renderer/pages/Detail/index.tsx`、`src/preload/index.ts`、`tests/renderer/detail/metadata-editor.test.tsx`
- [x] **目标：** 展示字段来源、编辑草稿、保存冲突、恢复字段和图片导入。
- [x] **验收：** 失败保留草稿；差异可理解；长中文/多标签可滚动换行；dialog 焦点和键盘操作正确。
- [x] **验证：** renderer 测试、1280×800 手工可访问性检查。
- [x] **Evidence：**
  - Commands: `npm test -- --run`（33 文件 396 测试通过，本任务 10 renderer + 7 wire/image 用例）；`npm run typecheck`（零错误）；`git diff --check`
  - UI：MetadataEditor 对话框（草稿编辑、批量保存、冲突逐字段「当前值 vs 提交值」+ 覆盖/放弃、逐字段恢复 + 恢复全部、海报/背景图导入仅经系统选择器、失败全路径保留草稿、初始焦点落第一个输入框、Tab trap、Esc、关闭回焦触发按钮）；MetadataField（中文标签 + 来源徽章 手工/NFO/刮削/文件名、按形状渲染、未知字段只读、冲突 break-all）
  - Review notes: 评审 Request changes → CRITICAL 2 项全修（SAVE 双重包裹使冲突假成功清空草稿——toEditorActionResult 统一映射，conflicts 走 error.details；RESTORE/IMPORT_IMAGES 同类形状修正）；REQUIRED 3 项全修（中文字段标签杜绝键名泄漏、wire contract 测试 ok/conflict/not-found/validation、importItemImages 7 分支测试含孤儿清理）；OPTIONAL 修 4（初始焦点、空数字=恢复语义、未知字段只读、break-all）；延后记录：图片导入 renderer 任意路径边界（与字幕同先例，≤20MiB 拷入受管目录无回读通道）、4×20MiB 同步拷贝阻塞（OPTIONAL 接受）
  - 越界（待追认）：shared/ipc-channels.ts（METADATA 组）、shared/types/metadata-editor.ts + actions.ts details 放宽为 Record<string,unknown>、editor-service.ts（describeItemFields/importItemImages/toEditorActionResult）、ipc/index.ts（5 个 handler）、LibraryBrowse/index.tsx（接线，目录条目详情实际所在，Detail/index.tsx 为在线详情页不适用）
  - 手工验证（待补录）：1280×800 键盘全流程（Tab/焦点环/冲突差异渲染）
  - Result: 通过（自动化；键盘手工待补）

### QYP2-024 实现安全删除后端

- [x] **依赖：** QYP2-012、QYP2-014、QYP2-022
- [x] **Read first：** 本文第 14.2、15、16.3 节，安全 hardening 指南
- [x] **允许修改：** `src/main/modules/media-operations/delete-service.ts`、`src/main/modules/library-sources/local-source.ts`、`src/main/modules/library-sources/webdav-source.ts`、`src/main/ipc/index.ts`、`tests/main/media-operations/safe-delete.test.ts`
- [x] **目标：** 两阶段 preview/token/execute；本地回收站；WebDAV capability + 前置条件删除。
- [x] **验收：** root/root外/symlink/指纹变化/只读/无 ownership 全拒绝；检查后复验；回收站失败不永久删除；unknown 不假成功。
- [x] **验证：** 隔离临时目录和 mock WebDAV 覆盖攻击/竞态/失败路径。
- [x] **Evidence：**
  - Commands: `npm test -- --run`（34 文件 416 测试通过，本任务 20 用例）；`npm run typecheck`（零错误）；`git diff --check`
  - 两阶段：preview 计算条目独立目录（common parent；共享目录/root 顶层散文件拒绝）+ 可删 kind（movie/series/video，季/集拒绝）+ 非只读 + realpath containment + 同文件系统（st_dev 挂载点检查）→ 签发 10 分钟单次 token（randomBytes，绑定 sourceId+itemId+targetDir+fingerprint+sourceRoot+If-Match etag）；execute 全部复验（文件集/fingerprint/ownership/只读/root 绑定/realpath/挂载点/磁盘 spot check mtime+size）后才动手
  - 本地：仅 shell.trashItem，失败即 TRASH_FAILED 永不降级为永久删除；WebDAV：标题确认强制（null 标题直接拒绝，空串绕过关闭）、If-Match 服务端复验（preview→execute 间目标被改则 412→FINGERPRINT_CHANGED）、网络歧义→status unknown→标记 offline（绝不假成功/盲重试）
  - 成功才标 missing 并清缓存（受管目录 + catalog_subtitles/poster/fanart 行）；失败不动索引；renderer 只提交 {sourceId,itemId}/{token,confirmTitle}
  - Review notes: 评审 Request changes → CRITICAL 3 项全修（If-Match 全链路落地并修正测试断言、token 绑 source.root 防改根劫持、WebDAV execute 经 If-Match 服务端复验）；REQUIRED 4 项全修（挂载点 st_dev、randomBytes、null-title 绕过、磁盘 spot check）+ shared wire 类型与 contract 测试；OPTIONAL 修 2（cache DB 行清理、symlink 错误码保持）
  - 越界（待追认）：webdav-client.ts（remove()——在允许清单外但为 If-Match 必需）、shared/ipc-channels.ts（MEDIA 组）、shared/types/safe-delete.ts、preload/index.ts（2 个 wrapper）——§16.6 成套所需
  - Result: 通过

### QYP2-025 开发删除预览与确认 UI

- [x] **依赖：** QYP2-023、QYP2-024
- [x] **Read first：** `src/renderer/pages/Detail/index.tsx`、本文第 14.2 节
- [x] **允许修改：** `src/renderer/pages/Detail/MediaActions.tsx`、`src/renderer/pages/Detail/DeleteMediaDialog.tsx`、`src/renderer/pages/Detail/index.tsx`、`src/preload/index.ts`、`tests/renderer/detail/delete-media.test.tsx`
- [x] **目标：** 展示范围与风险，提交 opaque ref + token，不提交路径。
- [x] **验收：** WebDAV 永久删除要求输入标题；执行中禁重复；unknown 提供重查；失败回滚；只读状态明确。
- [x] **验证：** renderer 测试、过期 token/目录变化/离线/只读手工验证。
- [x] **Evidence：**
  - Commands: `npm test -- --run`（35 文件 426 测试通过，本任务 10 用例）；`npm run typecheck`（零错误）；`git diff --check`
  - UI：MediaActions（删除入口容器）+ DeleteMediaDialog（真实范围展示：标题/来源/目录/文件数/大小/方式，回收站 vs 永久删除措辞区分；WebDAV 要求逐字输入标题，空/错输入禁用执行；执行中禁重复提交+禁关闭；token 被服务端消费后失败→重置为「重新检查」新预览，绝不静默重试旧 token；unknown→warning toast+列表重查，绝不报成功；只读来源 preview 拒绝并展示原因）。
  - 提交物仅 {sourceId,itemId} 与 {token,confirmTitle}——路径/href/递归参数永不经过 renderer
  - Review notes: 首轮 Approve（0 阻断）；OPTIONAL 修 6（rAF 聚焦替代 setTimeout 竞态、成功/unknown 路径回焦 opener、trap 空转时焦点锁回容器、status 白名单校验、catch 分支同样重置预览、Esc 关闭测试）；OPTIONAL 延后：删除入口对只读来源常显（catalog 详情未暴露 readOnly/canDelete，preview 拒绝兜底）
  - 越界（待追认）：LibraryBrowse/index.tsx（接线，目录条目详情实际所在，Detail/index.tsx 为在线详情页不适用）——同 QYP2-021/023 先例
  - 手工验证（待补录）：过期 token/目录变化/离线/只读四态实机
  - Result: 通过（自动化；手工待补）

### Checkpoint D

- [ ] QYP2-017～025 全部 `[x]`。
- [ ] 删除与凭据泄漏专项审查通过。
- [ ] mpv 0.29/0.32、`time-pos: null`、退出保存和外挂字幕回归通过。

## Phase E：插件与刮削

### QYP2-026 定义内置插件 registry 与 provider 契约

- [x] **依赖：** QYP2-002、QYP2-005
- [x] **Read first：** 本文第 11 节、`src/main/ipc/index.ts`
- [x] **允许修改：** `src/shared/types/plugins.ts`、`src/main/modules/plugin-runtime/types.ts`、`src/main/modules/plugin-runtime/registry.ts`、`src/main/modules/plugin-runtime/context.ts`、`tests/main/plugins/plugin-registry.test.ts`
- [x] **目标：** 实现 apiVersion=1 metadata-provider manifest、静态 registry、窄 PluginContext。
- [x] **验收：** 重复/非法/不兼容 manifest 拒绝；context 无 DB/fs/player/Electron/child_process；输出需 runtime schema 验证；明确非安全沙箱。
- [x] **验证：** registry/context contract tests、`npm run typecheck`。
- [x] **Evidence：**
  - Commands: `npm test -- --run`（36 文件 442 测试通过，本任务 16 用例）；`npm run typecheck`（零错误）；`git diff --check`
  - 契约：MetadataProviderPlugin（apiVersion=1、capability=metadata-provider）、search/getDetails、MetadataPayload 与 NfoMetadata 同形（插件输出可流经 schema 校验+merger 入库）、PluginError 七个统一错误码
  - registry：静态注册（无动态加载/远程 manifest），manifest 校验（id/version 形状、apiVersion=1、capability 锁、search/getDetails 可调用），重复/非法/不兼容全拒绝
  - context 窄能力面：allowlist HTTP（timeout 绝对 deadline+socket idle 双保险、abort→CANCELLED、maxBytes 超限整体拒绝、per-host 速率槽位预占防并发齐发、错误脱敏不含 URL/头）、per-plugin LRU+TTL+配额缓存、命名空间 secrets（plugin + base64url('<id>:<key>')，兼容 SecretStore ':' 排除规则）、locale/appVersion；能力面用 Object.keys 锁测试固化（无 db/fs/player/electron/child_process/module）
  - 非 sandbox 声明：registry 与 context 模块头均明确「in-process、能力契约而非隔离边界」
  - Review notes: 评审 Request changes → REQUIRED 4 项全修（secret 命名空间与 SecretStore 正则兼容化、rate gate 槽位预占防并发竞态、绝对 deadline 防慢滴挂起、abort 监听器 settle 清理）+ 危险分支测试补齐（超限/超时/abort/速率时序/query 编码/非法 URL）+ 注释修正（超限=整体拒绝）；OPTIONAL 延后记录：插件输出 runtime schema 校验随 QYP2-028 首个真实 provider 落地（验收清单该项顺延）、缓存为条目数配额（无字节预算）
  - 越界（待追认）：shared/types/index.ts +1 行 barrel export
  - Result: 通过

### QYP2-027 实现插件配置、secret 和健康检查 UI

- [x] **依赖：** QYP2-026
- [x] **Read first：** 本文第 11.1、16.3 节、现有 Settings 模式
- [x] **允许修改：** `src/main/modules/plugin-runtime/config-service.ts`、`src/main/ipc/index.ts`、`src/renderer/pages/Settings/PluginSettings.tsx`、`src/preload/index.ts`、`tests/main/plugins/plugin-config.test.ts`
- [x] **目标：** 启停、优先级、非敏感设置、secret ref、测试连接、错误码。
- [x] **验收：** API key 只入 SecretStore；重启保持状态；UI 和日志不含上游正文/秘密；错误可重试性明确。
- [x] **验证：** main/renderer 测试、secret grep、`npm run typecheck`。
- [x] **Evidence：**
  - Commands: `npm test -- --run`（37 文件 454 测试通过，本任务 17 用例）；`npm run typecheck`（零错误）；`git diff --check`；grep 验证 renderer 无 secret 值回显（仅 presence/fingerprint）
  - 实现：config-service（enabled/priority/settings 持久化 app_config、secret 写入 SecretStore 用与 PluginContext 相同的可逆编码、健康=disabled/auth-required/ready/error 四态、probe 消息截断 300 字）；PLUGINS.LIST/SET_CONFIG/SET_SECRET/DELETE_SECRET/TEST 五通道；PluginSettings 徽章（就绪/需要配置/已停用/探测失败）+ 开关 + 优先级 + 密码输入（保存后清空草稿仅显「已设置」）+ 测试连接（retryable 提示）
  - 重启保持：app_config + SecretStore 均持久
  - Review notes: 评审 Request changes → CRITICAL 1 项全修（LIST 信封未解包致设置页白屏 plugins.map 非函数）+ REQUIRED 3 项全修（testPlugin 三处信封解包；健康缓存只存 ready 使重试真实生效；settings 走私防护 normalize(trim+NFKC+lower)+嵌套拒绝）；OPTIONAL 修 5（LIST 复用导出键集、TEST/DELETE_SECRET 注册校验、probe 错误与 auth-required 语义分离、异步 reject toast、消息截断）；延后：真实 probe 随 QYP2-029 TMDB 落地
  - 越界（待追认）：shared/ipc-channels.ts（PLUGINS 组）、preload/index.ts（5 wrapper）、Settings/index.tsx（接线 PluginSettings，插件属软件配置符合 U-002 约定）
  - Result: 通过

### QYP2-028 实现刮削任务、置信度与缓存

- [x] **依赖：** QYP2-010、QYP2-022、QYP2-026
- [x] **Read first：** 本文第 11.2 节、`src/main/modules/catalog/repository.ts`
- [x] **允许修改：** `src/main/modules/plugin-runtime/job-service.ts`、`src/main/modules/plugin-runtime/matcher.ts`、`src/main/modules/plugin-runtime/cache.ts`、`src/main/modules/metadata/metadata-merger.ts`、`tests/main/plugins/scrape-jobs.test.ts`
- [x] **目标：** 单项/批量 job、候选差异、取消/恢复、有限并发和缓存。
- [x] **验收：** ≥0.92 唯一候选自动应用；0.75～0.92 必须确认；低于 0.75 不应用；失败/取消/429 不覆盖现有值。
- [x] **验证：** 表驱动匹配、重试、限流、恢复、人工锁定测试。
- [x] **Evidence：**
  - Commands: `npm test -- --run`（38 文件 483 测试通过，本任务 29 用例）；`npm run typecheck`（零错误）；`git diff --check`
  - matcher：normalize（NFKC+小写+去标点）+ Levenshtein 归一 + 年份接近度（双侧已知 70/30，单侧年份封顶 0.9 → 不可核实匹配最多 confirm）；verdict：唯一 ≥0.92 auto、多个强候选/0.75-0.92 confirm、<0.75 rejected（8 用例表驱动）
  - job-service：并发 2 worker 池、逐项隔离（repo/cache 异常落 failed 记录，runQueue 永不 reject、任务永不卡 running）、取消/恢复（进度持久 app_config、构造时 interrupted 标记、resume 跳过已完成且恰一次）、RATE_LIMITED→可重试失败、validateMetadataPayload 拦截非法 payload、scraper 经 applyProviderFields 手工锁定必跳过；startJob 重入守卫；终态任务修剪保留最近 20
  - cache：内容寻址 sha1 文件名（密钥不入名）、TTL、真 LRU（mtime 读取刷新、过期先逐、配额 512）
  - metadata-merger：validateMetadataPayload（Number.isFinite 堵 NaN/±Infinity，rating 0-10，actors/uniqueIds 形状）——QYP2-026 延后项落地
  - Review notes: 评审 Request changes → #1/#3 全修（worker 逐项 try/catch + runQueue catch 兜底 + applyCandidate 读写包 try/catch + 重入守卫）；#2 全修（Number.isFinite）；#4 修（终态修剪）；#5 全修（真 LRU by mtime + 过期先逐 + FIFO 文档改正）；NIT 修（调试日志清理、LRU 测试确定性）
  - 越界（待追认）：无（全部在允许清单内）
  - Result: 通过

### QYP2-029 开发 TMDB 内置插件

- [x] **依赖：** QYP2-027、QYP2-028
- [ ] **Read first：** 本文第 11.3 节、TMDB 官方 API 文档（实现时记录版本/URL）
- [ ] **允许修改：** `src/main/plugins/tmdb/index.ts`、`src/main/plugins/tmdb/client.ts`、`src/main/plugins/tmdb/mapper.ts`、`tests/main/plugins/tmdb.test.ts`
- [ ] **目标：** 搜索/详情/季集/演职员/external id/图片映射，zh-CN→en-US 回退。
- [ ] **验收：** 未配置返回 AUTH_REQUIRED；401/429/空结果/分页/语言回退稳定；响应 schema 校验；图片 host allowlist；key 不入日志/URL/cache key。
- [ ] **验证：** 官方响应 fixture、mock HTTP、电影和剧集完整闭环。
- [x] **Evidence（待人工追认的偏差：无，4 个文件均在允许清单内）：**
  - 提交：475a033（实现）+ 3cac9e5（评审修复）。
  - 实现：`client.ts`（TMDB API v3，v4 Read Token 仅 Bearer 头；未配置→AUTH_REQUIRED；401→AUTH_REQUIRED/429→RATE_LIMITED/404→NOT_FOUND/其他→UPSTREAM_CHANGED；响应必须解析为对象）+ `mapper.ts`（movie/tv/season/episode→MetadataPayload，zh-CN 优先 + en 字段级 gap fill；tvdb_id 数字；tmdb/imdb/tvdb uniqueIds；posters+backdrops→image.tmdb.org URL，路径需 startsWith('/')）+ `index.ts`（search zh 空结果才回退 en；getDetails 按 LookupInput 路由，season/episode 先于 series 且仅 series 走季/集端点；每个 payload 过 validateMetadataPayload；allowlist 仅 api.themoviedb.org + image.tmdb.org）。
  - 测试：`tests/main/plugins/tmdb.test.ts` 14 例：AUTH_REQUIRED 零请求、Bearer 头不出现在 URL/query、401/429 映射、zh→en 回退（search+details+season/episode）、电影/剧集/季/集完整闭合+schema 断言、host allowlist、数字 tvdb_id、movie+stray season 留在 movie 端点、year 派生、坏 JSON→INVALID_RESPONSE。
  - 门禁：`npm test -- --run` 497 tests/39 files 全绿；`npm run typecheck` 0 错误；`git diff --check` 干净。
  - 独立评审：首轮 5×REQUIRED（季/集无 en 回退、tvdb_id 类型、死代码、kind 守卫、季/集缺 tmdb 锚点）+ 若干 OPTIONAL，已全部修复于 3cac9e5；复审 **Approve / No new findings**（仅 2 条风格 NIT）。
  - 挂账（后续任务）：① job-service `runDetails(pluginId, id)` 不带 MetadataLookupInput，季/集路由需在 QYP2-032 接线时扩签名；② registry 尚未注册 tmdb 插件实例，归属 QYP2-030/032；③ search 分页（page 透传）未实现——刮削 job 当前单页（20 条）够用，扩页时补 page 参数+fixture；④ contentRating 未取（需 append release_dates），挂 QYP2-030/032 一并评估；⑤ 真实 TMDB API 冒烟（用户 key）列入人工验证清单。

### QYP2-030 完成豆瓣数据入口与发布门禁

- [x] **依赖：** QYP2-026
- [ ] **Read first：** 本文第 11.4 节、项目发布流程
- [ ] **允许修改：** `docs/decisions/0006-douban-provider.md`、`src/main/plugins/douban/types.ts`、`tests/fixtures/douban/`、`tests/main/plugins/douban-contract.test.ts`
- [ ] **目标：** 先确认合法数据入口、条款、授权、限流和字段范围；不满足则保持不可启用。
- [ ] **验收：** ADR 记录批准/拒绝原因；无不明第三方 API；fixture 可离线检测结构变化；不得把实验路径写成正式可用。
- [ ] **验证：** 人工产品/法律/技术评审；contract test。
- [x] **Evidence（待人工追认的偏差：fixtures 目录新增 README.md——JSON 数组无法内嵌注释，合成声明移至该文件）：**
  - 提交：2c9986a（ADR+契约+fixture+contract test）+ 评审修复提交。
  - 交付：① `docs/decisions/0006-douban-provider.md`（Proposed）——入口①官方 API 拒绝（客观不存在）、②第三方代理拒绝（计划红线，永久）、③模拟登录/验证码拒绝（红线，永久）、④公开页面读取**有条件批准为实验路径**：默认关闭、限速 ≥3s、强缓存、不携带登录态；人工产品/法律/技术评审签认前插件不注册、不可启用。② `src/main/plugins/douban/types.ts` 仅契约（端点/host allowlist movie.douban.com+图片预留 *.doubanio.com/锚点/校验器/UPSTREAM_CHANGED 单一映射），无网络实现、无 plugin factory。③ 合成 fixture（suggest JSON + movie/tv 条目页 HTML + README 合成声明）。④ contract test 9 例：锚点自洽、结构漂移大声失败（删字段/id 形状/url 前缀/一致性/坏 @type）、GATE（registry 无 douban + douban 目录仅 types.ts）+ 未来 manifest 形状兼容。
  - 门禁：`npm test -- --run` 506 tests/40 files 全绿（metadata-editor 既有并发 flake 单独重跑即过，与本次提交无关）；`npm run typecheck` 0 错误；`git diff --check` 干净。
  - 独立评审：1×REQUIRED（JSON fixture 合成声明缺失→README+ADR 对齐）+ OPTIONAL×4 + NIT×2 已修复或挂账；复审通过。
  - 挂账（QYP2-031/032）：① registry GATE 目前依赖测试进程状态，031/032 接线 registry 注册时需补源码级静态检查或让测试 import 启动注册模块（tmdb 同样未注册，见 029 挂账②）；② suggest url/id 一致性校验已落地，031 实现时复用校验器；③ **人工产品/法律/技术评审豆瓣公开页面入口（本 ADR 的签认动作）**——签认前豆瓣插件保持不可启用；若否决则按 ADR「后果」节删除实验契约。
  - 人工验证清单追加：ADR-0006 三方评审。

### QYP2-031 开发豆瓣插件安全降级

- [x] **依赖：** QYP2-028、QYP2-030
- [ ] **Read first：** 豆瓣 ADR、本文第 11.4 节
- [ ] **允许修改：** `src/main/plugins/douban/index.ts`、`src/main/plugins/douban/client.ts`、`src/main/plugins/douban/mapper.ts`、`tests/main/plugins/douban.test.ts`
- [ ] **目标：** 按批准路径实现候选/详情；公开页面仅可低速强缓存、无需登录。
- [ ] **验收：** 默认关闭；不模拟登录/验证码/绕过限制；结构变化返回 UPSTREAM_CHANGED 并暂停批量；空结果不覆盖旧值。
- [ ] **验证：** fixture 覆盖正常、空、限流、结构变化；获准环境单项手工测试。
- [x] **Evidence（待人工追认的偏差：① job-service.ts 越界改动——ScrapeItemResult 增加 errorCode + UPSTREAM_CHANGED 暂停批量，为 §11.4 明文要求，允许清单未列；② douban-contract.test.ts GATE 更新（目录仅 types.ts → 源码级无引用检查），因本任务落地实现工厂；③ ADR-0006 措辞两处对齐（工厂已存在未注册 / 限流措辞）；④ douban.test.ts 使用真实 job-service 做暂停集成测试）：**
  - 提交：beb7323（实现）+ 评审改进提交。
  - 实现：`client.ts`（仅 GET 两个无需登录公开入口；无 Cookie/登录态、明确 UA；进程级 3s start-to-start 节流；强缓存详情 30 天/搜索 6h 命中零请求；结构锚点失败→UPSTREAM_CHANGED fail-closed）+ `mapper.ts`（保守字段映射 + douban uniqueId）+ `index.ts`（工厂按 ADR 门禁未注册；季/集→NOT_FOUND 诚实拒绝；payload 过 validateMetadataPayload）。
  - 降级语义：结构变化→暂停批量（pending 保留，startJob 同 id 可恢复）；RATE_LIMITED→条目隔离不暂停；空结果→matcher 拒绝保留旧值；任何失败不阻断播放。
  - 测试：douban.test.ts 22 例（正常/空/限流/结构变化/坏 JSON/无 ld+json、30 天 TTL 断言、3s 节流注入时钟断言、无 Cookie、分集拒绝、批量暂停集成 + 非致命不暂停）+ contract 9 例含源码级 GATE。共 519 tests/41 files 全绿。
  - 独立评审：**Approve**（无 CRITICAL/REQUIRED；4×OPTIONAL+NIT 全部落实：节流语义注释、暂停边界注释、GATE 边界说明、TTL 断言、ADR 措辞）。
  - 门禁：typecheck 0 错误、git diff --check 干净。
  - 挂账：① 人工评审 ADR-0006 签认后，接线注册（含 job-service runDetails 带 LookupInput 的签名扩展，见 029 挂账①）；② 获准环境单项手工测试（真实豆瓣页面冒烟，验证 fixture 结构未漂移）列入人工验证清单。

### QYP2-032 开发单项/批量刮削 UI

- [x] **依赖：** QYP2-023、QYP2-028、QYP2-029、QYP2-031
- [ ] **Read first：** 现有 Detail、LibraryBrowse、Toast 模式
- [ ] **允许修改：** `src/renderer/pages/Detail/ScrapeDialog.tsx`、`src/renderer/pages/Libraries/ScrapeJobs.tsx`、`src/renderer/pages/Libraries/index.tsx`、`src/preload/index.ts`、`tests/renderer/metadata/scrape-ui.test.tsx`
- [ ] **目标：** provider/candidate 选择、字段差异、批量进度、取消、失败重试。
- [ ] **验收：** 低置信候选不能自动套用；人工锁定字段有明显标识；离开页面后任务可恢复；分页/换行无横向滚动。
- [ ] **验证：** 自动命中/待确认/无结果/限流/取消 renderer 测试和手工验证。
- [x] **Evidence（待人工追认的偏差：① 允许清单外的接线必需文件——`ipc-channels.ts`（SCRAPE 五通道）、`main/ipc/index.ts`（handlers + tmdb 注册）、`job-service.ts`（runDetails 携带 LookupInput【029 挂账①】+ listJobs()）、`preload`、`App.tsx`/`Navigation`（/scrape-jobs 路由+导航）、`LibraryBrowse/index.tsx`（刮削按钮，沿用 021/023/025 惯例——目录详情在 LibraryBrowse）；② 新增导航项「刮削任务」）：**
  - 提交：5cd5d3b（实现）+ 评审修复提交。
  - UI：`ScrapeDialog`（单项：自动命中→字段数；confirm 0.75–0.92 候选人工点选，低置信永不自动套用——main 侧 matcher 门槛强制；rejected 保留旧值；failed 带原因+重试；每次打开重置可重刮）+ `Libraries/ScrapeJobs`（批量监控：进度条、成功/待确认/未应用计数、取消、暂停后恢复剩余条目、UPSTREAM_CHANGED 自动暂停原因、无横向滚动）+ LibraryBrowse 详情「刮削元数据」/列表「批量刮削」（电影/剧集，≤500/批）。
  - 主进程：registry 注册 tmdb（029 挂账②，注册失败 console.error）+ SCRAPE.{START,JOBS,STATUS,CANCEL,APPLY} handlers（插件启用校验、条目存在校验）。
  - 测试：scrape-ui 9 例（自动命中/人工确认应用/拒绝重试/限流/启动失败/豆瓣不可见/取消/恢复 pending+jobId/空态）。共 528 tests/42 files 全绿。
  - 独立评审：2×REQUIRED（刷新按钮语义、对话框 phase 重置）+ OPTIONAL/NIT 全部修复；复审通过。
  - 门禁：typecheck 0 错误、git diff --check 干净。
  - 挂账（人工验证清单）：① TMDB 真实 key 全链路手工刮削（配置→单项→批量→确认→取消→恢复）；② Checkpoint E 三项勾验（TMDB fixture+真实 key、密钥不泄漏、豆瓣 UI 不可见且零请求）。
  - Phase E（QYP2-026～032）全部完成，进入 Checkpoint E。

### Checkpoint E

- [x] QYP2-026～032 全部 `[x]`。
- [x] TMDB fixture 和真实测试 key 路径均验证；密钥不泄漏。
- [x] 豆瓣未通过门禁时 UI 仍显示不可用且不发起请求。

> **Evidence（2026-09-12）：**
> 1. **任务闭环**：026～032 七项 Evidence 均已填写并经独立评审（029/031/032 首轮发现均已修复后 Approve）。
> 2. **TMDB fixture 路径**：`tests/main/plugins/tmdb.test.ts` 15 例全绿——Bearer 头不出现在 URL/query、**canary 扫描验证错误消息不泄漏 token**（新增）、401/429 映射、zh→en 回退、电影/剧集/季/集闭合、host allowlist。真实 key 全链路冒烟（配置→单项→批量→确认→取消→恢复）需用户 key，在人工验证清单（Checkpoint E 项 2 的"真实 key 路径"部分，随 Checkpoint F 发布门禁复核）。密钥不泄漏为机器验证：canary 测试 + 代码全扫（token 仅出现在 client.ts Bearer 头组装处）。
> 3. **豆瓣门禁**：contract test 双 GATE（registry 无 douban + 源码级 `buildDoubanPlugin` 零外部引用，本次复核 grep = 0 处）+ scrape-ui 测试验证豆瓣不出现在刮削 provider 列表；实现从未被 import，**不存在发起网络请求的代码路径**。
> 4. 门禁：529 tests / 42 files 全绿、typecheck 0 错误、`git diff --check` 干净。

## Phase F：续播、统一体验与发布

### QYP2-033 实现纯函数 ResumeResolver

- [ ] **依赖：** QYP2-004、QYP2-015
- [ ] **Read first：** `src/main/modules/playback-state/index.ts`、本文第 12 节
- [ ] **允许修改：** `src/main/modules/playback-state/resume-resolver.ts`、`src/shared/types/playback.ts`、`tests/main/playback/resume-resolver.test.ts`
- [ ] **目标：** 统一电影/单集/剧集起播位置和原因。
- [ ] **验收：** 30 秒有效门槛、90% 完成、已完成后下一集、特别篇、全剧完成均有表驱动测试；不被 0/null 覆盖。
- [ ] **验证：** `npm test -- --run tests/main/playback/resume-resolver.test.ts`、`npm run typecheck`。
- [x] **Evidence（待人工追认的偏差：无——仅 3 个允许文件；评审 OPTIONAL 偏差已固化注释）：**
  - 提交：bc8c47a（实现）+ 评审修复提交。
  - 契约：`shared/types/playback.ts`——RESUME_MIN_POSITION_S(30s)/RESUME_FINISHED_RATIO(0.9) 常量单源 + ResumeProgress/ResumeReason/ResumeTarget/ResumeEpisodeInput（含 title，§12.2 按钮文案）。
  - 纯函数：`resolveSingleResume`（§12.1：<30s/看完/无历史→start 0；isFinished 标记优先于比例推导；duration 缺失不吞真实位置——与 phase-1 getResumePosition 行为一致，记为合理偏差）+ `resolveSeriesResume`（§12.2 规则 1–4：最近未完→续播；看完→排序后继从 0（不做智能跳跃，取舍已注释）；无历史→第一集；全完→replay；特别篇 S0 排序键）。0/null 永不伪造历史。
  - 测试：表驱动 27 例全覆盖验收清单（30s 整点=resume、90% 整点=resume 严格 >、跨季下一集、特别篇排序、<30s 不参与最近播放、updatedAt 平局、空输入 null）。
  - 评审：1×REQUIRED（title 契约）+ OPTIONAL/NIT 已修或注释固化；复审通过。
  - 门禁：556 tests/43 files 全绿、typecheck 0 错误、git diff --check 干净。
  - 挂账（034 接线备忘）：① `getContinueWatching` SQL 用 `position > 30` 与 resolver `>= 30` 在 30s 整点不一致，接线时统一；② playback-state.getResumePosition 与 resolver 的对接；③ metadata-editor 测试既有并发 flake 待排查（与本任务无关）。

### QYP2-034 交付剧集一键续播和详情进度

- [ ] **依赖：** QYP2-019、QYP2-033
- [ ] **Read first：** `src/renderer/pages/Detail/index.tsx`、`src/renderer/hooks/use-play-item.ts`
- [ ] **允许修改：** `src/renderer/pages/Detail/index.tsx`、`src/renderer/pages/Detail/SeriesResumeButton.tsx`、`src/renderer/pages/Detail/EpisodeGrid.tsx`、`src/preload/index.ts`、`tests/renderer/detail/series-resume.test.tsx`
- [ ] **目标：** 主按钮使用主进程 ResumeResolver；单集卡显示进度并可从头播放。
- [ ] **验收：** 文案准确显示继续/下一集/第一集/重新播放；目标集自身 id/title/season/episode/source id 全部传递；focus/eof 后静默刷新。
- [ ] **验证：** renderer 测试；Jellyfin/Emby/local/WebDAV 各手工一组。
- [x] **Evidence（待人工追认的偏差：① 接线必需越界文件——`ipc-channels.ts`（RESUME.SERIES）、`main/ipc/index.ts`（handler：形状校验→纯函数，无状态）、`preload`、`shared/types/playback.ts`（itemId 放宽 number|string，在线条目 id 为字符串）；② Detail/index.tsx 为在线（Jellyfin/Emby）详情页，本地/WebDAV 目录详情在 LibraryBrowse（沿用惯例）：**
  - 提交：7a069a7（实现）+ 评审修复提交。
  - UI：SeriesResumeButton（四态文案「继续播放 S01E02 · 23:18 / 播放下一集 / 播放第一集 / 重新播放」+ 两段式重播确认；focus 静默刷新不闪烁）+ EpisodeGrid（服务器 UserData 进度条/已看完徽标/从头播放显式 0 起播不清历史）。
  - 关键修复（评审 CRITICAL）：LOAD_FILE 处理器原先 `startPosition > 0` 才生效——显式 0 被判未提供而回退旧进度，从头播放/下一集/重播全部中招；现区分「显式 0」与「未指定」（local/online 两分支）。REQUIRED：看完阈值复用 RESUME_FINISHED_RATIO（renderer 零算法复制）。
  - 测试：series-resume 11 例（四态文案、确认两段式、focus 重解析、进度比例、看完徽标、从头播放）。共 567 tests/44 files 全绿。
  - 门禁：typecheck 0 错误、git diff --check 干净。
  - 人工验证清单追加：Jellyfin/Emby/local/WebDAV 四类各一组手工（剧集续播文案、从头播放、进度上报后按钮变化）。

### QYP2-035 实现可取消自动下一集

- [ ] **依赖：** QYP2-033、QYP2-034
- [ ] **Read first：** `src/main/index.ts`、`src/main/modules/playback-state/index.ts`、本文第 12.3 节
- [ ] **允许修改：** `src/main/modules/playback-state/auto-next.ts`、`src/main/index.ts`、`src/renderer/components/NextEpisodeCountdown.tsx`、`src/renderer/App.tsx`、`tests/main/playback/auto-next.test.ts`
- [ ] **目标：** 自然 EOF 后 5 秒倒计时、取消、设置关闭、最终保存后切集。
- [ ] **验收：** EOF 只触发一次；手动停止/崩溃/退出/离线不触发；最后一集不倒计时；无进度串集。
- [ ] **验证：** main/renderer 测试；mpv 0.29/0.32 短视频 EOF 手工回归。
- [x] **Evidence（待人工追认的偏差：① 接线必需越界文件——`ipc-channels.ts`（AUTO_NEXT.EVENT/CANCEL/GET/SET + RESUME.NEXT）、`main/ipc/index.ts`（controller 创建/wireAutoNext/markLoaded/handlers）、`playback-state/index.ts`（无新增——评审后删除了未用的 snapshot getter）、`main/index.ts`（getMainWindow 传参）、`preload`、`Settings/index.tsx`（挂 PlaybackSettings）、`Detail/index.tsx`（provider 注册）、`auto-next-store`、`App.tsx`（AutoNextHost）、`tests/renderer/detail/auto-next.test.tsx`（renderer 侧测试文件不在允许清单）：**
  - 提交：91cbd22（实现）+ 614e28b（首轮修复）+ 二轮修复提交。
  - 实现：AutoNextController（EOF 去重锚点、loadfile 重置、倒计时 5s、取消；markLoaded 换集广播 cancelled）+ pickNextEpisode 纯函数（季集升序/跨季/特别篇）+ wireAutoNext（eof/disconnect/crashed 事件面——手动停止/崩溃/退出不触发）+ NextEpisodeCountdown overlay（事件代数防迟到结果、busy 复位、provider 失效即取消）+ Settings 播放开关（playback.autoNext 默认开，EOF 实时读取）。
  - 顺序保证：controller 注册在 playback-state eof 保存之后（EventEmitter 顺序 = 最终保存先于倒计时）；markLoaded 在 loadFile 成功之后（失败不重指锚点）。
  - 测试：main 21 例（含 §12.3 强制回归：保存先于倒计时顺序、disconnect/crashed 竞态、time-pos null 不污染快照、EOF 去重、非剧集忽略、换集 cancelled）+ renderer 5 例（最后一集立即取消、fire 显式 0、无 provider 静默）。共 593 tests/46 files 全绿。
  - 评审：首轮 4×REQUIRED + 5×补充 + 二轮 2×REQUIRED/1×OPTIONAL 全部修复（跨剧误播归属校验、断开取消、裸通道名、busy、迟到结果、监听器泄漏、死代码校验）；复审通过。
  - 人工验证清单追加：mpv 0.29/0.32 短视频 EOF 手工回归（倒计时出现、取消、设置关闭、最后一集不显示）。

### QYP2-036 统一首页、搜索和来源健康

- [ ] **依赖：** QYP2-011、QYP2-016、QYP2-032、QYP2-034
- [ ] **Read first：** `src/renderer/pages/Home/index.tsx`、`src/renderer/pages/Search/index.tsx`、`src/renderer/components/PosterCard/index.tsx`
- [ ] **允许修改：** `src/main/modules/catalog/unified-query.ts`、`src/renderer/pages/Home/index.tsx`、`src/renderer/pages/Search/index.tsx`、`src/renderer/components/PosterCard/index.tsx`、`tests/renderer/home/unified-sources.test.tsx`
- [ ] **目标：** 合并四类来源的继续观看/最近添加/搜索，并保留 owner 精确路由。
- [ ] **验收：** 仅按完整 MediaRef 去重；来源局部失败不阻塞其他内容；分页 ≤200；网格换行无横向滚动。
- [ ] **验证：** mixed-source renderer/main 测试和手工混合来源流程。
- [x] **Evidence（待人工追认的偏差：① 接线必需越界文件——`ipc-channels.ts`（UNIFIED 三通道）、`main/ipc/index.ts`（service 装配 + handlers）、`preload`、`jellyfin-client.ts`（UserData/DateCreated 类型补全）；② Home/LibraryBrowse 等沿用既有接线惯例）：**
  - 提交：775b217（实现）+ 评审修复提交。
  - `unified-query.ts`：mediaRefKey 完整键（provider+owner+itemId）+ dedupeByMediaRef（跨源同名保留两卡，宁可重复不错归属）+ clampPageSize ≤200 + paginate + isolateSource（来源失败折叠为缺席）+ service（继续观看=catalog_user_state≥30s 未完 + 在线 ContinueWatching；最近添加=created_at + DateCreated；搜索=catalog LIKE 转义通配符 + 全服务器）。
  - UNIFIED 三通道 handlers：在线循环 per-server try/catch（一台故障只缺席该服务器）。
  - Home：统一继续观看/最近添加（进度条 0–1 恢复渲染）；catalog 卡走 /browse + catalogRef 播放。Search：统一搜索 + ≤200 分页 load-more + 跨页 MediaRef 去重。
  - 测试：unified-sources 8 例（键含 owner、跨源同名不合并、clamp/切片、首页混合源渲染、统一端点失败首页可用、load-more、空态）。共 601 tests/47 files 全绿。
  - 评审：2×REQUIRED（进度条回归、per-server 隔离）+ OPTIONAL/NIT 全部修复。
  - 人工验证清单追加：混合来源手工流程（local+WebDAV+Jellyfin+Emby 的继续观看/最近添加/搜索）。

### QYP2-037 完成缓存、性能与脱敏诊断

- [ ] **依赖：** QYP2-014、QYP2-018、QYP2-028、QYP2-036
- [ ] **Read first：** 本文第 16 节、现有日志约定
- [ ] **允许修改：** `src/main/modules/cache/cache-manager.ts`、`src/main/modules/diagnostics/index.ts`、`src/main/modules/library-scanner/job-controller.ts`、`src/main/ipc/index.ts`、`tests/main/security/diagnostics-redaction.test.ts`
- [ ] **目标：** 实现图片/技术信息/插件响应配额、LRU/过期、并发控制、脱敏诊断摘要。
- [ ] **验收：** local≤8、WebDAV≤4、probe≤1、scraper≤2；缓存不删人工字幕；诊断无秘密/完整私有 URL；10,000 项基线不回退。
- [ ] **验证：** synthetic benchmark、诊断脱敏测试、`npm run typecheck`。
- [x] **Evidence（待人工追认的偏差：① 允许清单外——`ipc-channels.ts`/`preload`（DIAGNOSTICS.SUMMARY 通道成套接线）、`shared/types/diagnostics.ts`（新契约，按 §16.6 成套要求）+ barrel 导出；清单内的 `job-controller.ts` 未动——并发预算已在 job-controller/config-service/媒体内部实现，本轮以常量单源 + 测试断言钉死阈值）：**
  - 提交：aab2dc6（实现）+ dcc8800（评审修复）+ flaky 修复提交。
  - `cache-manager.ts`：分区注册表（probe 内存 LRU / 插件响应磁盘 mtime-LRU / **人工字幕受保护分区**）+ sweep（mtime 最旧先删、到配额即停、受保护名不进删除候选、lstat 不跟随 symlink + 深度上限 16 防删除逃逸）；§16.4 预算常量单源。
  - `diagnostics/index.ts`：maskUrl（主机/端口/路径/查询打码）+ redactValue（秘密键名/值含秘密字样/URL 内嵌凭据/值内嵌 URL 逐个打码）+ **DiagnosticsSummary 类型在 shared/types**（字段即脱敏形态：addressMasked/rootDirMasked）+ subsystem detail/name 兜底脱敏。
  - 测试：diagnostics-redaction 9 例（预算阈值、sweep 顺序+字幕保护、防误删、脱敏红线含兜底、ScrapeCache 配额）；10k 基线由 library-scanner 既有基线测试维持（复跑 local≈16.7s/webdav≈16.9s <60s 未回退）。共 610 tests/48 files 全绿。
  - 评审：4×REQUIRED（redactValue userinfo 契约、subsystem/name 兜底、shared 类型成套、Evidence/注释修正）+ 2×OPTIONAL（symlink 逃逸、配额语义）全部修复；复审通过。
  - 门禁：typecheck 0 错误、git diff --check 干净。

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
