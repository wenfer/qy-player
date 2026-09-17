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
- 收藏/歌手视图与统一搜索接入 → QYP3-008a（已完成，见下）
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

### QYP3-011 双引擎状态归一 + 回退链 `[x]`（mpv 音频参数 gapless/replaygain 归 013 设置接线）
- 依赖：009
- 内容：resolver music 分支（provider='music'，MediaRef 扩展 + 校验）：
  引擎判定单源 + engineForce:'mpv'（回退路径）+ music-direct 分支
  （qy-file://audio URL）；music-playback-store（renderer 侧单点归一：
  webaudio 本地驱动 / mpv 走 playerLoadFile 管线，重复点击 playToken
  竞态防护，direct 失败 → fallbackToMpv 一次）；HOME/Search 导航
  provider 窄化修复
- 实机验证全链：点击曲目 → resolve（engine=webaudio direct-codec）→
  qy-file 协议（containment/CSP/手工 URL 解析三处实修）→ WebAudio
  播放 → 迷你控制条 → 进度上报（≤10s + isFinished）→ playback_progress
  position/duration 落库 + watch_history 入库
- 验收：全量 685/57；实机 DB 查证 progress/history 双落
- Evidence: /tmp/qy-run10 系列日志 + DB 查询记录

### QYP3-012 均衡器 + mpv 音频参数 `[x]`
- 依赖：010,011
- 内容：equalizer.ts 契约单源（10 频段、7 预设、sanitize 限幅
  ±12dB）；双引擎映射——renderer 直连 BiquadFilter（store 起播读
  playback.eqGains），mpv 映射 lavfi equalizer 链（lowshelf/peaking/
  highshelf 对应，平直=不挂滤镜）；mpv --gapless-audio=weak（spawn）
  + ReplayGain（replaygain 属性）；视频加载复位 af（跨 loadfile
  持久语义）
- 设置 UI：设置→音乐（引擎偏好/ReplayGain/均衡器预设+10 滑条，
  实时保存）
- 验收：契约单测 5 例；CDP 实机（预设落库 [7,6,4,2,...]）
- Evidence: equalizer.test 5/5；全量 690/58；实机设置区截图+DB 查证

### QYP3-013 全局迷你条 + 媒体键双用途 `[x]`（收藏快捷键归 P1——catalog_user_state music 收藏未接）
- 依赖：010
- 内容：MusicMiniBar 全局常驻（App 层，可折叠为悬浮圆钮，进度条 +
  上下曲/播放暂停）；媒体键双用途——main 侧 music-active 桥（renderer
  webaudio 起播/停止上报 SET_ENGINE_ACTIVE），MediaPlayPause/Next/
  PreviousTrack 在音乐激活时转发 ON_COMMAND → store 单点处理，
  否则保持 mpv 视频/音频语义
- 验收：设置区 CDP 实机；快捷键冲突 UI 由既有框架覆盖（Media 键 fixed）
- Evidence: 全量 690/58；构建三产物绿

### QYP3-014 音乐续播 `[x]`（播放计数 catalog_user_state 归 P1，暂用 watch_history）
- 依赖：011
- 内容：resolveMusicResumeTarget 纯函数（无 30s 阈值，>90% 从头重播）；
  MUSIC.REPORT_PROGRESS 上报通道（validation + upsertLocalMedia +
  watch_history + saveProgress 双落）；renderer 引擎节流上报；
  扫描收尾 deleteMusicTracksNotSeen 清理消失音轨（CUE 键保护）
- 验收：实机 DB progress/history 双落；清理回归（删文件→重扫→行消失）
- Evidence: resume-resolver 纯函数 + 实机验证记录

### QYP3-015 歌单 CRUD + UI `[x]`（拖拽排序 → P1，先上/下移按钮）
- 依赖：001
- 内容：repository CRUD（create/rename/delete/list/listItems/add/
  remove/reorder——remove 后 position 重排，reorder 事务整移）；
  item_ref 契约 music:<sourceId>:<trackId> + isPlaylistItemRef 校验；
  PLAYLIST.* 11 通道 + preload；/playlists 页（列表卡片 + 详情列表 +
  新建/重命名/删除 + 上/下移乐观更新失败回滚 + 点行播放进队列）
- 实机修复：COALESCE 别名错（NaN→NOT NULL）、res 未定义、
  channel 命名契约（无数字段）
- 验收：CDP 实机（建/加/排序/移除往返全通）；698/59 全绿
- Evidence: /tmp/pm/playlists_ui.png + pl2 日志

### QYP3-008a 收藏 / 歌手视图 + 统一搜索接入音乐 `[x]`
- 依赖：008
- 内容：音乐页四视图（专辑 / 歌手 / 全部曲目 / 收藏）；歌手聚合
  （listMusicArtists + listArtistAlbums）；收藏标记落 music_tracks
  （migration 008：catalog_user_state 的 item_id 外键指向 catalog_items，
  音乐条目不在该域内）；收藏切换乐观更新 + 失败回滚；统一搜索接入
  music_tracks（provider='music'，搜索页跳转 /music）
- 验收：歌手/收藏/搜索用例
- Evidence: `tests/main/catalog/music-catalog.test.ts` 5/5（歌手聚合/
  单歌手专辑/收藏开关/搜索字面量/统一搜索含音乐卡）；
  `tests/renderer/music/music-views.test.tsx` 4/4（歌手下钻/收藏乐观
  移除/失败回滚/全部曲目收藏）

### QYP3-012a 均衡器自定义预设 `[x]`
- 依赖：012
- 内容：内置 7 预设 + 自定义预设（命名保存/应用/删除），存
  app_config `playback.eqPresets`；parseEqPresets 只接受结构合法条目；
  整表覆盖写 + 失败回滚
- 验收：预设编辑用例
- Evidence: `tests/renderer/settings/eq-presets.test.tsx` 6/6（脏数据
  拒绝/内置与自定义同列/应用写 eqGains/保存/空名重名拦截/删除）

### QYP3-013a 收藏快捷键 `[x]`
- 依赖：008a
- 内容：GLOBAL_SHORTCUTS 新增 favoriteCurrent
  （默认 CommandOrControl+Shift+F）；音乐激活时转发 ON_COMMAND
  'favorite'（视频播放静默无操作）；迷你条爱心按钮共用同一实现
  （用 ref 规避挂载时闭包过期）
- 验收：快捷键路由用例
- Evidence: `tests/main/ui-shell/shortcuts-music.test.ts` 3/3（注册/
  仅音乐激活时转发/未激活保持 mpv 语义）

### QYP3-015a 歌单拖拽排序 `[x]`
- 依赖：015
- 内容：条目可拖拽（HTML5 DnD：dragstart/dragover/drop + 手柄提示 +
  拖起半透明/悬停描边），与既有上/下移按钮共用 moveItem（from→to
  整移，乐观重排 + 失败回滚）；按钮保留作键盘/触屏兜底
- 验收：拖拽排序用例
- Evidence: `tests/renderer/music/playlist-drag.test.tsx` 3/3（拖拽到
  位/失败回滚/按钮兜底）

### QYP3-016 m3u/m3u8 导入导出 `[x]`
- 依赖：015
- 内容：playlist-io.ts 纯函数——parseM3u（BOM 容错/EXTINF 标题）+
  resolveM3uLocation（基准=文件目录）+ matchM3uLocationToTrack
  （精确→basename 唯一→后缀唯一，歧义不猜）+ importM3u（未定位行
  计入报告绝不静默丢失）；导出相对化（导出目录基准）+ WebDAV URL
  （凭据不内嵌）；导入走文件对话框，导出走保存对话框
- 验收：8 用例（解析/基准/匹配/报告/往返）
- Evidence: playlist-io.test 8/8

### QYP3-017 XSPF 导出 `[x]`
- 依赖：016
- 内容：exportXspf（1.0 规范最小集：title/creator/location/meta
  qy:trackId + XML 转义）；本地项 file:// URL-encode；WebDAV URL
- 验收：转义/编码用例（含 evil 字符）
- Evidence: playlist-io.test 覆盖

### QYP3-018 LRC 解析器 `[x]`
- 依赖：—
- 内容：标准/增强（逐字）/多时间标签/偏移量；容错（乱序行、空行）
- 验收：解析用例≥15；纯函数无 IO
- Evidence: `lrc-parser.test` 19/19（标准/增强逐字/多标签/offset/
  容错/排序 + findCurrentLine 同步纯函数）；typecheck 双配置绿

### QYP3-019 内嵌歌词提取 + 歌词缓存分区 `[x]`
- 依赖：004
- 内容：ID3 USLT/FLAC/m4a 歌词帧（004 已解析）；lyrics 分区（受保护，
  不参与清扫）；`saveLyricsFromTags`/`readLyricsCache`/`registerLyricsPartition`；
  扫描 readAudio 后透传落盘 `<lyricsDir>/<trackId>.lrc`；MUSIC.GET_LYRICS
- 验收：三容器 fixture；分区注册用例
- Evidence: cover-service.test 6/6（落盘 + 受保护分区清扫 0 删）；
  local-scan.test 39/39（扫描期歌词落盘内容断言）；全量绿
- 遗留：WebDAV 源无 readAudio 钩子 → 歌词仍待"下载后"方案（P2）

### QYP3-020 Jellyfin Lyrics 接入 `[x]`（客户端契约；UI 接线待服务器音乐浏览）
- 依赖：019
- 内容：Jellyfin 10.9+ `/Audio/{id}/Lyrics`（ticks 起点）；Emby 无端点
  → 覆盖返回 null（不发请求）；404/空数组 → null（无词，桌面歌词隐藏）
- 验收：客户端契约测试；无词→桌面歌词自动隐藏
- Evidence: `tests/main/online/lyrics.test.ts` 4/4（端点/空词/404/Emby
  静默降级）
- 阻塞：UI 接线待 020b——歌词面板/桌面歌词目前按本地 trackId 读歌词缓存，
  服务器曲目需 `{serverId, itemId}` 路由的新 IPC（025 已铺好服务器曲目队列，
  端点本身可用）

### QYP3-021 歌词面板 `[x]`
- 依赖：018
- 内容：迷你条「词」开合 LyricsPanel——GET_LYRICS 读词 + parseLrc +
  findCurrentLine 同步高亮 + 自动滚到当前行 + 点击行 seek + 手动导入
  .lrc（MUSIC.IMPORT_LYRICS：文件对话框 → lyrics 分区，成功 Toast）
- 验收：同步高亮纯函数单测；导入容错 Toast
- Evidence: `tests/renderer/music/lyrics-panel.test.tsx` 4/4（高亮/跳转/
  空态/导入成功与失败不替换）；typecheck 绿
- 范围：面板在 webaudio 引擎激活时可用（迷你条同源）

### QYP3-022 桌面歌词窗口 `[x]`（实机 ARGB 验证待 TARGET-VERIFY）
- 依赖：021
- 内容：ADR-0008——独立 BrowserWindow（透明/无框/置顶/不进任务栏/不可缩放）；
  锁定=鼠标穿透 `setIgnoreMouseEvents(true,{forward:true})`，解锁才可拖动
  （穿透窗口收不到 mousedown，故"拖动=临时关穿透"）；两行式渲染 + 逐字
  渐变填充；无词/暂停自动 hide；位置/字号/锁定存 app_config
  （deskLyrics.pos/.fontSize/.locked）；Wayland 会话直接不支持并 Toast 提示；
  状态推送 ≤10Hz（music-playback-store onTime 节流 100ms，main 转发）
- 验收：CDP 截图（主屏显示/穿透/拖动/字号）；设置持久化重启恢复
- Evidence: `tests/main/ui-shell/desk-lyrics.test.ts` 6/6（窗口形态/穿透切换/
  显隐/位置回调/单窗口复用/Wayland 不支持）；`tests/renderer/music/
  desk-lyrics.test.tsx` 3/3（当前行+下一行/暂停无词空渲染/字号）
- 待实机：GNOME 下 ARGB 透明是否生效（黑底则走不透明降级 + 设置页提示）、
  拖动与穿透矩阵（GNOME/KDE/Xfce）——已列入 TARGET-VERIFY
- 范围：由 webaudio 引擎驱动（与歌词面板同源）；mpv 引擎曲目暂无位置源

### QYP3-023 拾音器双模式 `[x]`（帧率/CPU 与渐变实机待验证）
- 依赖：010,011
- 内容：renderer 引擎 AnalyserNode 实时频谱（fftSize 2048、30fps 上限、
  48 柱峰值抽样）+ mpv 引擎播放波形（waveformAmplitude 确定性包络，
  按 时长+进度 上色，无缓存无外部依赖）+ 模式切换（auto/spectrum/
  waveform/off，存 `playback.visualizer`）+ 设置页 + 迷你条内嵌
- 验收：帧率与 CPU 采样记录（老机预算）；双引擎切换无缝
- Evidence: `tests/renderer/music/visualizer.test.tsx` 2/2（包络纯函数
  有界/确定性/中间高 + 无 2D 上下文静默降级）；typecheck 绿
- 待实机：30fps 下的 CPU 占用采样（老机）、mpv 引擎切波形是否跳变——
  已列入 TARGET-VERIFY

### QYP3-025 服务器音乐库浏览与播放 `[x]`
- 依赖：011, 015
- 背景：music 目录域此前只有本地/WebDAV（`pickMusicLibraries` 无入口），
  服务器音频既看不到也播不了，连带 020 的 Lyrics 端点无处可接
- 内容：音乐页顶部「来源」切换（本地/WebDAV + 每个服务器的音乐库视图）；
  `server-music.ts` 纯映射层（`pickMusicLibraries` 只认
  `CollectionType=music` 且跳过加载失败的服务器；`mapServerAlbums`/
  `mapServerTracks` 容错缺字段、RunTimeTicks→秒）；`ServerMusicBrowser`
  专辑网格→曲目列表→播放；store 扩展 `MusicTrackInput.serverId/provider/
  itemId`、`refOfTrack`（服务器曲目严格按 serverId 路由）、`serverQueue/
  serverIndex` + `playServerAt`，mpv 引擎的 next/prev 在服务器队列内推进
  （队尾 stop 而非回卷）
- 验收：服务器专辑/曲目映射单测；播放走 mpv 且上下曲在队列内推进；
  未登录/非音乐库不出现入口
- Evidence: `tests/renderer/music/server-music.test.ts` 7/7（视图筛选/容错/
  ticks 换算）；`tests/renderer/music/server-music-browser.test.tsx` 4/4
  （来源只列音乐库、专辑→曲目→播放 mpv 且 resolvePlayback 按 serverId
  路由、next/prev 队列内推进、队尾 stop）；typecheck 双配置 + 全量绿
- 服务器曲目无本地歌词缓存 → 切曲清空 currentLyrics（避免桌面歌词残留
  上一首）；接服务器歌词见 020b

### QYP3-026 mpv 引擎音乐控制条 + 与视频互斥 `[x]`
- 依赖：013, 023, 025
- 背景：迷你条此前只在 renderer 引擎下渲染，导致三处死路——023 的 mpv
  波形模式不可达、013/013a 的收藏键对 mpv 曲目静默失效、服务器音乐（025）
  完全没有音乐 UI；另外视频起播不会停掉 renderer 引擎音乐（两路音同时响）
- 内容：
  - main：`music-active.ts` 增 mpv 音乐会话标志（`setMpvMusicActive`/
    `isMusicSessionActive`/`clearMusicSession`）；LOAD_FILE 按是否带
    audioChain 判定并在非音乐加载时结束会话 + 发 `MUSIC.ON_SESSION_END`
    （`player:on-state-change` 的裸字符串同时换成通道常量）；
    `player:on-state-change` 附带 `music` 标记
  - renderer：`attachMusicMpvBridge()`（幂等）把带 `music` 标记的 mpv 状态
    写回 store（position/duration/isPlaying + 桌面歌词推送）、自然 EOF 按
    服务器队列推进下一曲、视频接管或 SESSION_END 时 `stop()` 收尾；
    mpv 起播改为上报 `setMusicEngineActive(true)`（媒体键走音乐语义：
    下一曲按队列而不是 mpv 快进 30 秒）；迷你条对任一引擎渲染，
    服务器曲目（id=0，不在本地库）收藏按钮禁用
- 验收：mpv 状态只写音乐会话；视频接管后音乐条消失且 renderer 引擎停止；
  服务器曲目队列 EOF 自动下一曲
- Evidence: `tests/main/playback-engine/music-active.test.ts` 4/4；
  `tests/renderer/music/mpv-bridge.test.tsx` 6/6（标记过滤/残留事件不误杀/
  位置与歌词推送/EOF 推进/无队列不动 mpv/会话结束收尾）；
  `tests/renderer/music/mini-bar.test.tsx` 3/3（mpv 渲染 + 波形条/
  收藏按钮禁用与启用/无会话不渲染）；typecheck 双配置 + 全量绿
- 待实机：mpv 音乐与视频切换时迷你条的显隐时机——已列入 TARGET-VERIFY

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
