# ADR-0006: 豆瓣数据入口评估与发布门禁

- 状态：Proposed（QYP2-030 门禁产出；**人工产品/法律/技术评审通过前，豆瓣插件保持「已内置但不可启用」**）
- 日期：2026-09-11
- 相关：计划 §2（红线）、§11.4（豆瓣内置插件）、§16.4（速率预算）、QYP2-030、QYP2-031；ADR-0001（`catalog_external_ids` 表含豆瓣 provider）

## 背景

二期计划包含「豆瓣」元数据 provider（计划 §1、§3 能力图 `scraper-douban`）。计划同时设了硬性红线（§2）：

> 不绕过豆瓣风控，不接入来源不明的"豆瓣 API"；
> 豆瓣数据路径需要绕过登录、验证码、访问限制或使用来源不明的第三方 API 时，整任务 BLOCKED。

§11.4 进一步规定：实现前必须先记录数据入口、服务条款、授权方式、速率和字段范围；若发布门禁未通过，插件保持「已内置但不可启用」。

本 ADR 即该「先确认」步骤：逐条评估可行数据入口，给出批准/拒绝理由，并把结论固化成可被 contract test 检查的契约（`src/main/plugins/douban/types.ts` + `tests/fixtures/douban/`）。

## 数据入口评估

### 入口 ①：豆瓣官方开放 API（developers.douban.com，/v2/movie/*）— **拒绝（不可获得）**

- 豆瓣自 2017 年起停止接受新的 API 应用申请，开发者平台不再发放 API Key；历史文档页面已下线或仅存档。
- 无法为 qy-player 用户取得合法授权凭证；让用户各自申请也不可能（不开放申请）。
- 结论：**拒绝**。理由不是条款不允许，而是入口客观不存在。

### 入口 ②：来源不明的第三方「豆瓣 API」— **拒绝（计划红线）**

- 社区存在多种非官方反代、爬虫聚合、付费代理服务，声称提供豆瓣数据。
- 计划 §2 红线明令禁止：来源不明、不可审计、随时可能消失、可能注入错误甚至恶意数据，且法律风险不可控。
- 结论：**拒绝，不评估任何变体**。此拒绝不依赖人工评审，是永久性约束。

### 入口 ③：模拟登录 / 处理验证码 / 伪造会话 — **拒绝（计划红线，永久）**

- §11.4 明令禁止模拟登录、处理验证码、伪造用户、绕过限制。
- 结论：**拒绝，永不评估**。与入口 ② 同为红线级。

### 入口 ④：读取无需登录的公开页面（movie.douban.com）— **有条件批准（实验性，默认关闭）**

技术事实：

- `movie.douban.com/j/subject_suggest?q=` 是条目页搜索框自用的 JSON 端点，无需登录即可访问，返回结构稳定的候选列表（`id/title/sub_title/year/url/type/img`）。
- 条目详情页（`movie.douban.com/subject/{id}/`）内嵌 `<script type="application/ld+json">`（schema.org Movie/TVSeries 词表），无需解析脆弱的 HTML 布局即可取到名称、海报、类型、上映日期、导演、主演、评分。
- 两者的**结构锚点**（必需字段/标记）可固化为机器可查契约，上游一变即 fail-closed（`UPSTREAM_CHANGED`），详见下节。

合规事实与风险（须人工评审确认）：

- 豆瓣 robots.txt 与服务条款对自动化访问有限制性表述；未经人工法律评审，本项目**不宣称**该路径合规。
- 风险缓解（若批准）：限速 ≥3s/请求（低于计划 §16.4 scraper ≤2 并发，实际豆瓣走 1）、强缓存（条目详情 TTL 30 天，命中即零请求）、仅 GET、不携带任何登录态/Cookie、明确 UA 标识应用版本。

结论：**有条件批准为实验路径**——

1. 插件 manifest 标记实验性，设置页固定显示「实验性」徽标，默认**关闭**；
2. 上线前置条件：人工产品/法律/技术评审三方签认（本 ADR 状态从 Proposed → Accepted）；
3. 未签认前：豆瓣插件**不注册进 registry**（无 plugin factory、无启用开关），用户不可启用；
4. 实现（QYP2-031）必须满足 §11.4 全部降级条款：结构变化 → `UPSTREAM_CHANGED` 并暂停批量任务，绝不用空结果覆盖目录；限流 → `RATE_LIMITED` 退避重试；任何失败不阻断播放。

## 结构契约（离线可检测）

`src/main/plugins/douban/types.ts` 固化：

- 端点常量与 host allowlist：API host 仅 `movie.douban.com`；图片 host
  预留 `*.doubanio.com`（suggest/JSON-LD 的 `img` 字段指向该域，仅限海报
  URL 读取，QYP2-031 接线时注册进 allowlist）；
- `DoubanSuggestItem` / `DoubanDetailLd` 响应形状类型 + 必需字段锚点常量；
- 纯函数校验器（`validateDoubanSuggestPayload` / `validateDoubanDetailLd`），偏差即返回 `UPSTREAM_CHANGED` 语义的结构问题列表。

`tests/fixtures/douban/` 提供合成 fixture（**非真实抓取内容**，结构按上述文档化锚点手写，JSON 以同目录 README.md 声明合成来源，HTML 有内嵌注释声明），contract test 用校验器离线检测结构变化：豆瓣改版时只需更新 fixture，且锚点不匹配会大声失败，而非静默返回空数据。

## 后果

- QYP2-031 在上述契约上实现安全降级路径；实现本身也仅在评审签认后才可注册启用（registry 无 douban 条目是门禁的一部分，contract test 防回归）。
- 若人工评审否决入口 ④：删除 types.ts 中的实验契约与 fixture，ADR 状态改为 Rejected，`catalog_external_ids` 不落 `douban` provider——不留下"看似可用"的死代码。
- 本 ADR 不引入任何新运行时依赖。
