# ADR-0001: 统一 MediaRef、Catalog Schema 与旧进度迁移

- 状态: Proposed（人工批准后转 Accepted）
- 日期: 2025-01（二期 Phase A）
- 关联: `tasks/plan.md` §4.1、§5、§18；任务 QYP2-002 / QYP2-003 / QYP2-004

## 背景

一期以 `mediaType + itemId` 二元组定位媒体：`mediaType ∈ local|jellyfin|emby`。该模型在二期引入本地目录库与 WebDAV 后失效：

1. **所有者歧义**：多个 Jellyfin/Emby 服务器或多个本地/WebDAV 来源可能出现相同 item id / 相对路径，仅凭 id 无法确定数据归属（plan §18「多服务器 item id 冲突」风险）。
2. **可变主键**：一期本地记录使用绝对路径作为业务键；文件重命名/挂载点变化即失去关联。
3. **旧表约束死锁**：`playback_progress.media_type` 的 CHECK 只含旧三种类型，直接放宽属于修改已发布 migration，被 plan §5 禁止。

## 决策

### D1 — MediaRef 携带所有者

```ts
type MediaRef =
  | { provider: 'catalog'; sourceId: number; itemId: string }   // 本地/WebDAV 目录域
  | { provider: 'jellyfin' | 'emby'; serverId: number; itemId: string };
```

- renderer 一律提交 `MediaRef`，禁止提交真实路径、URL 或删除目标。
- 数据库层用 `(source_id, item_id)` 复合唯一键承载 `catalog` 分支；在线服务沿用 `server_id + item_id` 精确路由。

### D2 — Catalog 使用稳定 opaque id，路径只作数据列

`catalog_items.id` 使用自增/生成的 opaque id 作为长期主键；`source_key`（来源内相对路径或规范化标识）是 `(source_id, source_key)` 唯一键下的**数据列**，用于同一来源内的增量识别与重命名检测。未确认"重命名"前，绝不用可变路径顶替主键。

### D3 — 目录域新表 + 旧表保留

按 plan §5 追加 `library_sources`、`catalog_items`、`catalog_files`、`catalog_streams`、`catalog_user_state` 等新表；不修改 migration 001–004，不放宽旧 CHECK。

### D4 — 旧进度幂等迁移，仅在被触发时执行

- 旧 `playback_progress`（`media_type='local'`）记录在用户挂载包含该旧路径的本地来源时才迁移到 `catalog_user_state`。
- 迁移键为文件 realpath/size/mtime 的最佳匹配；新旧记录冲突时取 `updated_at` 较新且有效者。
- 迁移**成功回读验证前不删除旧记录**；重复执行必须稳定（幂等）。
- 旧表永不删除，作为回滚兜底。

## 备选方案（已否决）

| 方案 | 否决原因 |
|---|---|
| 全局字符串 id（`local:/path/to/file` 拼接） | 将可变路径编码进身份，重命名/挂载变化即断链；与 D2 目标冲突 |
| 放宽旧 `media_type` CHECK 加 `webdav` | 等于修改已发布 migration，违反 plan §5 |
| 每种来源独立表 | 查询统一层（unified-query）被迫 UNION 四套 schema，UI 分支回潮（plan §1.3 要修复的结构性问题） |
| 迁移时一次性清空旧进度表 | 违反"成功前不删除"安全线；失败即数据丢失 |

## 后果

- 正面：来源可扩展（未来加 provider 只加枚举分支）；进度/历史可跨重命名存活；多来源同 id 不串库。
- 负面/成本：renderer 与主进程的既有 `mediaType+mediaId` 调用点需在 QYP2-011/015 逐步切换；过渡期两套标识并存，必须由 PlaybackResolver 统一收口（QYP2-015）。
- 中立：`catalog` 分支的 `sourceId` 对应 `library_sources.id`，来源删除后其 catalog 记录级联失效（FK ON DELETE 策略在 QYP2-003 migration 中落实）。
