# 二期任务清单（v1.1.0）

> 计划背景见 `tasks/plan.md`。约定：开工前把任务移到「进行中」，完成打 `[x]` 并附验证方式；每完成一个里程碑跑一次 typecheck + 提交。

## 进行中

（空）

## M1 连续播放与播放队列

### 1.1 播放队列数据结构（主进程）
- [ ] `PlaybackStateManager` 增加队列概念：`queue: MediaQueueItem[]`、`queueIndex`；`MediaQueueItem` = MediaContext + streamUrl + headers + 所在 mediaId
- [ ] `load-file` IPC 扩展：接受可选 `queue` 数组；保持单文件调用向后兼容
- [ ] 验证：单文件播放路径行为与一期完全一致（回归用 Local 页 + Emby 直连各放一个）

### 1.2 下一集解析（服务器侧）
- [ ] JellyfinClient/EmbyClient 增加 `getNextEpisode(seriesId, seasonNumber, episodeNumber)`：按 Season/Episode 排序取下一个，跨季时先取下一季第一集
- [ ] 主进程解析结果预取 streamUrl（元数据级，**不预加载视频流**）
- [ ] 验证：跨季边界（S01E10 → S02E01）正确；最后一集返回 null

### 1.3 自动连播
- [ ] mpv eof 事件 → 若队列有下一集：主进程经 preload 发 Toast/对话框「15s 后自动播放：S02E01 · 标题」，可取消
- [ ] 取消/超时：取消 = 停在结果页；超时 = 保存当前进度 → loadfile 下一集（顺序不能反，防进度串集）
- [ ] 播放窗口内显示「下一集」按钮（`PlayerControls`）
- [ ] 验证：连播 3 集（含跨季），检查本地 `watch_history`/`playback_progress` 每集记录正确，服务器 Progress 同步无串集

### 1.4 快捷键与托盘语义
- [ ] MediaNextTrack/MediaPreviousTrack：有队列 → 上一集/下一集；无队列 → 快退/快进 30s（一期行为）
- [ ] 托盘菜单加「上一集/下一集」（无队列时禁用态）
- [ ] 快捷键页描述文案同步更新
- [ ] 验证：两种模式切换触发正确，托盘禁用态可见

## M2 播放器控制完善

### 2.1 音轨/字幕选择
- [ ] IPC：`player:set-track(type: 'audio'|'sub', id)` → mpv `set_property('aid'/'sid', id)`
- [ ] 播放中面板：列出 `get-tracks` 结果（音轨名/语言、字幕名），当前项高亮，支持「关闭字幕」
- [ ] 验证：多音轨mkv切换不卡顿；外挂+内嵌字幕混播切换正确

### 2.2 倍速播放
- [ ] mpv `set_property('speed', x)`；播放窗口底部弹出速率选择（0.5/0.75/1/1.25/1.5/2）
- [ ] `[`/`]` 快捷键降/升一档，`Backspace` 回 1.0x（加入 MPV_BINDINGS 可录制）
- [ ] 验证：1.5x 连续播放 10 分钟无音画漂移（软解机器上实测）

### 2.3 截图增强
- [ ] 设置页新增「播放器」组：截图目录（目录选择对话框）、格式（png/jpg）
- [ ] mpv `screenshot-format`/`screenshot-directory` 属性按配置注入
- [ ] 截图成功 Toast 显示保存路径
- [ ] 验证：自定义目录生效，中文路径无乱码

## M3 媒体库体验

### 3.1 继续观看行
- [ ] Home 顶部新行：本地 `progress:get-continue` + 服务器 `get-continue-watching` 合并（按 mediaId 去重，本地优先）
- [ ] 海报卡显示剩余进度条；看完的条目自动消失（progress >= 95% 视为看完）
- [ ] 验证：播放 5 分钟的剧集出现在行内且进度正确；播完消失

### 3.2 收藏
- [ ] client 增加 `setFavorite(itemId, fav)`（Emby 路径 `/emby/Users/{u}/Favorite/{id}`）
- [ ] PosterCard 角标 + Detail 页心形按钮，乐观更新失败回滚
- [ ] 验证：网页端与本地状态互相同步

### 3.3 历史页增强
- [ ] 分页（20/页）+ 类型筛选（全部/电影/剧集）
- [ ] 条目点击 → `use-play-item` 从 `position` 续播
- [ ] 验证：老记录（无季集信息）也能续播

### 3.4 设置页扩展
- [ ] 播放参数组：音量步进（1–10，注入 mpv volume 步进参数）、启动恢复上次活动服务器
- [ ] 全部走 `settings:get/set`（`app_config`），不新增 IPC 通道
- [ ] 验证：重启后配置保留并生效

## P2（时间允许）

- [ ] 检查更新：GitHub Releases API 比对 semver，Toast 提示 + 打开 Release 页链接
- [ ] 音乐库：LibraryBrowse 支持 Audio 类型列表播放
- [ ] 章节跳转：详情有 Chapters 时播放窗口显示章节列表，点击 seek 到章节起点

## 收尾

- [ ] bump `package.json` → 1.1.0
- [ ] README 更新（连播/收藏/倍速等新特性 + 截图）
- [ ] `npm run typecheck` 通过，打 tag `v1.1.0`，确认 Actions 出包、Release 发布

## 已知遗留（一期，不在二期范围但记录在案）

- [x] ~~进度在 seek 后关闭丢失~~（`382d86f` 已修）
- [ ] 老格式记录（position 0、空季集字段）播放后自动补全（upsert COALESCE 已覆盖，观察即可）
