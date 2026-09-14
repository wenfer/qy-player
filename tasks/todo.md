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

### QYP3-003 音频扫描入库（本地 + WebDAV）`[x]`
- 依赖：002
- 内容：local-scanner audio 分支——标签优先（readAudio 钩子，本地挂
  fs 头部 512KiB；WebDAV 不挂 → 文件名启发式）；目录启发式
  （父目录=专辑、上上级=歌手）；music_tracks 自持指纹基线（不混
  catalog_files）；repository.upsertMusicTrack（owner_key 单键 upsert）
- 验收：本地标签入库（has_cover/has_lyrics/duration）+ 文件名兜底 2 例
- Evidence: local-scan.test 36 例全绿；全量 648/52

### QYP3-004 自研标签解析器 `[x]`
- 依赖：—
- 内容：ID3v2.3/2.4（UTF-16/UTF-8/latin1 四编码、USLT/APIC）、FLAC
  （STREAMINFO 时长+Vorbis comment+Picture）、m4a（ilst 最小集+mvhd
  时长）、APEv2 只读；合成合法 fixture 7 个；截断/垃圾/无标签容错
- 验收：6 用例全绿（三容器+容错+文件名兜底合并）
- Evidence: `npm test -- --run tests/main/library-scanner/tag-parser.test.ts`
  → 6/6；全量 646/52；调试修复点：帧头推进量、vorbis LE 长度、
  STREAMINFO 64bit 拆分、mvhd payload 偏移

### QYP3-005 封面提取管线 `[x]`
- 依赖：004
- 内容：cover-service——extractCoverBytes（ID3 APIC/PIC/FLAC PICTURE/
  m4a covr 三容器头部缓冲解析）+ saveCoverFromTags（落
  <coversDir>/<trackId>.<ext>）+ registerCoversPartition（64MiB 可清扫，
  派生数据可再生成）+ exportCoverWithMpv（懒执行兜底，15s 硬顶超时）
- 接线：扫描 readAudio 后顺手落盘（失败静默）；covers 分区注册
- 验收：5 用例（三容器提取/容错/落盘+分区/无图 null）全绿
- Evidence: cover-service.test 5/5；全量 653/53；mpv 导出 0.29/0.32
  一致性属实机 spike 项（TARGET-VERIFY 补记）

### QYP3-006 CUE 分轨 `[x]`
- 依赖：004
- 内容：cue-parser 纯函数（MM:SS:FF→秒、相邻区间闭合、乱序排序、
  无 INDEX 跳过、无 TITLE 回退 Track n）+ strict 校验（引用音频缺失
  = 整张不入库）+ 扫描接线（readText 钩子：本地 fs / WebDAV 64KiB
  bounded GET；basename→relativePath 解析）+ repository.
  replaceMusicCueEntries（整体替换幂等）
- 验收：cue-parser 5 例 + 扫描集成 2 例（存在→分轨入库；缺失→跳过）
- Evidence: cue-parser.test 5/5；local-scan.test 38/38；全量 660/54

### QYP3-007 音频 probe 扩展 `[x]`
- 依赖：005
- 内容：probe 属性回退表补 audio.bitrate（audio-params/bitrate →
  audio-bitrate → demux-bitrate，0.29/0.32 兼容机制不变）；track-list
  音频轨补 demux-bitrate；MediaProbeInfo.audio / MediaTrackInfo 加
  bitrate 可选字段；probe≤1 串行预算语义不变（音频与视频同队列）
- 验收：spike 用例断言 bitrate 贯通（result.audio + track）
- Evidence: media-probe 30 例全绿；全量 660/54

### QYP3-008 音乐库 UI `[x]`
- 依赖：003,007
- 内容：「音乐」页（专辑网格 + 专辑曲目列表 + 全部曲目，1280×800 无
  横向滚动，flex-wrap 网格）；qy-file:// 封面协议（covers 目录白名单
  正则 + resolve 包含校验，Electron 21 registerFileProtocol）；
  repository.listMusicAlbums / listAlbumTracks / listMusicTracksPaged
  （页 ≤200 §16.4）；MUSIC.GET_ALBUMS/GET_ALBUM_TRACKS/GET_TRACKS
  IPC 四件套
- 收藏/歌手视图与统一搜索接入 → P1（QYP3-008a，随 Checkpoint B 回补）
- 验收：repo 聚合用例 + 渲染 3 例；CDP 实机（专辑网格/曲目列表/空态）
- Evidence: catalog-migrations 13 例；music-library.test 3 例；全量 664/55

### QYP3-009 引擎选择器（纯函数）`[x]`
- 依赖：007
- 内容：playback-engine/engine-selector.ts——服务器→mpv（认证头）、
  WebDAV→mpv（同因，能力地图修正）、转码→mpv、CUE→mpv、
  compat-first→mpv；spectrum-first（默认）下 Chromium 直连格式
  （DIRECT_CODECS 保守清单：mp3/aac/flac/ogg/opus/wav/m4a/webm）→
  WebAudio，未知/缺失 codec 永远降级 mpv（不误判 direct）
- 验收：8 表驱动用例（格式×偏好×来源矩阵）
- Evidence: engine-selector.test 8/8

### QYP3-010 renderer 引擎 `[x]`（图+队列；UI 接线与失败回退归 011/013）
- 依赖：009
- 内容：renderer/player/web-audio-engine——播放图单次构建
  （Element→MediaElementSource→Analyser(fftSize 2048)→Biquad×10→
  Gain→out，换曲只换 src）+ PlaybackQueue（repeat off/all/one、
  shuffle 排列语义、jumpTo）+ EQ/音量/seek/频谱快照接口；
  qy-file://audio/<sourceId>/<relpath> 协议桥（audio-url.ts 注册式
  解耦，LocalSourceAdapter.resolveInside 双层包含校验；WebDAV/服务器
  音频不进 renderer 引擎）
- 验收：13 例（队列语义 + 图构建/事件/EQ/音量/频谱 null 安全）
- Evidence: web-audio-engine.test 13/13（两轮全量稳定）

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
