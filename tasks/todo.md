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

### QYP3-020 Jellyfin Lyrics 接入 `[x]`
- 依赖：019
- 内容：Jellyfin 10.9+ `/Audio/{id}/Lyrics`（ticks 起点）；Emby 无端点
  → 覆盖返回 null（不发请求）；404/空数组 → null（无词，桌面歌词隐藏）
- 验收：客户端契约测试；无词→桌面歌词自动隐藏
- Evidence: `tests/main/online/lyrics.test.ts` 4/4（端点/空词/404/Emby
  静默降级）
- 接线见 020b（025 铺好服务器曲目队列后才能落地）

### QYP3-020b 服务器歌词接线 `[x]`
- 依赖：020, 026
- 内容：`online-connector/lyrics.ts` 纯函数把结构化行（Text + Start ticks）
  归一成 LRC（下游只有一套解析）；`MUSIC.GET_SERVER_LYRICS`（按 serverId
  严格绑定服务器，失败/无词一律 hasLyrics=false）；store 增 `currentSource`
  并在每次起播/换曲按来源路由歌词（本地 trackId / 服务器 {serverId,itemId}）
  并推送桌面歌词；歌词面板按来源二选一，服务器曲目隐藏「导入歌词」
  （服务器歌词只读）并给出对应空态文案
- 验收：服务器曲目读服务器端点且不碰本地缓存；Emby 无词不报错；
  歌词拉取不得影响已发生的 loadfile
- Evidence: `tests/main/online/lyrics-lrc.test.ts` 5/5（ticks 换算/空行/
  缺 Start/无词→null）；`tests/renderer/music/lyrics-panel.test.tsx` 6/6
  （本地路由/服务器路由 + 隐藏导入 + 无词文案）；server-music-browser
  4/4 增断言（起播后按 serverId+itemId 取词，不读本地缓存）；
  typecheck 双配置 + 全量绿

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
  48 柱峰值抽样）+ 实时波形（时域 `getByteTimeDomainData`，QYP3-033 接管
  waveform 模式）+ 无真实数据时静态进度线（mpv/静音源，绝不计假波形）+ 模式切换
  （auto/spectrum/waveform/off，存 `playback.visualizer`）+ 设置页 + 迷你条内嵌
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

### QYP3-024 Checkpoint F：全量回归/文档/发布 `[x]`
- 依赖：全部
- 内容：门禁全绿；TARGET-VERIFY 增补音乐项；CHANGELOG 1.2.0；README/
  AGENTS 同步；人工批准后 tag
- 验收：同二期 Checkpoint F 标准
- Evidence（已完成部分）：
  - 门禁：`npx tsc --noEmit -p tsconfig.json` + `-p tsconfig.node.json` 全绿；
    全量 vitest **825/825（83 文件）**；`build:main` / `build:preload` /
    `build:renderer` 三个产物均构建成功
  - 文档：CHANGELOG 已定稿 `1.2.0（三期：音乐播放）`（含 025/026/020b 与
    全部 P2 项）；
    README 音乐条目与模块树更新；AGENTS 三期状态行 + 音乐/服务器音乐/
    音乐会话/歌词/拾音器数据流条目更新
  - TARGET-VERIFY：新增「音乐（三期，v1.2.0 增补）」清单（含服务器音乐、
    引擎互斥、服务器歌词、桌面歌词 ARGB、拾音器 CPU、Wayland 降级）
  - 发版：人工批准后 `package.json` / `package-lock.json` 均升到 `1.2.0`
    （lockfile 之前两次发版都停在 1.0.0，本次一并同步）；已建 annotated
    tag `v1.2.0`（tag 内容是本次发布说明）。**push tag 待人工确认**——
    推上去 GitHub Actions 才会打包发布（`.github/workflows/release.yml`
    监听 `v*` tag）
- 原范围外（计划 §9 的 P2）：服务器歌单只读、睡眠定时、ReplayGain 高级设置、
  网络收音机流（需先 spike）——**六项 P2 已全部收口**，见下方 P2 小节

---

## P2 欠账（计划 §9 标记，QYP3-024 之后追加）

### QYP2P-001 修复设置项读写不对称 `[x]`
- 背景：`SETTINGS.SET` 用 `JSON.stringify` 写入，`SETTINGS.GET` 直接返回
  库里的裸字符串 → 四个功能整体失效：EQ 增益（`Array.isArray('"[6,5,…]"')`
  为假，均衡器从此既不在 UI 恢复也不下发给 mpv）、ReplayGain 模式
  （mpv 收到带引号的 `"track"` 被拒，静默无效）、自定义 EQ 预设（重启即
  消失）、拾音器「关闭」（`'"off"' !== 'off'` → 关不掉）
- 内容：新增 `storage/config-value.ts` 的 `encodeConfigValue`/
  `decodeConfigValue`（解析失败退回裸串，兼容主进程专用键如
  `playback.autoNext`）；`SETTINGS.GET` 改为对称解析；同步两处受影响
  的读取方（快捷键页原先手动 `JSON.parse`、桌面歌词锁定项原先是字符串比较）
- 验收：写进去能读出来；旧裸值不炸
- Evidence: `tests/main/storage/config-value.test.ts` 4/4（往返/字符串不被
  加引号/裸值回退/缺键）；`tests/renderer/settings/eq-presets.test.tsx`
  6/6 与全部既有用例未改断言即通过（测试此前按"已解析"契约 mock，
  即测试与生产契约不一致——本次修复让生产对齐测试）

### QYP2P-002 ReplayGain 高级设置 `[x]`
- 内容：模式之外补 `replaygain-preamp`（整体预增益）/`replaygain-fallback`
  （无标签曲目兜底增益）/`replaygain-clip`（削波保护）——已对目标 mpv
  二进制核实三个选项均存在（`strings` 提取），故不做版本探测；
  `playback-engine/replaygain.ts` 纯函数限幅归一（±15 dB，脏值归 0）；
  `PlayerCore.applyMusicAudioChain` 接收归一后的链并逐个 set_property；
  设置页在启用 ReplayGain 时展开高级控件（滑块 + 复选框）
- 验收：脏配置不进 mpv；关闭模式时不设置任何 RG 属性
- Evidence: `tests/main/playback-engine/replaygain.test.ts` 5/5（默认/关闭→
  null/两种入参形态/限幅与脏值/clip 只认严格 true）；
  `tests/renderer/settings/replaygain-advanced.test.tsx` 3/3（读取存量、
  写入预增益、削波开关、关闭时整块隐藏）
- 范围：ReplayGain 仅 mpv 引擎（renderer 引擎只有 EQ，UI 已注明）

### QYP2P-003 睡眠定时 `[x]`
- 内容：到点**暂停**播放（不改"停止/退出"语义，暂停后可以继续听），
  音乐与视频通用；`ui-shell/sleep-timer.ts` 一次性定时器（时钟/定时器
  可注入，上限 24h，0 或非法值 = 关闭，重复设置替换而非叠加）；
  权威状态在主进程（窗口重载不丢），**不持久化**（重启后旧定时还在跑
  才是意外）；IPC 四件套 `sleep:get-state` / `sleep:set` /
  `sleep:on-expired`；设置页档位（关闭/15/30/45/60/90/120 分钟）+
  剩余时间 + 取消；迷你条挂月亮徽标显示倒计时，点击即取消
- 到点行为：先取消可能正在倒计时的自动连播（否则"停止"后下一集仍会
  起播）→ 暂停 mpv → 下发 ON_EXPIRED 让 renderer 停 renderer 引擎音乐
  （只有 renderer 引擎在放时才动，mpv 引擎不重复动作）
- Evidence: `tests/main/ui-shell/sleep-timer.test.ts` 7/7（未启用/设置与
  剩余/到点一次性并自清/重复设置替换/0 与非法值取消/24h 限幅与取整/
  cancel）；`tests/renderer/settings/sleep-timer.test.tsx` 5/5（档位写入与
  剩余显示/取消/倒计时格式化/到点暂停 renderer 引擎/引擎不是它时不动）；
  `tests/renderer/music/mini-bar.test.tsx` 4/4（含徽标倒计时与点击取消）

### QYP2P-004 服务器歌单只读 `[x]`
- 依赖：025（服务器音乐队列）
- 内容：歌单页加「服务器歌单」页签（本地/服务器切换）——列出所有**已激活**
  服务器上的歌单（`includeItemTypes=Playlist`），点进去看条目、点曲目即播
  （复用 025 的 `MusicTrackInput{serverId,provider,itemId}` + mpv 服务器队列）；
  条目走规范端点 `/Playlists/{id}/Items?UserId=`（Emby 多一层 `/emby`）；
  歌单 id 只在其所属服务器上有意义 → IPC **强制 serverId 严格路由**
  （不做跨服务器试探）；非音频条目（视频歌单）不当作音轨呈现；
  只读：不提供新建/重命名/删除/排序入口
- 验收：只列已激活服务器；服务器歌单无编辑入口；点曲目走 mpv 且队列内
  只有音轨；视频歌单给出可理解的空态
- Evidence: `tests/main/online/playlist-items.test.ts` 3/3（Jellyfin 端点与
  UserId / Emby `/emby` 前缀 / 缺 Items 与空歌单→空数组）；
  `tests/renderer/music/server-music.test.ts` 10/10（新增歌单映射与
  非音频过滤）；`tests/renderer/playlists/server-playlists.test.tsx` 4/4
  （只列激活服务器 / 无编辑入口 / 打开后过滤视频并 mpv 播放 / 空态）；
  typecheck 双配置 + 全量绿
- 范围：服务器歌单的增删改不在本期（服务器端管理）；视频歌单只提示不入队

### QYP2P-005 网络收音机流 spike `[x]`（结论：暂不实现）
- 产出：`docs/decisions/0009-network-radio.md`（ADR）
- 静态核实：目标 mpv 二进制含 ICY 链路（`icy-title` /
  `icy_metadata_headers` / `read_icy`），但 mpv 动态链接系统
  libavformat，实际是否生效取决于目标机 ffmpeg（Debian 10 = 4.1，ICY
  自 2014 年起在 http 协议内）；本机 mpv 因缺 libluajit 无法运行，
  真实播放验证归 TARGET-VERIFY
- 冲突清点（spike 的主要产出）：① 进度保存每 10s 无条件写 watch_history
  且 duration 缺失时 `getResumePosition` 直接返回 position → 直播流会
  污染历史与续播；② 播放解析是 MediaRef 驱动，电台 URL 不在目录域内；
  ③ 队列/收藏/歌词/桌面歌词都按 trackId 或 serverId 走；④ 直播 UI 语义
  不同（无进度/不可 seek/LIVE）且 ICY 标题需要新增 mpv metadata 转发；
  ⑤ 断流是 error 不是 eof，需要重连退避
- 决策：**不做**——它等于给播放状态机开平行通道，而非复用既有管线；
  若将来要做，ADR 里给出了 5 步顺序，第 2 步（不可续播标志）是硬前置
- Evidence: ADR-0009；`strings -a ~/.local/bin/mpv | grep -iE 'icy'`
  （6 条命中）；`playback-state/index.ts:156/138` 与
  `playback-resolver.ts` 的代码定位

### QYP2P-006 修掉门禁里的偶发假红 `[x]`
- 背景：全量跑到 80+ 文件后，出现三个"单跑必过、并行偶发失败"的用例：
  `library/local-library`（load-more）、`home/unified-sources`（继续观看）、
  `detail/metadata-editor`（标题输入框）。它们不是产品 bug，而是**测试自己
  的等待不够**——典型如"等的是静态标题「编辑元数据」，随后同步取异步加载
  出来的字段"，字段数据还没到就断言，并行负载一大就翻车
- 内容：
  - `metadata-editor.test.tsx` 把 4 处 `getByLabelText` 改成
    `findByLabelText`（等异步字段本身）
  - `plugin-registry.test.ts` 的 http 上下文默认超时 400ms → 5s
    （超时/取消用例本就显式传 `timeoutMs`，默认值只是"其余用例"的预算；
    400ms 会被并行调度打穿，让"超容量拒绝"偶发变成 NETWORK_ERROR）
  - 新增 `tests/setup.ts` 把 @testing-library 的异步超时从默认 1s 放宽到
    4s（并行建 jsdom 环境时老机器上 1s 不够），`vitest.config.ts` 注册
    setupFiles
- Evidence: 改动前同一套代码连续三次跑到**三个不同**用例假红
  （local-library / unified-sources / metadata-editor）；修完后连续两轮
  全量只剩 plugin-registry 偶发，再修该用例的默认超时后复跑全绿

## 1.2.0 之后：入库链路审查（本地 A + WebDAV B）

用户要求把两条入库链路完整走一遍（扫描 → 入库 → 音乐页 → 播放 →
封面/歌词），列出断点。结论：本地链路基本通、WebDAV 有两处断点，
其中一处是认证丢失的真 bug。

### QYP3-027 WebDAV 音频播放丢认证头 `[x]`
- 现象：需认证的 WebDAV 音频**静默播不出**（mpv 失败不上报，连 toast
  都没有）；匿名 WebDAV 与本地音频不受影响
- 根因：解析器对 WebDAV 音频返回 `kind:'webdav-stream'` + 不透明的
  `streamSessionId`（Basic 认证头 stash 在主进程，直链**不带凭据**，
  `playback-resolver.ts:373-399`），但渲染层三处音乐 loadfile 的第 5 参
  全部传 `undefined` → 主进程 `streamHeaders.take()` 取不到头
  （`ipc/index.ts:1051`）→ mpv 拿到无凭据 URL
- 影响面：`playQueue` 的 mpv 分支是 WebDAV 音频的实际路径；`playServerAt`
  是服务器曲目（直链带 api_key，只在转码时才有会话）；`fallbackToMpv`
  仅本地。视频侧三条链路（LibraryBrowse/Detail/App）本来就传对了
- 修法：三处全部透传 `resolution.streamSessionId`，并在 inline 类型上补
  该字段（原来类型里没有，所以漏传不会报错——这也是它能活下来的原因）
- Evidence: 新增 `tests/renderer/music/stream-session.test.ts` 3/3；
  把源码 stash 回退后该文件 2 条失败、修复后全过（证明用例非空转）；
  typecheck 双配置 + 全量 833/833

### QYP3-028 封面扩展名硬编码 `.png` `[x]`
- 现象：内嵌封面是 JPEG 的专辑/歌手网格**只显示占位图**（无 onError
  兜底，静默空白）。真实 MP3 的 ID3 APIC MIME 绝大多数是 image/jpeg
- 根因：渲染层按 `<trackId>.png` 请求（`pages/Music/index.tsx:19`），而
  落盘名按内嵌图片的真实格式生成 `<trackId>.<jpg|png>`
  （`cover-service.ts` 的 `extOf`/`saveCoverFromTags`），协议处理器又是
  精确文件名匹配 → `qy-file://covers/12.png` 命中不到 `12.jpg`
- 为什么测试没抓到：`tests/fixtures/audio/` 三张封面夹具**全是 PNG**，
  断言写死 `12.png`——测试只覆盖了唯一能命中的那条分支
- 修法：`cover-service.ts` 新增 `resolveCoverFileName(requested, isServed)`
  ——扩展名只当提示，先精确命中、未命中再按已知扩展名探测；只接受纯
  文件名（拒绝分隔符与 `..`），是否可服务由调用方的 `isServed` 判定，
  目录包含校验仍留在协议层（`main/index.ts`）
- Evidence: `tests/main/library-scanner/cover-service.test.ts` 11/11
  （新增"JPEG 内嵌图落盘为 .jpg"合成夹具用例 + 4 条名字解析用例）；
  typecheck 双配置 + 全量 833/833
- 残留（未修，已知）：内嵌图格式变化时（先 PNG 后 JPEG）旧扩展名文件
  会留在 coversDir，精确命中会拿到旧图；covers 是"可清扫的派生缓存"，
  触发条件罕见，未纳入本次范围

### QYP3-030 内置引擎解不了的文件兜底失效 `[x]`
- 触发：用户报「`张心杰 - 嘲笑.flac` 为什么无法播放」
- 排查：文件在库里（id 13，来源 5 = /home/qiuyuan/Music，flac 284.87s，
  有封面有歌词）；用应用同款 Electron/Chromium + 同款 `qy-file://audio`
  协议做探针（`/tmp/qy-probe/main.js`，**注意探针页面必须从 http 源加载，
  `about:blank` 是不透明源、媒体加载一律被拒**）：
  - 该文件 `<audio>` 报 `DEMUXER_ERROR_COULD_NOT_OPEN: FFmpegDemuxer:
    open context failed`（code 4）
  - 同目录另一首 flac、两个 mp3 全部正常 → 不是协议桥/扫描/路径问题
  - 根因：该文件 FLAC `METADATA_BLOCK_PICTURE` 的 `picture.type = -1`
    （0xFFFFFFFF，非法；正常是 3=front cover）。**把该 4 字节改成 3 后
    同一文件立刻能播**（284.87s 可 seek），根因确认
  - mpv 0.32 对该块只报警告（`Invalid picture type: -1.`）继续播 → 两个
    引擎宽容度不同，本可兜底救回
- 兜底为何没生效（两个 bug）：
  - `error` 事件先于 `play()` 的 rejection 到达（探针实测），而 store 的
    `current` 是在 `await playQueue()` **之后**才写入的 → 兜底读 current：
    首播读到 null 直接 return；换曲后读到上一首会喂错曲子
  - 随后 playQueue 的 catch 写下的 `errorMessage`，页面读的是点击那一刻
    闭包里的快照（`const playback = useMusicPlaybackStore()` +
    `useCallback([playback])`）→ 旧值 null → Toast 不显示 → 用户看到
    「点了没反应」
- 修法：兜底改签名 `fallbackToMpv(track)`（按失败的那首重播）；失败事件里
  同步把引擎切成 mpv 并记 `directFallbackTrackId`，playQueue 的 catch 据此
  认领这次 rejection（不报错）；webaudio 分支改为**状态先落再起播**；三处
  页面改读 `useMusicPlaybackStore.getState().errorMessage`；兜底自身失败
  才报中文错误
- 兼容性结论：这类"内置引擎打不开、mpv 能打开"的文件现在**无需改文件即可
  播放**（自动切 mpv）；用户想彻底消除首次失败的那一瞬间，可
  `ffmpeg -i in.flac -c copy -map 0 -y out.flac` 重封装（音频流 bit-copy、
  标签保留、picture 块归一化，实测可播）
- Evidence: 新增 `tests/renderer/music/direct-fallback.test.ts` 4/4（失败那首
  交给 mpv / 不喂上一首 / 兜底也失败才报错 / 无人认领的失败照常报错）+
  `tests/renderer/music/play-error-toast.test.tsx` 1/1；两者在 stash 掉源码
  改动后分别 3/4、1/1 失败（证明用例非空转）；typecheck 双配置 + 全量 842/842
- 未做（记录在案）：兜底失败后不记忆（每次播放该曲都会先失败一次，约
  100ms）；mpv 自身解码失败无法上报（mpv 日志按硬性约束静音）

### QYP3-031 拾音器不随音调跳（本地音轨频谱静止）`[x]`
- 触发：用户报「播放音频没有拾音器效果，界面的线条没有跟随音调跳动」
- 确认场景（用户）：走**本地普通音轨**（mp3/flac → 内置 webaudio 引擎），
  本应有实时频谱；mpv 引擎（服务器/WebDAV/冷门格式）按架构无真实频谱
- 根因：内置引擎起播路径 `playCurrent` 从不调 `AudioContext.resume()`。引擎
  在 `playQueue` 里构造（`new AudioContext()`），而该调用不在用户手势同步栈
  内（`resolvePlayback` 的 IPC await 在其前）→ 自动播放策略下上下文停在
  `suspended` → 整条图（source→analyser→…→destination）不运转：既无声、
  AnalyserNode 也只读全 0 → 频谱静止（若完全无声则是同一根的更重表现）
- 修法：
  - `web-audio-engine.ts` 的 `playCurrent` 起播前 `if (ctx.state==='suspended') await ctx.resume()`；暂停后的 `resume()` 已含，勿删
  - `Visualizer/index.tsx`：频谱全 0（mpv 引擎下渲染层 AnalyserNode 只接静音
    元素）视为无数据 → 退化波形，避免画出一排静止的 1px 细条；降级波形改为
    播放中按时间相位轻微起伏（**非真实频谱**，仅供 mpv/降级观感）
- mpv 真实频谱（用户选「尽量做真实频谱」）：**目标机 mpv 0.32 不支持 IPC 频谱
  输出**（`audio-fft` 属性 0.34+ 才有；老机软件解码也不宜每帧走 IPC）。故
  0.32 上真实 FFT 不可得，当前以随节拍起伏的波形作为「尽量」的降级；若日后
  放宽 mpv 版本下限（≥0.34），可在 main 轮询 `audio-fft` 并经状态事件回传
  renderer——届时再加，不现在上未测的 IPC 路径
- Evidence: 新增 `tests/renderer/player/web-audio-engine.test.ts` 2 例（suspended
  起播会 resume / running 不重复 resume）+ `tests/renderer/music/visualizer.test.tsx`
  2 例（全 0 频谱走波形降级 / 非零频谱画 bars）；stash 源码后引擎 resume 2 例
  中 1 例（state 断言）失败、visualizer 全 0 用例失败（证明非空转）；typecheck
  双配置 + 全量 846/846；构建三产物绿

### QYP3-032 音乐经 mpv 解码弹黑屏窗口 `[x]`
- 触发：用户报「嘲笑.flac 还是无法播放，而且播放会拉起一个窗口，只有黑屏」
- 排查：
  - 该 flac 经 QYP3-030 兜底到 mpv（内置引擎打不开）；mpv 0.32 在本机实测可解
    码（`--no-video --ao=null --end=2` 退出码 0，报 `Invalid picture type: -1`
    仅是警告；`Video --vid=1 [P] (mjpeg 300x300)` 即内嵌封面被当成 video 轨，
    `(+) Audio --aid=1 (flac 2ch 44100Hz)` 音频正常）——所以音频其实能放，黑屏
    是 mpv 把封面当 video 轨显示的窗口
  - 根因：`mpv-process.ts` 启动参数 `--force-window=immediate` 强制开窗；音频
    文件带封面 → 即便不改 force-window 也会开窗，且覆盖/冷门格式的音乐都走 mpv
  - 该 mpv 实例由 `playerLoadFile` 懒启动（首次播放才起），所以连走内置引擎
    （webaudio）的本地音乐也会顺带启动它 → 之前连普通本地音乐都会闪黑窗
- 修法：
  - 启动参数 `--force-window=immediate` → `--force-window=no`（idle 不再开窗）
  - `PlayerCore.setVideoWindowForMusic(isMusic)`：音乐 `vid=no` + `force-window=no`，
    视频 `force-window=yes` + `vid=auto`；在 `ipc/index.ts` 的 `playerLoadFile`
    里 audioChain 分支调 true、else（视频）分支调 false
  - 关键：必须 `vid=no` 关掉封面 video 轨，否则仅改 force-window 仍会开窗
- Evidence: 新增 `tests/main/playback/mpv-process.test.ts` 1 例（启动参数含
  `--force-window=no`、不含 `immediate`）；stash 掉改动后该例失败（证明非空转）；
  typecheck 双配置 + 全量 847/847；构建三产物绿
- 待目标机验证（无显示器环境无法验窗口显隐）：音乐（本地冷门格式 / 服务器 /
  WebDAV / 内置兜底）播放无弹窗且音频出声；视频播放仍有 mpv 窗口；音乐→视频
  →音乐切换窗口状态正确。已记入 `docs/TARGET-VERIFY.md`

### QYP3-033 拾音器假波形 → 真波形 + 救非法封面 FLAC `[ ]`
- 触发：QYP3-032 之后用户报「播放的波形是假的，我要的是真正的音频波形」
- 现状（根因）：`Visualizer` 的 waveform 模式画的是 `waveformAmplitude`
  （确定性包络）+ 正弦相位的**假波形**，与音频完全无关；spectrum 模式在 mpv
  引擎下拿不到真实数据（全 0）也退化成同一条假波形
- 约束（已与用户确认范围「接真波形 + 救嘲笑.flac」）：真实波形/频谱**只有
  renderer 内置引擎（Web Audio）解码的音轨才有**——AnalyserNode 同时给频域
  （`getByteFrequencyData`）与时域（`getByteTimeDomainData`）真实数据。**mpv 0.32
  没有暴露实时频谱/波形的 IPC 接口**（`audio-fft` 是 0.34+ 才有），升级 mpv 会
  破坏老系统兼容（AGENTS.md 硬性约束 2），故服务器/WebDAV/CUE/冷门格式等走 mpv
  的音源**拿不到真实波形**——`Visualizer` 在无真实数据时改画**静态进度线**（绝不
  画假跳动）
- 修法：
  - `web-audio-engine.ts`：新增 `getWaveform()`（时域 `getByteTimeDomainData`，
    fftSize 长度缓冲，静音恒 128）；`music-playback-store.ts` 暴露 `getWaveform`，
    `MusicMiniBar` 透传 `getWaveform` 给 `Visualizer`
  - `Visualizer/index.tsx`：waveform 模式用真实时域数据画居中镜像波形条；spectrum
    全 0 或 waveform 静音/无数据时改画静态进度线（播放段琥珀、未播段灰）；删除
    已无用的 `waveformAmplitude` 假包络
  - `flac-strip.ts`（新增）：fetch 本地 `qy-file://audio` FLAC 字节，解析并移除
    所有 `METADATA_BLOCK_PICTURE`（type=6）块、重封装成 blob URL（音频帧原样保留，
    无损）；封面展示走 `covers` 缓存分区，与播放流内嵌封面无关，剥离不影响封面
  - `web-audio-engine.ts.recoverFlac(track)`：本地 FLAC 解码失败时剥离封面后以
    blob 在内置引擎重播；`music-playback-store.ts.onError` 在 mpv 兜底**前**先调
    `recoverFlac`，成功则保持 webaudio 引擎（真波形），失败再走原 mpv 兜底
    （用 `flacRecovering` 标志吞掉自救期间的错误事件，避免重复兜底）
- 真机复盘补修（用户实测「还是报错」）：
  - `Refused to load media from 'blob:...'`——渲染层 CSP `media-src` 未放行
    `blob:`，剥离后的 blob 被拒载 → 自救失效并退到 mpv。已在
    `src/renderer/index.html` 的 `media-src` 加 `blob:`
  - 首个 loadfile 报 `connect ECONNREFUSED /tmp/qy-player/mpv-*.sock`——
    `MpvProcessManager.start` 只轮询 socket 文件是否存在，`bind()` 建文件、
    `listen()` 后才可连，窗口期 connect 被拒。`MpvIpcClient.connect` 加有界重试
    （默认约 1.2s），失败尝试不派发 `disconnect`
- 真机复盘补修 2（用户实测「播放音频总是弹窗 Failed to load because no supported
  source was found.」）：QYP3-033 自救是异步的，`onError` 不再同步置
  `directFallbackTrackId` → `playQueue` 的 catch 把紧随 error 事件的 `play()`
  rejection 当失败抛出。修法：自救期间以 `flacRecoveringTrackId` 认领该曲目的
  rejection（marker 刻意不在 .then 里清，避免 .then 先于 catch 跑导致误报，
  改为下一次 playQueue/stop 重置）；未被认领的真实解码失败经 `decodeErrorMessage`
  统一中文化为「这首曲目无法解码播放」。新增 2 例测试（自救成功零报错、无认领
  时中文报错）
- Evidence: 新增 `tests/renderer/player/flac-strip.test.ts`（剥离 PICTURE /
  保留 STREAMINFO 与音频帧 / 末块标志重算 / 截断返回 null / isLocalFlacUrl）；
  `web-audio-engine.test.ts` 增 `getWaveform` 与 `recoverFlac` 用例；
  `visualizer.test.tsx` 重写（真实波形/静态进度线断言，去掉 `waveformAmplitude`）；
  新增 `tests/main/playback/mpv-ipc-client.test.ts` 3 例（已监听即连 / 延迟
  listen 靠重试成功 / 耗尽重试后 reject）；typecheck 双配置 + 全量 861/861 +
  构建三产物绿
- 目标机验证：本地普通音轨（mp3/正常 flac）拾音器出**真波形/真频谱**；嘲笑.flac
  类非法封面 FLAC 不再兜底 mpv、在内置引擎出真波形且不弹窗；服务器/WebDAV/CUE 音源
  拾音器显示静态进度线（诚实告知无真实波形）。已记入 `docs/TARGET-VERIFY.md`

### QYP3-034 播放频谱图（音乐页内嵌，柱状/瀑布）`[x]`
- 诉求（用户）：「做个播放时显示频谱图的功能」→ 经确认：音乐页顶部内嵌频谱区 +
  柱状/瀑布两种图表可切换
- 约束（延续 QYP3-033）：真实频谱只有 renderer 内置引擎（Web Audio）解码的音轨
  才有；mpv 0.32 无实时频谱 IPC 接口 → mpv 源（服务器 / WebDAV / CUE / 兜底 FLAC）
  面板如实提示"无法显示真实频谱"，**绝不画假数据**
- 内容：
  - `components/SpectrumGraph/index.tsx`（新增）：canvas 频谱图，柱状（64 柱频率
    峰值）+ 瀑布（96 bin 热力图，离屏画布整体左移实现滚动）；≤30fps；纯函数
    `downsampleSpectrum`（频率下采样）/`heatColor`（暗→蓝→青→黄→红热力配色）
  - `pages/Music/index.tsx`：顶部内嵌（来源/视图切换之上），仅在有音乐会话
    （`engine && current`）时渲染，切视图/切来源常驻
  - 图表选择持久化到 `playback.spectrumChart`（SETTINGS.GET/SET 对称）
- Evidence: 新增 `tests/renderer/music/spectrum-graph.test.tsx` 7 例（downsample
  分组/空安全、heatColor 钳制、mpv 提示且无 canvas、webaudio 出 canvas、切换持久化、
  读回持久化）；typecheck 双配置 + 全量测试 + 构建三产物
- 待目标机验证：本地音轨频谱随音调跳动、柱状/瀑布切换并记住；服务器/WebDAV 音源
  显示提示；30fps 下 CPU 占用（老机预算）。已记入 `docs/TARGET-VERIFY.md`

### QYP3-035 精简模式浮窗（主窗口原地缩小）`[x]`
- 诉求（用户）：「播放音频增加一个精简模式，自动缩小窗口变成一个浮窗显示到屏幕
  右上角，显示频谱图、进度、上一曲、暂停、下一曲、音量、循环模式等基础按钮」
  → 经确认：**主窗口原地缩小**（非另开窗口）+ **手动为主、可选自动**
- 方案取舍：同窗改尺寸（`setBounds`/`setMinimumSize`/`setAlwaysOnTop`）而非新开
  BrowserWindow——播放状态与 30fps 频谱都在主窗口 renderer 里，另开窗需跨进程
  转发频谱，老机 CPU 不划算
- 内容：
  - `main/modules/ui-shell/compact-window.ts`（新增）：进入记住 bounds/resizable/
    alwaysOnTop 并缩到右上角（先放宽最小尺寸）、退出原样恢复；纯函数
    `compactBounds` 定位置
  - IPC：`WINDOW.SET_COMPACT_MODE` + preload `setCompactMode`（替换掉从未使用的
    `enterPlayerMode/exitPlayerMode`）
  - `stores/compact-mode-store.ts`（新增）：compact 开关 + enter/exit/toggle，
    同步主进程
  - `components/CompactPlayer`（新增）：频谱图（复用 SpectrumGraph，加
    `headerExtra` 放还原按钮）+ 进度条（拖动松手才 seek）+ 上一曲/暂停/下一曲/
    循环/随机/音量/还原
  - `music-playback-store`：补 `volume/setVolume`（webaudio 走 gain、mpv 走
    `playerControl('volume')`）并在起播时应用；mpv 引擎的 `next/prev` 落实循环
    模式（one=重播当前 / all=队尾回卷），否则浮窗循环按钮对 mpv 形同虚设
  - `App.tsx`：compact 时只渲染 CompactPlayer；`CompactModeHost` 负责自动进入
    （设置 `playback.autoCompact`）与会话结束后自动还原
  - `MusicMiniBar` 加「精简」按钮；`MusicSettings` 加自动进入开关
  - `shared/ipc-channels.ts`：WINDOW 增 SET_COMPACT_MODE
- Evidence: 新增 `tests/renderer/music/compact-mode.test.tsx` 10 例（store IPC 同步/
  幂等、循环与文案纯函数、控件渲染、暂停、循环循环、音量、拖动 seek、还原）、
  `tests/main/ui/compact-window.test.ts` 2 例（右上角定位 + 多显示器原点）、
  mini-bar 精简按钮 1 例；typecheck 双配置 + 全量 883/883 + 构建三产物绿
- 待目标机验证：浮窗尺寸/位置（右上角、置顶）、退出还原原尺寸、精简模式期间播放
  与频谱正常、音量/循环生效、视频接管时自动还原。已记入 `docs/TARGET-VERIFY.md`

### QYP3-036 性能保护（CPU 紧张时降频谱刷新保播放）`[x]`
- 诉求（用户）：「精简模式希望增加一个保护进程资源的功能，避免系统 cpu 资源紧张
  的时候播放卡顿」
- 思路：应用自身最大的**可控** CPU 开销就是可视化画布；CPU 紧张时把它让出去，
  优先保证音频解码。不改进程优先级（老机 / 无 sudo 环境不可靠，且可能反噬音频线程）
- 内容：
  - `shared/resource-pressure.ts`（新增）：`ResourcePressure` 档位、`PRESSURE_FPS`
    （30/12/3）、`pressureFromLoad(load1, cores)`、`scaledFps(base, powerSave, p)`、
    中文档位文案——全为纯函数
  - `main/modules/ui-shell/resource-guard.ts`（新增）：每 3s 采 `loadavg()/cpus()`
    换算压力档，**只在变化时**回调；采样异常按 normal 兜底；定时器 unref
  - IPC：`RESOURCE.GET_PRESSURE`（回执）+ `RESOURCE.ON_PRESSURE`（主进程推送）；
    main/index.ts 启动/停止采样并广播到主窗口；preload 暴露
    `getResourcePressure`/`onResourcePressure`
  - `stores/resource-store.ts`（新增）：压力档 + 性能保护开关（默认开，存
    `playback.powerSave`）+ `useVisualizerFps(base)` hook
  - `Visualizer` 与 `SpectrumGraph` 改用 `useVisualizerFps`（帧率随压力降档）
  - `CompactPlayer` 加「性能保护」仪表按钮（title 显示当前压力档）；`MusicSettings`
    加性能保护开关；`App.tsx` 加 `ResourceHost` 订阅
- Evidence: 新增 `tests/shared/resource-pressure.test.ts` 4 例（档位阈值/零核与 NaN
  兜底/帧率缩放与不抬高/中文文案）、`tests/main/ui/resource-guard.test.ts` 2 例
  （只在变化时推送 + 幂等启动）、`tests/renderer/music/resource-store.test.ts` 2 例
  （读回压力+默认开+订阅推送、持久化）；compact-mode 增 1 例开关；typecheck 双配置
  + 全量 892/892 + 构建三产物绿
- 待目标机验证：制造 CPU 压力时频谱帧率下降、压力回落恢复、关掉开关后不再降帧；
  降帧期间音频不卡（对比开关前后）。已记入 `docs/TARGET-VERIFY.md`

### QYP3-037 服务器/WebDAV 音乐改走内置引擎（qy-stream 认证流代理）`[x]`
- 诉求（用户）：「播放显示：此音源经 mpv 解码……我们没有别的手段获取频谱吗」
  → 四选项里拍板「服务器/WebDAV 改走内置引擎」；两个子决策：codec 未知时仍
  优先内置引擎（回退兜底）、进度/续播一起做保证不回归（拆 038）
- 思路：mpv 0.32 无 IPC 音频采样接口（strings 核实只有 `af-metadata`，且
  `audio-fft` 这个属性名不存在——先前的"0.34+"说法是凭空假设，已当面纠正），
  拿真频谱的唯一路径是让音源进 renderer 引擎；认证与跨源静音两个阻断点用
  主进程代理一次解决（顺带修掉 api_key 进渲染层 URL 的泄漏）
- 内容：
  - `security/stream-route-cache.ts`（新增）：可重复读取路由表（滑动 TTL 8h
    + LRU 64；**与单次消费的 StreamHeaderCache 是两套语义**，take 未动）
  - `playback-engine/stream-protocol.ts`（新增）：`qy-stream://audio/<id>`
    处理器——裸 node:http(s) 字节转发、Range/206 如实透传、上游强制
    `Accept-Encoding: identity`、下游白名单头、客户端中止销毁上游 socket；
    未命中一律 error -6 不区分原因
  - main/index.ts：`registerSchemesAsPrivileged` 加 qy-stream（standard/
    secure/supportFetchAPI/**stream**，刻意不加 corsEnabled）；路由表与
    `registerIpcHandlers` 共享同一实例
  - `engine-selector.ts`：删 `server-stream`/`webdav-auth` 两条提前返回，
    `sourceKind` 退出判定（reason 联合收敛，表驱动测试同步重写）
  - `playback-resolver.ts`：`ResolverDeps.streamRoutes`；WebDAV 音乐直解 →
    qy-stream（续播键同步修正为 `getProgress('webdav', '<sourceId>:<path>')`，
    此前误读 'local' 域 = WebDAV 音乐续播从不生效）；服务器 Audio 直解 →
    qy-stream + `X-Emby-Token` 入路由，codec 缺失按乐观直解；`engineForce`
    逃生口（PROBE_ITEM 也用它避开代理）
  - jellyfin/emby client：`getItemDetails` Fields 加 `MediaStreams`（视频路径
    无感，video 分支从不读 engine）
  - `web-audio-engine.ts`：`playQueue` 第 5 参 `urlResolver` + `startPosition`，
    `playCurrent` 懒解析并写回快照、失败走 `onResolveError` 不设 src
  - `music-playback-store.ts`：整队不再逐曲预解析（服务器 500 首 = N 次网络
    请求不可接受）；队列 id `queueIdFor`（服务器恒为 0 的 trackId 改负数合成
    id，兜底/自救标记改按队列 id 认领，防服务器曲目互相认领）；NEEDS_MPV →
    服务器曲直接兜底（mpv 能续队列）、本地/WebDAV 先跳下一首（整队失败才兜底，
    防 repeat=all 空转）；`fallbackToMpv` 解析 ref 按来源分支；FLAC 自救门
    `codec === 'flac' || isLocalFlacUrl`（isFlacUrl 对任意 qy-stream 都真，
    会造成 mp3 白拉整文件）；`PLAYER.RESOLVE` 补透传被丢的 `engineForce`
  - CSP：`media-src`/`connect-src` 加 `qy-stream:`
- Evidence: 新增 `tests/main/playback/stream-route-cache.test.ts` 7 例、
  `tests/main/playback/stream-proxy.test.ts` 7 例（真上游 server 验 Range
  透传/认证注入/identity/中止断上游）、resolver +6 例（服务器三态 + WebDAV
  两态 + engineForce 逃生口）、engine +5 例（懒解析/写回/NEEDS_MPV/续播位）、
  direct-fallback +3 例（服务器兜底 ref/队列 id 不撞/serverIndex 对齐）、
  flac-strip +2 例；typecheck 双配置 + 全量 927/927 绿
- 待目标机验证：qy-stream 实播（stream:true 的 Range 行为本机验不了），
  已记入 `docs/TARGET-VERIFY.md`

### QYP3-038 内置引擎服务器音乐进度/续播对齐 `[x]`
- 诉求：037 的回归防线——webaudio 播放不经 LOAD_FILE，Sessions/Playing 系列、
  服务器续播位置会整体丢失（用户拍板「一起做，保证不回归」）
- 内容：
  - IPC 四件套：`MUSIC.START_SERVER_SESSION`（严格按 serverId 找活跃服务器，
    `randomUUID` 生成 playSessionId，fire-and-forget reportPlayingStart，回传
    id）+ `MUSIC.REPORT_SERVER_PROGRESS`（本地续播键 addWatchHistory/
    saveProgress（mediaType=provider，键=itemId，与解析器续播读取一致）+ 回传
    服务器；`isStopped` 收尾走 Stopped 端点（Emby 仅 Stopped 落 PositionTicks
    ——实测教训），是否标记看完由位置比率另算）
  - `REPORT_PROGRESS` 加 `mediaType?: 'local' | 'webdav'`：WebDAV webaudio 进度
    落 'webdav' 域且不进 local_media（键与 mpv 引擎一致）
  - store：`beginServerSession`（webaudio 首播/`syncFromEngine` 换曲发起，
    本地清空）；`reportProgress` 按来源分流（服务器 → 新通道带 playSessionId，
    WebDAV → mediaType:'webdav'，本地原样）；`stop()` 在清状态**前**收尾上报；
    懒解析/首曲解析回填权威 `mediaId`/`mediaSourceId`（Sessions 回传要用）
- Evidence: 新增 `tests/renderer/music/server-progress.test.ts` 4 例（服务器
  会话+进度带 playSessionId / 本地不开会话 / WebDAV 落对键 / stop 收尾
  Stopped）；direct-fallback 的 electronAPI mock 补两条新通道（缺了会同步抛错
  中断 playQueue——测试抓出来的真坑）；typecheck 双配置 + 全量 927/927 绿

### QYP3-029 设置页按板块分页签 `[x]`
- 诉求（用户）：音乐相关配置独立一个板块，不要跟影视的混在一起
- 现状：设置页是同一条长滚动列——播放（影视：自动连播/跳片头片尾）→
  音乐 → 插件，音乐只是其中一个 `<h2>`，要滚过影视设置才够得着
- 内容：`Settings/index.tsx` 改页签壳（播放 / 音乐 / 插件），一次只挂载
  一个板块 + `role=tablist/tab/tabpanel` 语义关联；子组件（各自带小标题、
  各自有单测）一行未动
- 决策：睡眠定时**留在音乐板块**（用户选择）——它写着"音乐与视频通用"，
  但入口与倒计时都在音乐侧，挪走反而更难找
- Evidence: 新增 `tests/renderer/settings/settings-tabs.test.tsx` 4/4
  （默认只挂播放板块 / 切到音乐后影视项消失 / 插件板块与 tabpanel 关联 /
  切回播放）；`tests/renderer/settings/` 5 文件 21/21 绿（子组件单测未受影响）

### QYP3-039 媒体来源用途标记（音乐/视频两域拆分）`[x]`
- 诉求（用户）：音乐模式与视频模式完全隔离，媒体库也要分开管
- 决策（用户选择）：**来源加用途标记**——一个来源带 `purpose =
  all|music|video`，扫描按用途过滤，媒体库页按模式只显示本域来源；
  而不是建两套来源表。理由：同一台 Jellyfin/同一个 NAS 目录往往两域共用，
  拆表会让用户重复配置
- 内容：
  - migration 009（只追加）：`ALTER TABLE library_sources ADD COLUMN purpose
    TEXT NOT NULL DEFAULT 'all'`（老库升级后存量为 'all'，行为不变；
    校验放应用层 `isSourcePurpose`，不用 CHECK——老 SQLite 风险）
  - 扫描过滤：`createLocalScanDriver` / `createWebDavScanDriver` 吃 `purpose`，
    nfo 在 music 域跳过、audio/audio-cue 在 video 域跳过、video 在 music 域
    跳过；两个「误删」陷阱同步堵住——`cleanupMissingMusic` 在 video 域不跑，
    `markAvailabilityAfterScan` 在 music 域不跑
  - 收窄用途即清理：`SOURCE_UPDATE` 里 purpose 变窄后 `purgeVideoContentBySource`
    / `purgeMusicTracksBySource` 清掉另一域索引（FK 级联带走了子行）
  - UI：`MediaSourcesPage({ mode })`——视频模式 `/media-sources`（默认新来源
    purpose=video）、音乐模式 `/music-sources`（默认 music）；表单加
    「两者/仅音乐/仅视频」分段控件，列表可就地改用途（改完 Toast 提示索引已清理）
- Evidence: 新增 `tests/main/storage/source-purpose.test.ts`、
  `tests/main/library-scanner/purpose-filter.test.ts`、
  `tests/renderer/media-sources/purpose.test.tsx`；catalog-migrations 版本断言
  8→9；local-source 用例补 payload `purpose:'all'`；typecheck 双配置 + 全量
  940/940 绿

### QYP3-040 应用顶层双模式（影视 / 音乐）`[x]`
- 诉求（用户）：默认打开是视频模式，按钮切到音乐模式，保留音乐全部功能，
  把设置与媒体库也按模式分开
- 内容：
  - `stores/app-mode-store`：`mode: 'video' | 'music'`，**不持久化**（每次
    启动都是视频模式，符合"默认打开是视频模式"）；`MODE_HOME` 定义各模式落地页
  - `Navigation`：影视/音乐分段切换（`role=radiogroup`）→ 切模式即导航到该模式
    首页；两套导航表——影视（首页/本地/搜索/历史/刮削任务/媒体库/设置）、
    音乐（音乐/歌单/媒体库 `/music-sources`/设置）；页标题先精确匹配再最长前缀
    （否则 `/music-sources` 会被判成"音乐"）
  - 设置页按模式分页签：影视=播放/插件/快捷键，音乐=音乐/快捷键；快捷键是
    应用级配置，抽出 `ShortcutsContent` 两模式共用同一份，页面壳只留 h1
  - 模式切换时页签复位：`key={mode}` 不会重置组件自己的 useState（测试抓出来），
    改渲染期比对 `renderedMode` 再复位
- 决策：模式只做**入口与配置的隔离**，不碰播放链路——迷你条/精简浮窗由音乐
  会话门禁（而非页面门禁），跨模式保留；直达 hash 路由不做模式推断
- Evidence: 新增 `tests/renderer/navigation/app-mode.test.tsx` 4 例
  （默认影视导航 / 切音乐后换表并落到 /music / 音乐模式无"本地"入口 /
  `/music-sources` 标题正确）；重写 `tests/renderer/settings/settings-tabs.test.tsx`
  （两模式页签集 / 快捷键共用 / 切模式页签复位）；typecheck 双配置 + 全量
  945/945 绿

### QYP3-041 来源按域彻底分离（去掉"混放"）+ 音乐入口降权 `[x]`
- 诉求（用户）：① 媒体库没真分开——实际不支持音乐与视频放同一目录，039 的
  'all' 档位是多余的；② 音乐模式入口太显眼（绝大多数人用影视，音乐是可选
  功能）；③ 扫描要按媒体库类型决定，视频扫描的 NFO 归类逻辑跟音乐混在一起
  效果很差
- 决策（用户选择）：入口放**侧栏底部小号按钮**；存量 'all' 来源**全部归为
  视频来源**；媒体服务器**只在影视模式**的媒体库页管理
- 内容：
  - `purpose` 收成两值 `'music' | 'video'`（`isSourcePurpose` 不再接受 'all'）；
    migration 010（只追加）`UPDATE library_sources SET purpose='video'
    WHERE purpose<>'music'`；`createSource` 缺省 'video'
  - 因不再允许就地改用途而成为死代码的，一并删除：`SOURCE_UPDATE` 通道与
    处理器、preload `updateSourcePurpose`、`updateSource` 的 purpose 分支、
    `purgeVideoContentBySource` / `purgeMusicTracksBySource`
  - 扫描：driver 缺省从 'all' 变 'video'（音乐/CUE 与 NFO 的过滤逻辑不变）
  - UI：`SourceForm` 去掉用途单选（用途由所在模式决定，改必传 prop）、
    `SourceList` 去掉用途下拉/badge、`MediaSourcesPage` 严格按 `purpose ===`
    过滤且音乐模式不渲染服务器区块（给一句"服务器在影视模式管理"的提示）、
    `Local` 页只列 `purpose === 'video'`
  - 导航：顶部大分段控件 → 侧栏底部小号弱化按钮（「音乐模式」/「返回影视」），
    `MODE_TABS` 常量随之删除
- Evidence: `tests/main/storage/source-purpose.test.ts` 重写（版本 10 /
  缺省 video / 白名单拒 'all'）；`catalog-migrations.test.ts` 版本断言 9→10 +
  新增 migration 010 用例（造停在 009 的库：all→video、music 不动）；
  `purpose-filter.test.ts` 首例改为"缺省按视频扫"；`purpose.test.tsx` 重写为
  域分离 4 例（两页互不显示 / 音乐模式无服务器区块 / 影视模式有）+
  SourceForm 2 例（无用途选择器 / payload 带页面给的用途）；local-scan 的
  音乐用例改走 `makeSource('music')` + driver `purpose:'music'`；四份夹具补
  `purpose:'video'`；typecheck 双配置 + 全量 945/945 绿

### QYP3-042 主窗口改无边框（自绘标题栏 + 缩放热区）`[x]`
- 诉求（用户）：窗口改成 frameless 模式
- 决策（用户选择）：顶部独立 36px 细条（左侧应用名、右侧三按钮、整条可拖、
  双击最大化）；Linux 无边框没有系统边框可拖 → 自绘四边 + 四角热区
- 内容：
  - `createWindow` 加 `frame: false`；主进程监听 maximize/unmaximize 并推
    `WINDOW.ON_MAXIMIZE_CHANGE`（WM 快捷键也能触发最大化，渲染层自记会不同步）
  - IPC 四件（都在既有 `WINDOW` 组）：MINIMIZE / TOGGLE_MAXIMIZE / CLOSE /
    IS_MAXIMIZED + RESIZE_DELTA；preload 同名包装；renderer 类型自动跟随
  - `RESIZE_DELTA` 只吃「边/角缩写 + 鼠标位移增量」：真实 bounds 由主进程从
    `getBounds()` 算（渲染层拿不到窗口屏幕坐标），夹在 `getMinimumSize()`
    之上；被下限夹住时左/上边不跟着漂（否则窗口会"跑"）；最大化时忽略
  - 渲染层 `components/TitleBar`：`-webkit-app-region: drag` + 按钮 `no-drag`，
    紧凑变体（28px，带「还原窗口」）给精简浮窗用；`WindowResizeHandles` 8 个
    透明热区，容器从标题栏下沿开始（右上角热区不能压住关闭按钮）
  - 布局：`App.tsx` 改 `h-screen flex flex-col`，内容区 `overflow-y-auto`；
    Navigation `top-9`、Toast `top-12` 让开标题栏；CompactPlayer 根
    `h-screen w-screen` → `h-full w-full`（外层接管高度）
- Evidence: 新增 `tests/renderer/titlebar.test.tsx` 6 例（三按钮走新通道 /
  最大化图标随推送切换 / 紧凑变体无最大化按钮 / 热区按边报增量 / pointerup
  后停报 / 八向齐全）；typecheck 双配置 + 全量 951/951 绿，三构建通过
- 待目标机验证：拖动/双击最大化/八向缩放的手感与最小尺寸夹取、GNOME 与
  Deepin 下观感、精简浮窗可拖动还原——已记入 `docs/TARGET-VERIFY.md`

### QYP3-043 前端审查整改（按 frontend-ui-engineering 规范）`[x]`
- 诉求（用户）：加载 `/home/qiuyuan/.agents/skills/frontend-ui-engineering/SKILL.md`，
  审查前端设计与实现并按意见优化
- 审查结论（AI 味一项基本免检：全仓无紫/靛色、无 gradient 滥用、无 rounded-2xl/3xl、
  阴影仅 6 处单层；`[]` 任意值集中在 `text-[10px]/[11px]` 这类小字号，属项目既有刻度）
- 本轮改的（高收益低风险）：
  - 加载/错误态：History / Music / Playlists 区分「加载中=骨架、空=空态、
    失败=可重试错误态」——此前 `null` 同时表示加载中与失败，失败落成
    "暂无记录/空网格"这种误导性呈现
  - 键盘可达：PlayerControls 进度条加 tabIndex + ←/→ ±5s（Shift ±30s）、
    Home/End；History 悬浮操作区加 `group-focus-within`
  - 焦点样式收敛：Search / PluginSettings / ServerMusicBrowser / Toast 的自造
    focus 样式统一为 `focus-ring`
  - 标题层级：Music / Playlists 补 h1；LibraryBrowse「季与集」与 Detail
    「演职员」「季」h3 → h2
  - 拆分：`MediaSourcesPage` 的服务器区块抽成 `use-servers.ts`（568 → 414 行）
- 未改（有意为之，勿当遗漏）：`ReplayGain` 是行业标准术语保留；`PosterCard`
  的 `role=button` 嵌套与歌单拖拽排序是既有交互，改动风险大于收益
- Evidence: 新增 `tests/renderer/history/load-error.test.tsx` 1 例、
  `music-views.test.tsx` 增 1 例（失败态 → 重试后回到空态）；typecheck 双配置
  + 全量 953/953 绿，三构建通过

### QYP3-044 音乐模式改成竖窄屏（同窗 resize）`[x]`
- 诉求（用户）：复用 `compact-window.ts` 做"同窗竖屏"方案（D）——不新开窗口，
  把主窗口原地改成竖窄屏
- 背景：评估"音乐独立窗口"后选了 D：独立窗口的最大成本是 renderer 引擎的
  `AnalyserNode` 频谱无法跨进程（mpv 引擎音乐反而无痛，状态本来就由主进程推），
  其次是状态镜像、窗口生命周期与老机多一个 renderer 的内存。同窗 resize 零
  跨进程同步——与 QYP3-035 精简浮窗同一个理由
- 内容：
  - `ui-shell/compact-window.ts` 扩成 profile 机制：`normal | compact | music`
    共用一个 `applyProfile`，正常几何只记一次（音乐模式里再进浮窗不互相覆盖）；
    浮窗优先级更高，`setCompactMode(false)` 会回到 `musicMode ? 'music' : 'normal'`
  - `musicBounds()`：竖屏 460×820，水平居中、垂直尽量居中；矮屏先夹高度
    （≥600、≤ 工作区高-48）再夹宽度
  - IPC `WINDOW.SET_MUSIC_MODE` + preload `setMusicMode`；`app-mode-store.setMode`
    负责下发意图（窗口不在时静默失败）
  - 渲染层：音乐模式侧栏收成 56px 图标轨（导航项用 `aria-label` 保名、
    `title` 兜提示），内容区 `ml-14`、播放控制条 `left-14`
- Evidence: `tests/main/ui/compact-window.test.ts` 增 3 例（竖屏居中 / 768p
  矮屏夹取 / 多显示器原点）；`app-mode.test.tsx` 增 1 例（图标轨：有名字、
  无可见文字）+ 切模式断言 `setMusicMode(true/false)`；typecheck 双配置 +
  全量绿，三构建通过
- 待目标机验证：1366×768 与 1920×1080 下竖屏尺寸与位置、切回影视是否精确
  还原原尺寸、最大化状态下切音乐模式、音乐模式里进精简浮窗再退出是否回到
  竖屏——已记入 `docs/TARGET-VERIFY.md`

### QYP3-045 音乐模式默认曲目列表 + 常驻播放控件 `[x]`
- 诉求（用户）：音乐模式默认展示的就是音乐列表，和音乐播放的基础控件
- 内容：
  - `pages/Music` 默认视图 'albums' → 'all'（全部曲目），tab 顺序调成
    全部曲目 / 专辑 / 歌手 / 收藏，与默认视图一致
  - `MusicMiniBar` 在音乐模式停靠窗口底部（`bottom-0 left-14 right-0 border-t`，
    收起态的气泡也贴内容区右侧），其他模式仍是居中浮卡；控件行 `flex-wrap`、
    标题区 `min-w-[8rem]`，竖屏下换行而不是横向溢出
  - 内容区在音乐模式且有会话时加 `pb-28`，列表末尾不被播放条挡住
- 未做（有意）：播放条没塞音量（竖屏 404px 内容宽已经排满，音量在音乐设置与
  精简浮窗里有）
- Evidence: `music-views` 增 1 例（不点 tab 就出曲目列表，且不会去拉专辑）、
  改 1 例（失败态改用曲目加载）；`music-library` 改 2 例（专辑网格要先切 tab、
  空态文案改「没有曲目」）；typecheck 双配置 + 全量绿，三构建通过

### QYP3-046 频谱一直是一条直线（AnalyserNode 悬空）`[x]`
- 诉求（用户）：频谱全都是一条直线，并无任何效果
- 根因：`web-audio-engine` 构造时 `createAnalyser()` 了，却**从来没接进图**——
  实际链路是 `source → EQ×10 → gain → destination`，analyser 悬空。
  `getByteFrequencyData` 恒全 0、`getByteTimeDomainData` 恒 128，于是
  `Visualizer` / `SpectrumGraph` 永远走"无真实数据"的静态进度线。
  `git log -S "connect(this.analyser)"` 为空：这个节点自 QYP3-009 建图起就
  没接过；QYP3-031 只补了 `AudioContext.resume()`（必要但不充分），所以"真频谱"
  一直没真正生效过——测试里那条 "source → analyser → …" 用例只断言了队列状态，
  没验连线，所以没兜住
- 修复：`node.connect(analyser); node = analyser;`（取样点是链路第一跳，EQ 串在
  它之后，与 AGENTS 里写的图一致）
- Evidence: `web-audio-engine.test.ts` 增 1 例——用会记录连线的假上下文钉住
  `source->analyser` 是第一跳、`analyser->filter` 存在、不存在绕过 analyser 的
  `source->filter`、10 段 EQ 串成 9 条 `filter->filter`；typecheck 双配置 +
  全量绿，三构建通过
- 待目标机验证：本地 mp3 出真频谱/真波形、调均衡器频谱跟着变、mpv 源仍是
  静态线（设计如此）——已记入 `docs/TARGET-VERIFY.md`

### QYP3-047 频谱只留一个 + 经典弹跳柱（移除瀑布）`[x]`
- 诉求（用户）：播放页面出现两个频谱（下方精简版 + 上方完整版），只保留下方
  精简版；移除瀑布；柱状频谱改成经典风格的弹跳元素
- 改动：
  - `pages/Music/index.tsx` 移除顶部 `<SpectrumGraph>` 块（播放时只剩底部播放条
    的拾音器，同屏不再有两个频谱）
  - 新增 `components/Visualizer/bars-painter.ts`：经典频谱分析仪的弹跳柱——
    按"格"点亮的分段 LED（琥珀 → 橙 → 红）+ 顶端峰值帽，峰值帽按 `dt`
    **缓慢下落**（`FALL_PER_SEC = 0.55`）而不是跟着电平瞬间归零
  - `Visualizer`（48 柱/8 段，24px）与 `SpectrumGraph`（56 柱/16 段）都改用该
    painter；`SpectrumGraph` 内部的瀑布图 / `SpectrumChart` / `downsampleSpectrum`
    / `heatColor` / `playback.spectrumChart` 持久化全部删除
  - 无真实数据（mpv 引擎）的诚实行为不变：拾音器静态进度线、频谱图提示
    "无法显示真实频谱"，绝不假跳动
- 顺手修：`Visualizer` 的 `draw` 里 `last = now` 推进在算 dt **之前**，
  传给 painter 的 `dt` 恒为 0 → 峰值帽永远钉在顶上不落；改成先算 `dt`
- Evidence: `tests/renderer/music/bars-painter.test.ts` 新增 7 例（下采样取峰值、
  点亮格数与钳制、分段配色、静音时只画空柱、峰值帽缓落并最终消失）；
  `spectrum-graph.test.ts` 去掉瀑布两项、补"不再有图表切换"；
  `visualizer.test.tsx` 频谱例改成断言 LED 配色与峰值帽；
  typecheck 双配置 + 全量 967 绿，三构建通过
- 待目标机验证：只出现一个频谱、弹跳与峰值帽手感、24px 下分段不糊、
  精简浮窗与设置里都找不到瀑布入口——已记入 `docs/TARGET-VERIFY.md`

### QYP3-048 频谱加高 + 播放条上的显隐开关 `[x]`
- 诉求（用户）：频谱区域稍微加点高度；播放控件处增加一个是否显示频谱的按钮
- 改动（`components/MusicMiniBar/index.tsx`）：
  - 拾音器高度 24 → 32（`VISUALIZER_HEIGHT` 常量），LED 分段在老机分辨率下
    也分得清；`App.tsx` 的 `pb-28` 让位空间仍够（整条约 98px）
  - 控制条新增「显示/隐藏频谱」按钮（`Activity` 图标，放在歌词按钮左侧），
    `aria-pressed` 反映当前态；关掉时整块 canvas 不渲染、rAF 随之停
    （不是画成空白，也不再占 CPU）
  - 开关持久化到 `playback.showSpectrum`，走 SETTINGS 的 JSON 对称契约
    （GET 回来是 boolean，默认开）
- Evidence: `mini-bar.test.tsx` 增 3 例（点一下收起并落库、再点展开、
  持久化值说关就关不渲染 canvas）；typecheck 双配置 + 全量绿，三构建通过
- 待目标机验证：32px 下弹跳柱观感、开关即时生效且重启后保持——
  已记入 `docs/TARGET-VERIFY.md`

### QYP3-049 播放条重新排版（频谱与进度并存、进度可操作）`[x]`
- 诉求（用户）：暂停时频谱消失、被一根没用的进度条替代（二者本该同时显示）；
  播放按钮右边那根进度条太窄且点不动，应独占一行；宽度挤压把按钮压成了椭圆
- 改动（`components/MusicMiniBar/index.tsx`，四行布局：频谱 / 曲名+时间 /
  进度条 / 按钮）：
  - 进度条独占一行，外框 16px 高便于点击；`role="slider"` + 点击 seek +
    键盘 ←/→ ±5s（Shift ×30）、Home/End 到头尾（自绘控件必须补键盘路径）
  - 按钮统一 `ICON_BTN`/`PLAY_BTN`（32×32 / 36×36）且 `flex-shrink-0`，
    放不下换行而不是压缩——椭圆就是这么来的
  - `Visualizer` 暂停时**冻结最后一帧**（`FrozenFrame` + `keep()` 复用缓冲），
    不再退化成进度线；无真实数据（mpv）时改画一根静音底线，不再画进度
    （进度归播放条），因此 `Visualizer` 去掉了 `position`/`duration` 两个 prop
  - `painter` 与冻结帧移入 ref：`position` 此前在 effect 依赖里，进度每走一秒
    就重建动画循环，峰值被打回当前电平、暂停也冻不住
  - `App.tsx` 停靠条让位 `pb-28` → `pb-40`（四行布局约 140px 高）
- Evidence: `mini-bar.test.tsx` 增 4 例（频谱与进度是两行且各就各位、点击 seek、
  键盘 seek、所有按钮都带 `flex-shrink-0`）；`visualizer.test.tsx` 增"暂停冻结
  最后一帧"，两条"静态进度线"用例改成断言静音底线；typecheck 双配置 + 全量绿，
  三构建通过
- 待目标机验证：竖屏停靠态四行观感、进度条点击/拖动与键盘手感、按钮不再变椭圆、
  暂停时频谱冻结在最后一帧而不消失——已记入 `docs/TARGET-VERIFY.md`

### QYP3-050 mpv 音源的离线频谱（ffmpeg 可选依赖）`[x]`
- 诉求（用户）：有部分音乐是用的 mpv 播放，而且没有频谱，可以改用 ffmpeg 解决吗
- 调研（本机实测）：① mpv 0.32 的**编码模式是坏的**（`--o=out.wav --of=wav`
  每帧 `[ao/lavc] error encoding at 0`，产出 0 字节；wav/flac/mp3 源都一样）
  → "拿 mpv 当 ffmpeg 用、不引入新依赖"这条路走不通；② 本机有 `/usr/bin/ffmpeg`
  6.1.5：APE(5:21,30MB) → WAV 1.2s、FLAC 2.1s；③ 用户库里真正走 mpv 的极少
  （214 首里 1 首 APE）+ Emby 上 codec 非直解的条目
- 方案（用户选定）：**C 离线预计算频谱 + ffmpeg 探测降级**——不改播放路径
  （声音仍由 mpv 播），只把频谱算好存起来按进度回放
- 改动：
  - `src/main/modules/music-spectrum/`（新）：`spectrum-format.ts`（32 字节头 +
    frameCount×48 字节帧，magic/版本/截断校验）、`pcm-fft.ts`（手写 radix-2 FFT +
    Hann 窗 + log 频带 + dB 量化；**fps×hop≡sampleRate** 从而零漂移）、
    `ffmpeg-locator.ts`（`~/.local/bin/ffmpeg` → PATH，`-version` 探测，含否定结果
    会话内缓存）、`ffmpeg-decode.ts`（解到 stdout 的 s16le/mono/24k，**同步**挂
    stdout/stderr data——硬性约束 3；90s SIGKILL、AbortSignal）、`spectrum-cache.ts`
    （sha1 内容寻址 + 原子写）、`index.ts` 的 `MusicSpectrumService`（并发 1、
    同曲幂等、失败/无 ffmpeg 会话内不重试、换曲目立即取消、超配额触发 sweep）
  - 主进程接线：`cache-manager` 加 `MUSIC_SPECTRUM_QUOTA_BYTES(64MB)` 与
    `CONCURRENCY_BUDGET.spectrum=1`；`ipc/index.ts` 注册 `music-spectrum` 分区 +
    `MUSIC.GET_SPECTRUM` + 在 `PLAYER.LOAD_FILE` 的 `audioChain`（=音乐且 mpv）分支
    用**同一份** `effectiveHeaders` 派发任务（绝不再 `take` 一次，单次消费语义）；
    `main/index.ts` 的 will-quit 同步 `cancelMusicSpectrum()`
  - 渲染层：`player/spectrum-anchor.ts`（mpv 位置是 1Hz 离散推送，按
    `(now-at)` 外推，暂停冻结）、store 的 `getSpectrum()` 在 mpv 引擎下返回当前位置
    的帧（零拷贝 `subarray`，数据放模块级变量不进 zustand）、订阅式触发拉取 +
    `ON_SPECTRUM_READY` 推送重拉（`spectrumRequestId` 丢弃过期回包）、
    `MusicMiniBar.resolveMode` 的 auto 恒为 spectrum、`SpectrumGraph` 门禁改成
    "有数据即画"（不再看引擎）
  - 设置：`playback.offlineSpectrum`（默认开）+ 音乐设置页说明
- Evidence: `tests/main/music-spectrum/` 6 个文件 38 例（格式往返/损坏、FFT 正弦
  定位与 12 帧对齐、ffmpeg 参数契约、注入式 spawn 的 ENOENT/abort/timeout 与
  **>64KB 流不死锁**、服务幂等/取消/配额、以及 `it.skipIf` 守卫的**真 ffmpeg 端到端**
  用 lavfi sine 断言峰值落在 1kHz 频带）；渲染层 anchor 纯函数 4 例 + bridge
  离线频谱 4 例；真实 APE 手动端到端：3860 帧（5:21 × 12fps ✓）、185KB 缓存、
  本机耗时 1.0s；typecheck 双配置 + 全量 1022 绿 + 三构建通过
- 待目标机验证：有/无 ffmpeg 两态、老机解码时播放不卡、长曲目不失控、
  频带观感、缓存目录与诊断——已记入 `docs/TARGET-VERIFY.md`
- 记录在案的红线变更：`docs/PHASE3-PLAN.md` §10 风险 4 原为"不引入 ffmpeg
  依赖"，因 mpv 编码模式实测不可用，改为**可选依赖 + 探测降级**

### QYP3-051 窗口与模式记忆（下次启动保持上次的模式）`[x]`
- 诉求（用户）：追加窗口和模式记忆，如果是音乐模式，或者精简窗口，下次打开需要
  保持上次的模式
- 澄清（用户选定）：① 精简浮窗**原样恢复**（启动就是右上角小窗，显示"未在播放"
  + 两个「还原窗口」逃生口）；② 正常窗口的**大小/位置/最大化一起记**
- 现状：此前**没有任何几何持久化**（`createWindow` 硬编码 1600×900），
  `compact-window.ts` 的 `state/profile/musicMode` 是模块级内存、不跨进程
- 改动：
  - `src/main/modules/ui-shell/window-state.ts`（新）：`window.memory` =
    `{profile, music, bounds, maximized}`；纯函数 `normalizeBounds` /
    `parseWindowMemory`（坏 JSON、非法 profile、非整数、非正宽高一律 null）/
    `resolveRestoreBounds`（留 80×48 可见、离屏回主屏居中、比屏大就缩到工作区）；
    接线 `attachWindowMemory`（resize/move **debounce 500ms 且仅 profile==='normal'
    且未最大化**、maximize/unmaximize 立即、close 同步 flush）+
    `flushWindowMemory`（will-quit 兜底）+ `restoreWindowProfile`
  - `compact-window.ts`：`getProfileName` / `minSizeForProfile` /
    `setNormalBoundsSeed`（**关键**：不预置的话进音乐/浮窗时会把构造出来的窗口
    bounds 当成"正常几何"，退出就回不到用户尺寸）/ `setProfileChangeListener`；
    `applyProfile` 的快照改用 `getNormalBounds()`（最大化时 `getBounds()` 是最大化
    矩形，退出音乐会留下"最大化大小但没最大化"的怪状态）
  - `main/index.ts`：`createWindow` 里读记忆 → `resolveRestoreBounds` → 按 profile
    给构造参数（**最小尺寸必须按 profile**，否则 1280×800 下限把浮窗顶回去）→
    先 `attachWindowMemory` 再 `restoreWindowProfile`；`ready-to-show` 里按记忆
    `maximize()` 再 `show()`
  - `App.tsx`：`CompactModeHost` 两个 effect **合成一个**（分开写时"进入"那个会
    先覆盖 `prevEngine`），退出条件改成 `!engine && was`——只在会话真正结束时还原，
    否则冷启动回填的浮窗第一帧就被撤销；导出供测试
- Evidence: 新增 `tests/main/ui/window-state.test.ts` 19 例、改
  `tests/main/ui/compact-window.test.ts`（+5 例：seed 后退出音乐/浮窗回到记忆几何、
  seed 只生效一次、形态通知、幂等不重复通知）、新增
  `tests/renderer/music/window-restore.test.tsx` 6 例（**同时挂两个宿主**钉住竞态：
  冷启动浮窗不被撤销、会话结束才还原、video 接管 mpv 也还原、自动进入不回归）；
  typecheck 双配置 + 全量 1052 绿 + 三构建通过
- 待目标机验证：最大化/浮窗/竖屏重启恢复、拔副屏后位置夹回、隐藏窗口期间
  `maximize()` 在目标 WM 是否生效、记忆损坏回落——已记入 `docs/TARGET-VERIFY.md`
- 记录在案的红线变更：AGENTS.md「模式不持久化」两处（窗口/托盘段与 UI 约定段）
  与 `app-mode-store.ts` / `WindowProfileHost.tsx` 注释同时改写；音乐模式手动改的
  尺寸**仍不记忆**（每次重算标准 460×820，与"竖窄屏是固定形态"的既有设计一致）

### QYP3-052 音乐列表时长（扫描期补齐 + 播放期回填）`[x]`
- 诉求（用户）：音乐列表为什么有的显示时长有的不显示
- 查证：`music_tracks.duration` 唯一来源是扫描期解析标签，而解析器**只对 FLAC
  （STREAMINFO）与 moov 在头部的 m4a 算时长**。用户库 214 首里 67 首为空：65 首
  mp3 全部为空（ID3 分支只取文字帧，不读 TLEN、不解析 MPEG 帧头）、1 首 APE
  （无时长解析）、1 首 m4a（文件已从磁盘删除的残留行）
- 方案（用户选定）：**补解析 + 播放时回填**（不做 ffprobe 逐个探测：老机太慢）
- 改动：
  - `tag-parser.ts`：mp3 时长优先级 **Xing/Info 总帧数 → ID3 TLEN → CBR 估算**；
    CBR 估算必须"前 40 帧码率完全一致"才认——VBR 无 Xing 时首帧码率毫无代表性，
    按它估实测差 2~4 倍（最大差 1125s），宁可留空；APE 读 `MAC ` 头的
    blocksPerFrame/finalFrameBlocks/totalFrames/sampleRate（<3.98 的老布局不猜）；
    `parseAudioTagsFromBuffer` 加 `fileSize` 第三参（CBR 估算用，缺省就不估）；
    导出 `AUDIO_DURATION_PARSER_VERSION`
  - 扫描器：增量跳过（指纹 size:mtime）会让重扫连标签都不读 → 加
    `durationScanVersion` 闸门，落后时只对"缺时长"的行强制解析一次，收尾写回
    版本号；**视频来源的扫描绝不写这个版本号**（否则音乐来源永远等不到补解析）
  - 播放期回填：`repository.setMusicTrackDuration` + `MUSIC.SET_TRACK_DURATION`
    + preload + store 里的 `maybeReportDuration()`（webaudio 的 `onTime` 与 mpv 桥
    两个调用点都接；trackId>0、库里已有且差 ≤2s 不打扰、每曲一次哨兵、失败静默）
- Evidence: tag-parser +8 例（Xing/TLEN/VBR 不猜/CBR+fileSize/无 fileSize/裸 mp3/
  APE/老 APE 布局）、local-scan +3 例（版本落后补一次并回调、版本最新或已有时长
  不重读、视频来源不写版本号）、music-catalog +1 例、渲染层 2 个文件 6 例（两条
  时长落地路径都覆盖）；**真实库副本端到端**：214 首/67 缺 → 扫一次后 210 首/6 缺
  （cleanupMissingMusic 顺带清掉 4 行失效行），解析成功的 58 首与 ffmpeg 误差 0；
  typecheck 双配置 + 全量 1074 绿 + 三构建通过
- 待目标机验证：重扫补齐、再扫不重读、播放回填、WebDAV 仍为空——已记入
  `docs/TARGET-VERIFY.md`
- 本轮记录在案但未做的缺口：
  - **WebDAV 的 `readAudio` 仍未接**（网络读 512 KiB/首的成本，计划 §6 的原决定）
    → WebDAV 曲目时长靠播放回填；若以后要扫描期就有，接
    `WebDavSourceAdapter.open(locator, signal, 'bytes=0-524287')` 即可
  - **搜索页不显示时长**：`unified-query.ts` 的 music 查询没 SELECT duration，
    与"列表里有的显示有的不显示"是两回事
  - **CUE 分轨无时长**：`music_cue_entries` 只有 start/end（最后一轨 end 为 null），
    且 CUE 行不在列表里按时长展示；本机库里 0 条，未验证
  - **ID3 标签 >512 KiB 的 mp3**（用户库 3 首，内嵌封面太大）扫描期读不到音频帧，
    只能等播放回填；要覆盖得二次按偏移读

### QYP3-053 音乐不写播放历史，只存「当前播放状态」`[x]`
- 诉求（用户）：播放音频不需要记录进度，只需要保存当前播放状态，包含播放曲目
  和进度，不要存入播放历史中
- 口径（用户选定）：① 下次启动**恢复播放条**（曲目+进度，不自动出声，点播放继续）；
  ② **不再按曲目续播**（点同一首从头播）；③ **服务器（Emby/Jellyfin）回传保留**；
  ④ **清掉存量**音乐记录（视频记录不动）
- 改动：
  - 新增 `playback-state/now-playing.ts`：`app_config` 里**一条**记录（type track/
    server + 定位键 + 标题/艺人/时长 + position + updatedAt）；解析与落盘共用同一套
    规则（坏 JSON / 缺 title / position 非法 / 缺定位键 → null），**不存 path**
    （本地音轨永远按 `(sourceId, trackId)` 查 `music_tracks`）
  - IPC：删 `MUSIC.REPORT_PROGRESS`（写 watch_history + playback_progress 的那条），
    加 `SET_NOW_PLAYING`（校验复用 `parseNowPlaying`）/`GET_NOW_PLAYING`（track 分支
    查库补成完整 `MusicTrackInput`，音轨或来源已删则清记录回 null）；
    `REPORT_SERVER_PROGRESS` 去掉本地两表写入，服务器回传/playSessionId 原样保留
  - mpv 引擎音乐：`PlaybackStateManager` 加 `isMusic` 门禁（接
    `isMpvMusicActive()`），音乐跳过 `addWatchHistory`/`saveProgress`；服务器回传
    与本地写解耦后照常触发（对视频是等价重构）
  - 删音乐 per-track 续播：`resume-resolver.ts` 去掉 `resolveMusicResumeTarget`，
    `playback-resolver.ts` 音乐分支 `startPosition` 恒为 0（顺带删掉那段读
    `playback_progress` 的 WebDAV 键）
  - 渲染层：store 加 `restored/restoreInput/restorePosition` +
    `initNowPlaying()/resumeRestored()`；`playQueue` 加第 3 参
    `opts.startPosition`（恢复态起播的唯一入口）；`pushNowPlaying()` 节流 5s
    （暂停/跳曲/停止/收尾立即，含 mpv 桥）；`NowPlayingHost` 挂在 `Shell` **之外**
    （浮窗分支不渲染音乐条）；`MusicMiniBar`/`CompactPlayer` 的播放键在 engine 为
    null 时走 `resumeRestored()`
  - **恢复态不算音乐会话**（engine 保持 null）：否则冷启动就自动进精简模式、
    全局媒体键被抢走
  - migration 011：删 `watch_history`（local/webdav）与 `playback_progress`（local）
    里的音频行（后缀表与 classifier 的 `AUDIO_EXTENSIONS` 对齐，含 `.wav`、lower()
    兜大写）；**服务器行分不出音视频一律不动**
- 顺带修掉的既有 bug：`MUSIC.REPORT_PROGRESS` 的 webdav 分支调
  `saveProgress({mediaType:'webdav'})`，而 `playback_progress.media_type` 的 CHECK
  只允许 local/jellyfin/emby → INSERT 必然抛错（渲染层 `void` 未 catch）。该写入
  已随通道删除
- Evidence: 新增 `tests/main/playback/now-playing.test.ts` 8 例、
  `playback-state-music.test.ts` 5 例、`tests/renderer/music/now-playing-restore.test.tsx`
  7 例；改 `catalog-migrations`（+1 例：mp3/wav/大写 .APE/webdav flac 行消失，
  mkv 与 emby 行保留；版本断言 → 11）、`source-purpose`（版本 → 11）、
  `playback-resolver`（音乐不再读 getProgress、startPosition 恒 0）、
  `server-progress`（本地/WebDAV 改断言 `setNowPlaying`）；typecheck 双配置 +
  全量 121 文件/1096 绿 + 三构建通过；**真实库副本跑 migration 011**：库停 010，
  watch_history 28 → 6、playback_progress 27 → 6（22/21 条音频行清除，被清的都是
  曲目名含 `sine.wav`；保留的 6+6 是影视与服务器行），与独立 JS 分类器算出的
  期望集合逐 id 相等（临时验证测试已删）
- 待目标机验证：重启后播放条恢复且不出声、点播放从上次位置继续、历史页不再出现
  音乐、服务器端「继续收听」照旧、恢复态下媒体键不生效——已记入
  `docs/TARGET-VERIFY.md`
- 本轮记录在案但未做的取舍：
  - 恢复态 `isMusicSessionActive()` 为 false → 全局媒体键不路由到音乐，只有播放条
    上的按钮能起播（可接受：没有会话就不该抢媒体键）
  - 上次退出时若是精简浮窗 profile，浮窗里显示 `CompactPlayer`（恢复的曲目显示在
    标题位，播放键已加兜底）
  - `PLAYER.LOAD_FILE` 仍会为 mpv 本地音乐 `upsertLocalMedia`，留下无消费方的
    orphan 行（本轮不动）

### QYP3-054 模式恢复连默认页一起恢复 `[x]`
- 诉求（用户）：音乐模式退出后重启，竖屏布局保持了，但内容是影视首页——
  "没有完全记住窗口状态"
- 查证：`WindowProfileHost` 回填时只调了 `appModeStore.setMode('music')`，而
  **导航**只发生在 `Navigation.handleModeChange` 里（切换语义的一部分）。
  冷启动路由必然是 `/` → 竖屏窗口停在影视首页上，只有侧栏是音乐那套
- 改动：恢复 `music` 时若处于初始路由 `/` 则 `navigate('/music', {replace:true})`；
  **只在初始路由上补跳**——热重载会保留深链（如 `#/settings`），不能抢用户的
  当前页。精简浮窗（profile=compact 且 music）同样生效：还原浮窗后落在音乐页
- Evidence: `tests/renderer/window-profile.test.tsx` 改为 MemoryRouter 包裹，
  +2 例（冷启动落 `/music`、深链不劫持），共 4 例绿；typecheck 双配置通过
- 待目标机验证：音乐模式退出重启 → 竖屏 + 音乐列表（已记入 TARGET-VERIFY）

### QYP3-055 音乐列表只认音乐来源，支持来源转域 `[x]`
- 诉求（用户）：音乐列表是以前在影视模式里加媒体库扫出来的，现在音乐模式的
  媒体库里已经不显示那个来源了，但音乐列表还在
- 查证：真实库只有一个来源（`/home/qiuyuan/Music`，migration 010 把它归一成
  `video`），214 首音轨全挂在它上面；而音乐查询（曲目/专辑/歌手/收藏/搜索）
  只按 `kind IN (local, webdav)` 过滤，不认 `purpose` —— 域拆了、范围没拆。
  也不存在任何把来源转回音乐域的入口（表单只在创建时定用途）
- 口径（用户选定）：① 音乐列表只认音乐来源；② 加「改为音乐来源」入口把 214
  首找回来（不重扫）
- 改动：
  - `repository.listMusicSourceIds()`（`purpose='music'` 且 local/webdav）成为
    音乐范围的**单一来源**；六个 MUSIC 查询 handler 与 unified-query 的
    `musicSearch` 全部改走它
  - `resolver` 音乐分支校验来源 `purpose`：非音乐域 → `UNAVAILABLE`（歌单残留
    的旧引用得到明确报错）；`GET_NOW_PLAYING` 的来源校验同步收紧
  - `CATALOG.SOURCE_SET_PURPOSE` + `repo.setSourcePurpose`：只改用途标签，
    已索引内容不动（转回音乐域后音轨立即回到列表）；扫描进行中拒绝转换
  - 媒体库页（两种模式）加「其它来源」区：不属于本域的目录/WebDAV 来源一键
    转域，confirm 确认 + Toast；转过去的来源从此出现在本域管理区
- 取舍记录：转换是**可逆**的（两种模式都有入口）；拆域遗留的"影视域音轨"不删
  数据（用户选了转域方案后，老行要么随转域复活、要么留在库里不可见——后者
  是用户明确把来源留在影视域的语义）
- Evidence: `music-catalog` +2 例（统一搜索跳过影视域音轨、
  `listMusicSourceIds`/`setSourcePurpose` 往返）、`playback-resolver` +1 例
  （影视域音轨拒绝播放）、`media-sources/purpose` 改 2 例 +2 例（转域区渲染/
  确认转换/取消不调 IPC）；相关 15 文件 179 例绿；typecheck 双配置通过
- 待目标机验证：音乐媒体库把 `/home/qiuyuan/Music` 转为音乐来源 → 214 首立即
  回到列表且可播；转回影视域后音乐列表变空——已记入 TARGET-VERIFY

### QYP3-056 菜单点不动：模式恢复把路由无限弹回 `/music` `[x]`
- 诉求（用户）：侧栏菜单点不动；要求开调试接口（CDP）自查功能可用性
- 现场（CDP 9222 复现）：点「歌单」「设置」路由纹丝不动；
  `location.hash='#/playlists'` 也在几百毫秒内被弹回 `#/music`，
  history.length 持续增长 → 无限导航循环
- 根因：QYP3-054 的恢复 effect 依赖 `[navigate]`，而 react-router v6 的
  `useNavigate` 在 **location 变化后返回新函数**——恢复导航本身触发 effect
  重跑 → 又 navigate 回 `/music` → 循环。任何菜单点击都在几毫秒内被弹回
- 修复：navigate 经 ref 在挂载时捕获一次，effect 改空依赖；**不加**"只跑
  一次"哨兵——StrictMode（dev）双跑时第一次被 cleanup 取消、第二次被哨兵
  挡住，恢复会整个失效（实测踩过）；恢复的两个动作天然幂等，重复无害
- 顺带澄清（非 bug）：调试窗口一度全空是本机 vite 掉了导致 renderer 加载
  chrome 错误页（`#root` 0 子节点、无 JS 错误），与代码无关
- Evidence：CDP 功能巡检 10/10（导航不弹回、history 不增长、歌单/音乐媒体库/
  设置/音乐页渲染、转域入口在位、模式往返切回音乐竖屏、全程无 JS 错误）；
  单测全量回归见提交；typecheck 双配置通过

### QYP3-057 实时频谱左重右轻：内置引擎改对数分带 `[x]`
- 诉求（用户）：频谱图左边明显比右边活跃，右边的跳动高度永远不超过左边
- 根因：`AnalyserNode` 给的是 0~22kHz **线性等宽**的 1024 个 bin，
  `downsamplePeaks` 把它等分成 48/56 段——左边几根柱覆盖 0~4.6kHz 的能量
  富集区（人声/贝斯），右边覆盖 10~22kHz 的"能量沙漠"，分布必然左重右轻。
  mpv 音源的离线频谱（QYP3-050）当时就是按 40Hz~8kHz **对数分带**算的
  （`pcm-fft.bandBinRanges`），所以只有内置引擎的实时频谱是线性——两引擎
  观感不一致
- 改动（用户选定：对齐 log 分带）：`WebAudioEngine.getSpectrum()` 在引擎内
  按同一套 `bandBinRanges`（复用 pcm-fft 纯数学模块，40Hz~8kHz、64 带）取
  每带峰值再返回；画图方的 `downsamplePeaks` 不动（对已分带的 64 段做线性
  下采样 = 柱子在 log 频轴上等距）。字节刻度不变，归一化仍在画图方
- Evidence: 新增引擎测试（bin 2 → 第 0 带、bin 300 → 第 61 带、64 带长度、
  8kHz 以上为 0）；相关 6 文件 53 例绿；全量回归 + typecheck + 三构建通过
- 待目标机验证：内置引擎放一首歌，柱状频谱左右都有跳动、幅度可比（已记入
  TARGET-VERIFY）

### QYP3-058 歌词被频谱压住 / 精简浮窗频谱残影 / 精简模式没有歌词 `[x]`
- 诉求（用户）：① 歌词弹窗被频谱挡住；② 精简模式的频谱效果重叠显示异常；
  ③ 精简模式也需要显示歌词
- 根因：
  ① QYP3-048 给 MusicMiniBar 加频谱行后高约 150px，LyricsPanel 仍停在
  `bottom-20` 且 `z-40` 与播放条同级——渲染顺序上它在播放条**之前**，
  同级 z-index 让播放条的频谱 canvas 把它下半截盖住
  ② `SpectrumGraph` 的 draw 循环从不 `clearRect`：bars-painter 的 `paint`
  只画"点亮的 LED 格 + 峰值帽"，不清底——上一帧的柱子残留叠加（Visualizer
  一直清底所以没事，SpectrumGraph 从建组件起就漏了）
  ③ CompactPlayer 根本没有歌词入口
- 改动：
  ① LyricsPanel 加 `placement: 'above-bar' | 'overlay'`（默认 above-bar）：
  above-bar 抬到 `bottom-44`（176px，越过 150px 的播放条）+ `z-50`；
  overlay 用 `top-10 bottom-3 left-3 right-3` 铺满浮窗（不用 max-h 夹——
  浮窗只有 ~300px 高，46vh 会把面板压短）
  ② SpectrumGraph draw 在 `painter.paint` 前 `clearRect`
  ③ CompactPlayer 加 Mic2 按钮（aria-pressed）+ overlay 版 LyricsPanel
  （有 `currentSource` 才渲染）；歌词拉取仍在 loadfile 之后且失败静默，
  服务器曲目只读
- Evidence：新增单测（placement 类名 2 例 + 浮窗歌词开关 1 例）；
  CDP 现场巡检 9/9（above-bar 面板底边 ≤ 播放条顶边、overlay 几何铺满、
  进出精简往返、无新增 JS 异常）；typecheck 双配置通过
- 待目标机验证：主窗口歌词面板完整露出频谱上方；浮窗频谱无残影；
  浮窗歌词开合正常（已记入 TARGET-VERIFY）

### QYP3-059 暂停时频谱整体回落（不再冻结最后一帧） `[x]`
- 诉求（用户）：暂停的时候，频谱图应该全部回落
- 原行为（QYP3-049 引入）：暂停把最后一帧真实数据冻结在画布上（Visualizer
  `frozenRef` 只重画一次；SpectrumGraph effect 早退保留画布）——用户反馈
  冻结看着像还在出声
- 改动：
  ① bars-painter 加 `settled()`（峰值帽全部 ≤0.02）并导出 `FALL_PER_SEC`；
  新增 `createSpectrumDecay`（播放中缓存最新快照，暂停后按 τ≈150ms 指数
  衰减喂回 painter——柱体平滑回落、峰值帽随后落底）
  ② Visualizer 频谱模式接 decay；波形模式新增柱高缓冲按同款速率线性回落；
  落定后 `cancelAnimationFrame` 停帧不空转；复播从活数据立即恢复
  ③ SpectrumGraph 同款接入（painter 改为 effect 内局部、decay 走 ref）
  ④ **dt 钳制 ≤100ms**（CDP 实测踩到的关键坑）：effect 重跑（暂停/恢复
  触发，isPlaying 在依赖里）后 `last` 从 0 起算，首帧 dt 是页面运行时长，
  `exp(-dt/150)≈0` 会把回落快照一帧清空——柱子瞬间消失而非回落
- 无真实数据的音源（mpv 无离线频谱）行为不变：仍画静音底线；未起播就暂停
  也是底线（没有可回落的东西）
- Evidence：painter `settled()`/decay 单测；visualizer 测试重构（假 rAF 队列
  + 真实 cancel 语义 + getContext 跨 rerender 存活，"播放→暂停"时序可测）；
  CDP 实测 8/8（受信任点击起播→画布有内容→暂停 0.35s 仍在回落→2.85s 全空
  →复播立即恢复→无 JS 异常）；test:render 49 文件 328 例绿；typecheck 双
  配置 + build:renderer 通过
- 待目标机验证：暂停观感——柱体平滑回落约 2 秒静止，复播立起（已记入
  TARGET-VERIFY）

### 本轮记录在案但未修的缺口
- `upsertMusicTrack` 的 `duration` 播放期回填是无条件覆盖（与 QYP3-052
  语义一致：旧值本来就不准），但若未来有"更权威"的时长来源需要另行约束

### QYP3-060 WebDAV 音频接上真标签：readAudio/封面/歌词 `[x]`
- 背景（记录在案的缺口，用户要求继续推进后处理）：WebDAV 没有
  `readAudio`/`coversDir`/`lyricsDir` 接线，标签/封面/歌词全靠目录启发式
- 改动：
  ① `createWebDavScanDriver` 新增 `readAudio` 钩子——
  `adapter.open(locator, signal, 'bytes=0-524287')`（与播放解析同款 range
  探针）+ bounded GET（512 KiB 窗口与本地一致）；服务器忽略 Range 返回
  200 全量时在窗口处抛错，上层按读取失败退化启发式，扫描不中断
  ② `coversDir`/`lyricsDir`/`durationScanVersion`/`onDurationScanVersion`
  四个依赖透传（ipc 层与本地驱动同源），封面/歌词落同一套缓存分区；
  增量跳过在 readAudio 之前，未变文件零成本
  ③ 顺带修掉同清单里的语义缺口：`upsertMusicTrack` 的
  `has_cover`/`has_lyrics` 改 **tri-state**（undefined/null = "本轮没读
  到"→ COALESCE 保留旧值；true/false = 确定性结论 → 覆盖）。扫描器只在
  真的读到并解析了头部时才传布尔值
  - 实现陷阱（踩过并写入注释）：UPDATE 分支不能写
    `COALESCE(excluded.has_cover, has_cover)`——`excluded` 拿到的是
    VALUES 侧 `COALESCE(?,0)` 兜底后的 0，tri-state 会被吞；UPDATE 分支
    用同值再绑一次的裸参数
- Evidence：仓储 tri-state 单测（undefined 保留 / false 覆盖 / null 保留
  0 / 新行兜底 0）；webdav-scan 新增 2 例（fixture 真字节经 bounded Range
  GET 解出 标题/歌手/专辑 + 封面歌词落盘 + Range 头断言 + 版本写回；
  ETag 变化强制重索引但读取失败 → 标志保留）；typecheck 双配置 +
  test:main 68 文件 748 例绿

### QYP3-061 平台基础模块：二进制定位与 mpv IPC 端点抽象 `[x]`
- 背景：1.5.0 跨平台改造第一步。mpv 通信当前硬编码 Unix Socket、二进制
  候选硬编码 Linux 路径；Windows 无 Unix socket（要用命名管道）、mpv 通常
  不在 PATH
- 改动：
  ① `modules/platform/` 新增 `binary-locator.ts`——mpv/ffmpeg 跨平台候选
  序列（QY_MPV_PATH/QY_FFMPEG_PATH 覆盖 → 打包内置
  `resourcesPath/mpv/` → 平台常规位置 → PATH 裸名兜底）。**Linux 分支输出
  与历史行为逐字节一致**（`~/.local/bin/mpv` + `LD_LIBRARY_PATH`，否则裸
  `mpv`）——这是硬纪律，测试里有逐字节断言
  ② `ipc-endpoint.ts`——`createIpcEndpoint()` 抽象：win32 命名管道
  （connect-probe 判就绪）vs Unix socket（existsSync 轮询判就绪）；
  `failed` 回调每个 tick 检查（SPAWN 失败可抢在超时前报告）
  ③ `mpv-process.ts` 接线：每次 start() 建端点，readiness 走
  `waitUntilReady(5000)`；`MpvIpcClient` 用 `net.createConnection`，两种
  端点零改动通用；`mpv-probe-spike` 同步接入
- 测试：binary-locator 11 例（含 Linux 逐字节断言 + win32 在 POSIX 主机上
  用 `win32.join` 确定性断言）、ipc-endpoint 4 例；typecheck 双配置绿

### QYP3-062 Windows 生命周期与路径硬化 `[x]`
- 改动：
  ① `player-core` quit()：Windows 上先发 mpv `quit` IPC 命令（1s 竞速）
  再断连/杀进程——SIGTERM 在 Windows 等价 TerminateProcess，直接杀会丢
  播放进度；Linux/mac 不变（SIGTERM 即优雅）
  ② `playlist-io` 新增 `localTrackFileUrl()`：win 盘符路径 →
  `file:///C:/...`（分段 encodeURIComponent）；POSIX 保持原 `encodeURI`
  **逐字节不变**（历史导出兼容）。刻意不用 `pathToFileURL`——它按宿主
  平台解析，Linux 主机上会把 `C:\music` 当相对路径
  ③ `qy-file-url.ts` 抽出 `parseQyFileUrl()`（反斜杠归一/解码/去查询串），
  主进程 qy-file handler 改用它（顺带清掉调试 console.log）
  ④ `resource-guard` 拆 `cpuBusyRatio()` 纯函数；win32 用 `os.cpus()` 时间
  增量采样（首样无基线按 normal 兜底）
- 测试：qy-file-url 5 例、resource-guard-cpu 4 例、playlist-io file URL
  4 例；test:main 全绿

### QYP3-063 macOS/Windows 界面适配 `[x]`
- 改动：
  ① 托盘：darwin 用 `icon-tray-Template.png`（32px 黑色+alpha，
  `setTemplateImage(true)`，缺失回退彩色 PNG）；win 路径解析用
  `path.win32.resolve`（POSIX 主机 resolve 会毁坏 `C:\...`）
  ② 桌面歌词：`setIgnoreMouseEvents` 的 `forward` 选项仅 Windows 有效，
  非 win 传 `{}`（行为等价，不误导）
  ③ 主窗口：darwin 加 `titleBarStyle: 'hidden'` + `trafficLightPosition`
  （裸 `frame:false` 会吞掉红绿灯）；TitleBar 按
  `electronAPI.platform`（preload 新增字段）避让 76px/64px
  ④ `build/icon.png`（electron-builder 自动转 ico/icns 的源）
- 测试：tray/desk-lyrics 平台条件断言更新；typecheck + 全部测试套绿

### QYP3-064 三端打包配置与 mpv 预置脚本 `[x]`
- 改动：
  ① `scripts/fetch-mpv-win.js`——从 zhongfly/mpv-winbuild **固定 tag**
  （默认 `2026-09-20-e76a35ec95`，`MPV_WINBUILD_TAG` 可覆盖）下载
  `mpv-x86_64-*.7z`，解压后只留 `mpv.exe`/`mpv.com`（全静态构建，无
  DLL 依赖）。幂等：`build/mpv-win/mpv.exe` 存在即跳过。**本机实测全流程
  通过**（31MB 下载 → 解压 → 瘦身）
  ② `scripts/collect-mpv-mac.sh`——brew mpv 的 otool dylib 闭包收集
  （跳过 /usr/lib、/System），平铺进 `lib/` 并改写
  `@executable_path/lib/`/`@loader_path/` 引用 + ad-hoc 重签名；Darwin
  上现场冒烟 `--version`；`QY_SKIP_MPV_BUNDLE=1` 定义化兜底（不打包
  mpv，运行时走 PATH）
  ③ electron-builder.yml：win（NSIS 安装版 + portable，x64，未签名）+
  mac（dmg x64+arm64，`identity: null`）段，各自 extraResources 挂 mpv
  预置目录；`electronDist` 从 yml 移到 linux dist 脚本
  `-c.electronDist=`（mac 双架构必须按架构下载 Electron，固定本地目录
  只有宿主架构）
  ④ package.json：`dist:win`/`dist:mac`/`fetch:mpv-win`/`collect:mpv-mac`
  脚本；test 脚本改 `cross-env`（Windows shell 不认 `VAR=1 cmd` 语法）
- 验证：`electron-builder --win --dir` 本机试打包成功——win-unpacked 里
  `QY Player.exe`（PE32+，icon 转换 OK）+ `resources/mpv/mpv.exe` 就位，
  与 binary-locator 候选路径精确吻合；签名步（winCodeSign 下载）本机网络
  失败，留 CI 验证；test:main/shared/quality 全绿

### QYP3-067 修复：音乐切引擎时两侧同响（多首同时播放） `[x]`
- 用户报告：切换音乐播放时有一定概率残留一个播放进程，多首同时播放
- 根因（排查确认，四个缺陷叠加）：
  ① **mpv→webaudio 切换从不停止 mpv**（首要）：音乐→音乐不经过视频
  LOAD_FILE，主进程不会结束 mpv 会话；mpv 音乐被压窗（vid=no）看不见，
  残留 mpv 继续放完上一首——与报告逐字吻合
  ② webaudio→mpv 直选分支漏 `engineSingleton?.pause()`（fallbackToMpv
  一直有，唯独直选分支没有）
  ③ **`playerControl('stop')` 在主进程无对应 case**——渲染层三处队尾停
  （next/prev）全部静默失败，放大 ①② 的影响面
  ④ 服务器曲目懒解析（秒级网络请求）期间用户换曲：旧解析回来照常 play()
- 改动：
  ① `player-core` 新增 `stop()`（mpv stop 命令，未启动幂等不抛）；
  PLAYER.CONTROL 补 `case 'stop'`（saveProgressNow final=true → 服务端
  Stopped 落位 → clearCurrentMedia，10s 定时器不再对旧媒体保存）；
  `PlaybackStateManager.saveProgressNow()` 公开
  ② webaudio 分支起播前 `engine === 'mpv'` → await playerControl('stop')；
  mpv 直选分支起播前 `engineSingleton?.pause()`
  ③ `WebAudioEngine.playCurrent` loadSeq 代数守卫：懒解析回来队列已前进
  → 让位不设 src；play() rejection 被新起播取代（abort 类）→ 吞掉不报错
- 测试：player-stop 2 例、playback-state saveProgressNow 2 例、
  web-audio-engine 让位/吞 abort 2 例；typecheck 双配置 +
  test:main 73 文件 782 例 + test:render 330 例全绿

### QYP3-068 修复：精简浮窗底部 ~50-60px 空白（窗口偏高） `[x]`
- 用户报告：精简浮窗下方一片空白约 50-60px，整体窗口偏高
- 根因：浮窗 300px 高，而 CompactPlayer 内容全是固定高度——SpectrumGraph
  64px + 组件自带 `mb-6`（24px 死边距，主窗口时代的遗留）+ 两行控件，
  合计 ~250px，剩余全沉底
- 改动：SpectrumGraph 改为**填满父容器**（唯一使用方就是 CompactPlayer）：
  根节点 `flex-1 min-h-0 flex flex-col`、去掉 `mb-6` 与 `height` prop，
  画布 absolute inset-0 随窗口伸缩（resize 用 clientHeight）；
  CompactPlayer 去掉 `height={64}`
- 验证：CDP 实测——频谱区 184px（原 64），最后子元素下方空白 = 12px
  （恰为 p-3 内边距），截图目视确认无空白；typecheck + test:render
  49 文件 330 例全绿（spectrum-graph 测试不依赖 height prop，无需改）

### QYP3-068b 精简频谱发糊：LED 格子分数坐标抗锯齿重影 `[x]`
- 用户追问：精简模式频谱"画质糊很多"
- 排查（CDP 实测排除法）：canvas 背板 = CSS 尺寸 = DPR 整数倍（374×134
  全 1:1，无缩放模糊）；painter 无几何缓存。放大截图定位真凶——每个 LED
  格右下有错位的暗副本：**fillRect 坐标全是分数**（barW=w/56=6.68、
  cellH=h/16=8.375 非整），canvas 抗锯齿把每条边摊成半透明过渡像素；
  格子仅 ~4.5×6px，边缘像素占比近半 → 糊/重影。迷你条 32px 小到看不出，
  精简模式格子大了就显形
- 改动：bars-painter 所有矩形像素对齐（x/bw/y/cellH/capH/peakY 取整）；
  Visualizer 波形柱同步处理。截图对比：重影完全消失，格子干脆
- 测试：bars-painter 断言只依赖数量与相对位置，取整不影响；typecheck +
  test:render 330 例全绿

### QYP3-068c 频谱柱配色改纯琥珀黄（去掉高度渐变） `[x]`
- 用户问渐变来源后拍板：改 `cellColor` 为纯琥珀黄
- 改动：bars-painter 删 `cellColor` 与三段 `BAR_COLORS`（low/mid/high），
  换单一 `BAR_COLOR`（rgba(255,209,102,0.95)）；点亮格循环外置一次
  fillStyle；峰值帽亮白不变。播放条拾音器与精简浮窗频谱同源生效
- 测试：bars-painter 断言全部格子为 BAR_COLOR；visualizer 引用同步改名，
  删 cellColor 用例；typecheck + test:render 49 文件 329 例全绿

### QYP3-068d 修复：恢复态起播后下一曲没反应（单曲队列） `[x]`
- 用户报告：点下一曲没反应，默认应该播放全部曲目
- 根因：`resumeRestored` 只把恢复的那一首放进队列（`playQueue([input], 0)`），
  单曲队列 + repeat off 下 `queue.next()` 返回 null——下一曲无路可走
- 改动：resumeRestored 对本地/WebDAV 恢复按「全部曲目」分页拉全（200/页）
  重建完整队列，恢复曲按 trackId 落回曲库原位；多页里找不到（已删除）或
  读取失败退回单曲队列，不阻塞起播；服务器曲目不在全部曲目域，保持单曲
- 测试：now-playing-restore 新增 2 例（250 首两页曲库 → queueLength/
  queueIndex=249 + next 可推进；getMusicTracks 拒绝 → 退单曲且正常起播）；
  typecheck + test:render 331 例 + test:main 782 例全绿

### QYP3-068e 修复：换曲到坏曲目时兜底认领错曲（下一曲卡死） `[x]`
- 用户复测下一曲仍无反应，devtools 报 `Uncaught (in promise) DOMException:
  NotSupportedError`（store 的 next 函数）——下一首解码失败且兜底没接住
- 根因（两个缺陷叠加）：
  ① `onError` 按 `store.current` 识别失败曲目，但 next() 期间引擎队列已
  前进到 B、store.current 还是 A——认领错曲，自救/兜底整个落空；上一轮
  排查时记过这条低概率竞态，恢复态重建大曲库后"下一曲命中坏曲目"从低概率
  变成必现路径
  ② `store.next()/prev()` 没有 catch——失败直接冒泡成 unhandled rejection
- 改动：
  ① `WebAudioEngine.onError` 增加 track 参数（`this.queue.current`，即
  正在加载失败的那首）；store 的 onError 优先用引擎上报的曲目并按 id 回查
  快照（权威 EngineExtTrack），守卫改看引擎队列位置（engine 仍在这首上）；
  自救成功后 syncFromEngine 把 store 对齐到引擎队列
  ② store.next()/prev() 包 try/catch——失败由 onError 接管，rejection
  不再冒泡
- 测试：direct-fallback 新增 1 例（next() 失败 → 兜底重播 B 且 next()
  不冒泡）；mock 引擎更新为真实语义（playQueue 记录 currentTrackId、
  onError 带 track）；typecheck + test:render 332 例 + test:main 782 例
  全绿

### QYP3-068f 修复：mpv 音源没有本地队列——下一曲=队尾 stop（真根因） `[x]`
- CDP 实测复现（`__qyMusicStore` dev 调试出口读全量状态）：第一首走 mpv
  引擎后 `next()` 落进"无队列 + repeat off → playerControl('stop')"分支，
  且 mpv 空闲后渲染层状态冻结（pos 不动、isPlaying true）→ 表象"没反应"
- 根因：`serverQueue` 只装服务器曲目（QYP3-025 设计），本地 mpv 音源
  （APE/兼容性优先/兜底 FLAC）从来没有队列；AGENTS"队尾 stop"只覆盖
  服务器场景
- 改动：store 新增 `mpvQueue`/`mpvQueueIndex`——
  ① playQueue 的 mpv 分支记整个列表（恢复态=全部曲目 200+，playFromList=
  所点列表）；webaudio 分支/stop() 清空
  ② next()/prev() 的 mpv 分支：serverQueue 优先，其次 mpvQueue 逐曲
  playQueue(全部列表, ±1)（repeat one 重播当前 / all 回卷 / off 队尾 stop）
  ③ fallbackToMpvNow 把 queueSnapshot 的 musicInput 列表带进 mpvQueue
  （webaudio 本地曲兜底后仍可上下曲）；服务器曲目仍走 serverQueue
  ④ attachMusicMpvBridge 的 eof 自动推进条件扩到 mpvQueue
  ⑤ store 挂 `window.__qyMusicStore`（仅 vite DEV），CDP 排查播放状态用
- 验证：CDP 实测全链路——mpv 音源 A → 下一曲 → webaudio B/C/D 逐曲推进
  （qlen 200、qidx 1→2→3、pos 持续前进、零 unhandled 异常）；
  typecheck + test:render 332 例 + test:main 782 例 + build:renderer 全绿

#### QYP3-068f 实机复验：上一曲/单曲循环/列表循环 `[x]`
- CDP 实测（200 首曲库，mpv 音源起播）：
  ① 单曲循环：next 重播同一首、进度归零 ✓
  ② 列表循环：next 前进 ✓；队尾 eof 自动回卷（199→0，index 0 为 mpv 音源
  按既有设计跳到下一首 webaudio 曲目落 qidx 1）✓
  ③ 上一曲：顺序播放 idx 3 → prev → idx 2 ✓；引擎跨 mpv↔webaudio 切换
  全程无 unhandled 异常 ✓
- 记录在案的边角（不修）：webaudio 队列里 prev 落在 mpv 音源曲目上时，
  onResolveError 的跳过方向恒向前（index+1）——表现为 prev"弹回"原曲。
  全库仅 APE 1 首走 mpv 引擎，触发面极小；若未来 mpv 音源占比升高再引入
  方向感知的跳过

### QYP3-068g 播放条补循环模式按钮 `[x]`
- 用户发现循环切换按钮"没了"——实际是播放条（MusicMiniBar）从未有过，
  它只存在于精简浮窗（CompactPlayer）
- 改动：`nextRepeat`/`repeatLabel` 从 CompactPlayer 挪到 music-playback-store
  （状态归属地，CompactPlayer 改为导入）；MusicMiniBar 收藏按钮旁补
  循环模式按钮（Repeat/Repeat1 图标，开启高亮，title 显示当前模式文案）
- 测试：compact-mode 测试导入路径更新；typecheck + test:render 332 例全绿；
  CDP 实测按钮点击循环 off→all→one→off，store 状态同步正确

### QYP3-068h 播放条补随机播放按钮 + mpv 队列的随机真生效 `[x]`
- 用户：还缺少随机模式（同循环按钮，播放条从来没有）
- 改动：
  ① MusicMiniBar 循环按钮旁补随机播放按钮（Shuffle 图标、aria-pressed、
  开/关文案，开启高亮）
  ② `next()` 的 mpv 分支支持随机：mpv 队列没有内建随机（只有 webaudio 的
  PlaybackQueue 有），开启时在整队里随机挑一首（排除当前）——否则随机按钮
  在 mpv 音源上是静默的假开关。prev 仍按队列回退（随机只影响"下一首"）
- 验证：typecheck + test:render 332 例全绿；CDP 实测——随机开后连续三次
  下一曲落到索引 21 / 170 / 13（非顺序推进），mpv→webaudio 跨引擎正常

### QYP3-068i 音乐模式去侧栏 + 窗口再收窄 `[x]`
- 用户：音乐模式左侧菜单栏去掉，进一步缩小尺寸，必要按钮设计到其他地方
- 改动：
  ① 新增 `components/MusicToolbar`（32px 横条）：左=音乐/歌单页签，
  右=音乐媒体库/设置/返回影视；窗口标题维护从 Navigation 接管（复用导出的
  `pageTitleFor`——侧栏在音乐模式不再挂载）；Shell 音乐模式不渲染 Navigation、
  main 去 `ml-14`
  ② 播放条/迷你条停靠偏移去掉 `left-14`（MusicMiniBar docked 贴满底边、
  PlayerControls railOffset → left-0）
  ③ 窗口：MUSIC_WIDTH 460→400、MUSIC_HEIGHT 820→740、MIN 380×600→320×520
- 验证：CDP 实测——音乐模式 400×740 无侧栏、工具条四入口导航正常
  （#/music-sources、#/settings、返回影视→视频模式侧栏 240px 恢复正常）、
  播放条贴底全宽、截图目视；typecheck + test:render 332 例 + test:main
  782 例 + build:main/preload 全绿（compact-window 测试引用常量，无需改）

---

## 纪律提醒（动工前重读）

- 每个任务：`git status --short` 起手；先测试后实现；Evidence 落真实命令。
- 新 IPC 必走 §16.6 四件套 + 测试；migration 只追加。
- 用户偏好：设置页只放软件配置；音乐来源在「媒体库」页管理；拒绝横向
  滚动；中文文案；异步 Toast。
