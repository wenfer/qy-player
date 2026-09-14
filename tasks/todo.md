# QY Player 三期执行清单（音乐播放）

> 文档状态：Draft——**三期尚未批准动工**，批准后按依赖顺序领取任务。
> 规划事实来源：`docs/PHASE3-PLAN.md`；ADR-0007 / ADR-0008。
> 规则：一次只领一个任务；先写可失败的测试；Evidence 记录真实命令与结果。

## 待办

### QYP3-001 迁移 007：音乐目录域与歌单表 `[x]`
- 依赖：—
- 内容：music_tracks / music_cue_entries / playlists / playlist_items；
  追加式 migration；upsert 按 (source, path|itemId)；fingerprint 去重
- 验收：migration 测试（v6 fixture → v7）；FK 级联与索引用例
- Evidence: `npm test -- --run tests/main/storage/catalog-migrations.test.ts` → 12 用例全绿（新增音乐表唯一键 + FK 级联 2 例）；version v6→v7 三处断言更新

### QYP3-002 音频后缀白名单 + 本地扫描分类扩展 `[x]`
- 依赖：001
- 内容：classifier 识别音频（AUDIO_EXTENSIONS 23 后缀 + audio 分支 +
  audioInfoOf 文件名启发式：曲目号/「歌手 - 标题」约定）
- 验收：classifier 用例（混排/不受 video 行为影响）；入库在 QYP3-008 前由 003 复用
- Evidence: `npm test -- --run tests/main/library-scanner` → 55 例全绿；全量 640/51

### QYP3-003 WebDAV 音频扫描 `[ ]`
- 依赖：002
- 内容：PROPFIND 音频后缀过滤 + 目录域入库；文件名推断 title/artist
- 验收：webdav fixture 含音频；扫描预算遵守（同 §16.4）
- Evidence：

### QYP3-004 自研标签解析器 `[ ]`
- 依赖：—
- 内容：ID3v2.3/2.4、FLAC（Vorbis comment+picture）、m4a 最小集；
  禁止新增依赖；容错（截断/损坏返回部分结果）
- 验收：真实采样 fixture（mp3/flac/m4a 各≥1）单测全绿
- Evidence：

### QYP3-005 封面提取管线 `[ ]`
- 依赖：004
- 内容：内嵌 picture 优先 → covers/ 缓存分区；mpv 单帧导出兜底 spike
  （0.29/0.32 一致性）；失败占位图
- 验收：spike 记录三格式实机结果；缓存分区注册进 cache-manager
- Evidence：

### QYP3-006 CUE 分轨 `[ ]`
- 依赖：004
- 内容：CUE 解析（TRACK/INDEX 01）→ music_cue_entries；strict：引用
  文件缺失即整张不入库并报告
- 验收：正常/损坏 CUE fixture 用例
- Evidence：

### QYP3-007 音频 probe 扩展 `[ ]`
- 依赖：005
- 内容：media-probe 支持音频（时长/标签/codec/bitrate）；串行预算共用
  （probe≤1 语义不变）
- 验收：0.29/0.32 属性回退表补音频用例
- Evidence：

### QYP3-008 音乐库 UI `[ ]`
- 依赖：003,007
- 内容：「音乐」页（专辑/歌手/全部/收藏网格）；统一搜索接入音频来源
- 验收：页面冒烟 + 搜索合并用例；无横向滚动（1280×800）
- Evidence：

### QYP3-009 引擎选择器（纯函数）`[ ]`
- 依赖：007
- 内容：direct/native 判定表 + 用户偏好（拾音器优先/兼容性优先）+
  服务端转码音频强制 native
- 验收：表驱动测试（格式×偏好×来源 矩阵）
- Evidence：

### QYP3-010 renderer 引擎 `[ ]`
- 依赖：009
- 内容：Web Audio 播放图 + 队列/上下曲/循环（关/全/单）/随机；
  播放失败回退 native 引擎一次
- 验收：状态机单测；AudioContext suspend/resume 页面隐藏行为
- Evidence：

### QYP3-011 mpv 引擎音频参数 + 双引擎状态归一 `[ ]`
- 依赖：009
- 内容：gapless-audio/replaygain 参数；统一 PlaybackState 单点暴露
  （renderer/mpv 两引擎同型）
- 验收：状态归一接口契约测试先行；实机双引擎切换无撕裂
- Evidence：

### QYP3-012 均衡器 `[ ]`
- 依赖：010,011
- 内容：10 频段（预设+自定义），双引擎参数映射；设置持久化
- 验收：映射纯函数单测；实机听感验证记录
- Evidence：

### QYP3-013 迷你控制条 + 快捷键 `[ ]`
- 依赖：010
- 内容：底部常驻条（可折叠）；全局快捷键：上一曲/下一曲/收藏（复用
  shortcut 框架与格式化规则）
- 验收：快捷键冲突 UI 提示；折叠状态持久化
- Evidence：

### QYP3-014 音乐续播 `[ ]`
- 依赖：011
- 内容：进度保存链路对音频生效；**无 30s 阈值**（音乐总是续播）；
  播放计数进 catalog_user_state
- 验收：resume 规则表驱动用例（音乐分支）
- Evidence：

### QYP3-015 歌单 CRUD + UI `[ ]`
- 依赖：001
- 内容：playlists/playlist_items IPC；歌单页（列表/详情/增删/拖拽排序）
- 验收：IPC 契约测试；乐观更新失败回滚用例
- Evidence：

### QYP3-016 m3u/m3u8 导入导出 `[ ]`
- 依赖：015
- 内容：相对路径解析（基准=文件目录）；缺失项占位+导入报告；导出
  m3u8
- 验收：往返一致性 fixture；编码（UTF-8 BOM 兼容）用例
- Evidence：

### QYP3-017 XSPF 导出 `[ ]`
- 依赖：016
- 内容：全来源 URL 化导出；往返测试
- Evidence：

### QYP3-018 LRC 解析器 `[ ]`
- 依赖：—
- 内容：标准/增强（逐字）/多时间标签/偏移量；容错（乱序行、空行）
- 验收：解析用例≥15；纯函数无 IO
- Evidence：

### QYP3-019 内嵌歌词提取 + 歌词缓存分区 `[ ]`
- 依赖：004
- 内容：ID3 USLT/FLAC/m4a 歌词帧；lyrics 分区（受保护，不参与清扫）
- 验收：三容器 fixture；分区注册用例
- Evidence：

### QYP3-020 Jellyfin Lyrics 接入 `[ ]`
- 依赖：019
- 内容：Jellyfin 10.9+ /Audio/{id}/Lyrics；Emby 静默降级；严格 serverId
  路由
- 验收：客户端契约测试；无词→桌面歌词自动隐藏
- Evidence：

### QYP3-021 歌词面板 `[ ]`
- 依赖：018
- 内容：详情页歌词展示（滚动+点击跳转）+ 手动导入 .lrc
- 验收：同步高亮纯函数单测；导入容错 Toast
- Evidence：

### QYP3-022 桌面歌词窗口 `[ ]`
- 依赖：021
- 内容：ADR-0008 全量（窗口/穿透/拖动把手/样式/持久化/ARGB 降级/
  Wayland 隐藏入口）
- 验收：CDP 截图（主屏显示/穿透/拖动/字号）；设置持久化重启恢复
- Evidence：

### QYP3-023 拾音器双模式 `[ ]`
- 依赖：010,011
- 内容：实时频谱（AnalyserNode，fftSize≤2048、≤30fps）+ mpv 引擎播放
  波形 + 模式自动/手动切换 + 设置页
- 验收：帧率与 CPU 采样记录（老机预算）；双引擎切换无缝
- Evidence：

### QYP3-024 Checkpoint F：全量回归/文档/发布 `[ ]`
- 依赖：全部
- 内容：门禁全绿；TARGET-VERIFY 增补音乐项；CHANGELOG 1.2.0；README/
  AGENTS 同步；人工批准后 tag
- 验收：同二期 Checkpoint F 标准
- Evidence：

---

## 纪律提醒（动工前重读）

- 每个任务：`git status --short` 起手；先测试后实现；Evidence 落真实命令。
- 新 IPC 必走 §16.6 四件套 + 测试；migration 只追加。
- 用户偏好：设置页只放软件配置；音乐来源在「媒体库」页管理；拒绝横向
  滚动；中文文案；异步 Toast。
