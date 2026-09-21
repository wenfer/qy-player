# AGENTS.md — QY Player 开发指南

供 AI code agent 使用。先读这里，再动手改代码。

## 项目定位（决定了所有技术约束）

**专为老版本 Linux 打造的桌面媒体播放器**（Deepin 20.9 / Debian 10 / glibc 2.28），以 MPV 为内核，支持 Jellyfin / Emby。1.5.0 起兼容 Windows / macOS（三端打包），但 **Electron 与 mpv 的版本选择仍由 Linux 老系统决定**——跨平台改造绝不回退 Linux 兼容性。

一切"看起来可以升级"的依赖都可能破坏对老系统的兼容性，见下方硬性约束。

## 硬性约束（违反 = 回归）

1. **Electron 锁定 21.4.4，禁止升级**。22+ 要求更新的 glibc，老系统装不上。
2. **MPV 只能用软件解码**：`--hwdec=no`（见 `mpv-process.ts`）。老机器的 VA-API/VDPAU 播放在线流会在 ~30 秒后冻结，这是实测结论，不要改回 `auto`。
3. **mpv 子进程的 stdout/stderr 必须被 drain**。spawn 默认管道 64KB 写满后 mpv 会阻塞卡死。当前做法是挂空的 `data` 监听（`mpv-process.ts`）。不要删除，也不要把 mpv 日志转发到主进程控制台（用户明确要求静默）。
4. **mpv 卸载文件时会补发 `time-pos: null`**。`PlayerCore` 收到 null 必须保留最后一次真实值，绝不能归零——否则退出时的最终保存会用 0 覆盖整场播放进度（已修复过的 bug，见 `player-core/index.ts`）。
5. **关闭主窗口 = 退出应用**。Linux 托盘图标不可靠（GNOME 无 AppIndicator 就不显示），绝不能把"退出"的唯一途径押在托盘上（`window-all-closed` → `app.quit()`）。
6. **不假设现代 Linux 工具链**：目标机 gcc 8.3、无 sudo、GitHub 直连受限。涉及老系统编译的说明见 `docs/BUILD-MPV.md`。
7. **TypeScript 严格模式 + noUnusedLocals**，提交前必须通过：
   ```bash
   npx tsc --noEmit -p tsconfig.json && npx tsc --noEmit -p tsconfig.node.json
   ```

## 架构总览

三进程结构 + 外部 MPV 子进程：

```
┌─ Electron 主进程 (out/main.cjs)
│   src/main/index.ts            入口：窗口、托盘、快捷键注册、will-quit 清理链
│   src/main/ipc/index.ts         全部 ipcMain.handle 注册（单文件，勿拆散）
│   src/main/modules/
│     player-core/               MPV 生命周期 + JSON IPC 封装
│     playback-state/            进度保存（10s 定时 + pause/eof/disconnect/crashed）+ 服务器同步回调
│     storage/db.ts              SQLite（better-sqlite3）+ MIGRATIONS
│     online-connector/          Jellyfin/Emby REST 客户端（EmbyClient 继承 JellyfinClient，路径加 /emby 前缀）
│     catalog/                   目录查询/仓储 + unified-query（四来源统一首页/搜索）
│     platform/                  跨平台基础：mpv/ffmpeg 二进制定位（候选序列）+ mpv IPC 端点抽象（Unix socket / win32 命名管道，QYP3-061）+ qy-file URL 解析
│     media-probe/               headless mpv 探测（ADR-0005，probe≤1）
│     music-spectrum/            离线频谱：ffmpeg 解码 → 自研 FFT → 12fps×48 频带落盘（QYP3-050，并发 1）
│     media-operations/          字幕导入 / 两阶段安全删除
│     metadata/                  NFO 解析 / 字段合并 / 元数据编辑器
│     plugin-runtime/            插件 registry/配置/刮削任务/匹配器/缓存（§11）
│     cache/ cache-manager        §16.4 预算常量单源 + 缓存分区清扫（字幕受保护）
│     diagnostics/               脱敏诊断摘要（可分享，无秘密/私有 URL/绝对路径）
│     library-scanner/ library-sources/  本地/WebDAV 扫描与来源适配（ADR-0001）
│     playback-engine/          音乐：引擎选择/audio-url 协议桥/qy-stream 认证流代理/歌单 IO/LRC 解析/均衡器/ReplayGain（ADR-0007）
│     subtitle-engine/ ui-shell/  字幕扫描；托盘/全局快捷键/mpv 按键生成/桌面歌词（ADR-0008）/睡眠定时/窗口形态与几何记忆（QYP3-051）
├─ Preload (out/preload.cjs)     contextBridge 暴露 window.electronAPI，类型来自 shared/types
├─ Renderer (React 18)           pages/* + zustand stores
└─ mpv 0.32 子进程               经 platform/ipc-endpoint 抽象通信（Linux/mac Unix Socket，Windows 命名管道）JSON IPC；二进制按 binary-locator 候选序列查找
```

数据流要点：
- **播放**：renderer 调 `playerLoadFile(url, startPos, headers, mediaContext)` → IPC → `PlaybackStateManager.setCurrentMedia(...)` → mpv `loadfile`
- **进度**：主进程每 10s 从内存态保存（读 `player.getState()`，不走 IPC）→ 本地 SQLite + 经 `reportProgress` 回传 Emby/Jellyfin（`/Sessions/Playing/Progress|Stopped`）。**音乐例外**（QYP3-053）：`PlaybackStateManager` 的 `isMusic` 门禁（接 `isMpvMusicActive()`）跳过本地两张表，只保留服务器回传
- **历史**：`watch_history` 表按 `(media_type, media_id)` upsert；剧集记录含 `series_name/season_number/episode_number`。**音乐不进历史**（QYP3-053，migration 011 清过存量）
- **续播**：位置/原因只由 `playback-state/resume-resolver.ts` 纯函数决定（30s/90%/看完下一集/重播）——renderer 不得复制算法；「从头播放」显式传 0（LOAD_FILE 区分显式 0 与未指定）。**音乐没有 per-track 续播**（QYP3-053：`resolveMusicResumeTarget` 已删，音乐分支 `startPosition` 恒为 0）；音乐只有"当前播放状态"用于恢复播放条
- **当前播放的音乐**（QYP3-053）：`playback-state/now-playing.ts` 在 `app_config` 里存**一条**记录（曲目 + 进度，本地按 `(sourceId, trackId)`、服务器按 `(serverId, itemId)` 定位，不存 path/绝对路径）。渲染层经 `MUSIC.SET_NOW_PLAYING`（节流 5s，暂停/跳曲/停止立即）写入，启动时 `MUSIC.GET_NOW_PLAYING` 读回 → `NowPlayingHost` 恢复播放条（**engine 保持 null，不自动出声**）。恢复态**不算音乐会话**（否则会误触自动精简、抢走全局媒体键），点播放走 `resumeRestored()` 从上次位置起播，并按「全部曲目」**重建完整队列**（本地/WebDAV，恢复曲落在曲库原位；曲库读取失败或服务器曲目退回单曲队列，QYP3-068d）
- **自动连播**：`playback-state/auto-next.ts`——仅自然 EOF；控制器注册在 eof 保存**之后**（保存先于倒计时）；disconnect/crashed 立即取消
- **刮削**：`plugin-runtime/job-service`（并发 2、置信度 0.92/0.75、UPSTREAM_CHANGED 暂停整批）；插件 payload 必过 `validateMetadataPayload`；TMDB Token 仅 Bearer 头
- **统一查询**：`catalog/unified-query.ts`——去重只按完整 MediaRef（provider+owner+itemId）；分页 ≤200；来源局部失败不阻塞
- **音乐**：`playback-engine/engine-selector.ts` 是引擎判定的唯一来源（转码/CUE/兼容性优先/非直解格式 → mpv；spectrum-first 且直连格式 → renderer 引擎——QYP3-037 起服务器/WebDAV 音频经 `qy-stream://` 认证流代理也走 renderer 引擎，`sourceKind` 不再强制 mpv）；renderer 侧 `stores/music-playback-store` 单点归一（webaudio 驱动 / mpv 走 playerLoadFile，direct 失败回退 mpv 一次；引擎队列**按需懒解析**单曲 URL，服务器整队预解析是 N 次网络请求）
- **服务器音乐**：音乐页「来源」切换见 `utils/server-music.ts`（纯映射，只认 `CollectionType=music`）+ `Music/ServerMusicBrowser`；服务器曲目**不落本地库**，播放走 `MusicTrackInput{serverId,provider,itemId}` → `refOfTrack` 严格按 serverId 路由；mpv 引擎的上下曲靠 store 的 `serverQueue/serverIndex`（队尾 stop，不回卷）；**本地 mpv 音源**（APE/兼容性优先/兜底）靠 `mpvQueue/mpvQueueIndex` 走播放时的列表（恢复态=全部曲目，QYP3-068f），fallbackToMpvNow 会把 webaudio 的 queueSnapshot 带进 mpvQueue。**服务器歌单**（P2 只读）复用同一套映射与队列（`pages/Playlists/ServerPlaylists`），条目走 `/Playlists/{id}/Items`，歌单 id 只在其服务器上有意义 → IPC 强制 serverId
- **音乐会话**：`playback-engine/music-active.ts` 是唯一标志源（renderer 引擎靠 `SET_ENGINE_ACTIVE` 上报，mpv 音乐靠 `LOAD_FILE` 是否带 `audioChain`）；`player:on-state-change` 带 `music` 标记，renderer 侧 `attachMusicMpvBridge()`（幂等）据此把 mpv 进度写回音乐 store——**视频加载会结束音乐会话**（否则两路声音同时响、音乐条残留在视频上）。**恢复态（`restored` 为 true 而 `engine` 为 null）不算会话**（QYP3-053）：`CompactModeHost`/媒体键/自动精简都只看 `engine`，播放条与内容区留白另看 `restored`
- **歌词**：扫描期从标签落盘 `<userData>/lyrics/<trackId>.lrc`（受保护分区，人工可编辑）；高亮行号只由 `playback-engine/lrc-parser.ts` 纯函数决定；桌面歌词窗口状态由 renderer 节流推送（≤10Hz）、主进程统一转发。**歌词按来源路由**：本地音轨读缓存分区，服务器曲目走 Jellyfin `/Audio/{id}/Lyrics`（Emby 无端点）并在主进程归一成 LRC（`online-connector/lyrics.ts`）——下游只有一套 LRC 解析；歌词永远是非关键路径，拉取放在 loadfile 之后且失败静默。**LyricsPanel 的弹出位置由 `placement` 决定**（QYP3-058）：`above-bar`（默认，主窗口，悬在 ~150px 高的播放条**上方** `bottom-44` + `z-50`——播放条带频谱行，面板渲染在播放条之前，同级 z-index 会被频谱 canvas 压住）与 `overlay`（精简浮窗，`top-10 bottom-3` 铺满，**不要**套 `max-h-[46vh]`，浮窗 ~300px 高会被夹短）
- **曲目时长**（QYP3-052）：`music_tracks.duration` 有两条来源，**都不要拆**——
  ① 扫描期 `library-scanner/tag-parser.ts` 从文件头解析（FLAC STREAMINFO / m4a mvhd /
  mp3 的 Xing·Info 总帧数，退化到 ID3 `TLEN`，再退化到"前 40 帧码率完全一致"的 CBR
  估算；APE 读 `MAC ` 头）。**VBR mp3 没有 Xing 头时首帧码率毫无代表性**，按它估会差
  2~4 倍，所以宁可留空；② 播放期回填：`stores/music-playback-store` 在拿到真实
  duration 后经 `MUSIC.SET_TRACK_DURATION` 写回（每个 trackId 只报一次，服务器曲目
  trackId=0 不报）——覆盖解析不出来的（ID3 标签 >512 KiB 超出读取窗口、WebDAV 源、
  未知格式）。解析器升级后靠 `music.durationScanVersion` 闸门**强制补解析一轮**：
  指纹没变的文件本来连标签都不读，不给这个闸门存量行永远补不上；视频来源的扫描
  绝不能写这个版本号，否则音乐来源永远等不到补解析
- **拾音器**：频谱来自 renderer 引擎 AnalyserNode（fftSize 2048、≤30fps）；mpv 引擎退化为按 时长+进度 绘制的播放波形（无缓存、无外部依赖）
- **睡眠定时**：权威定时器在 main（`ui-shell/sleep-timer.ts`，会话内有效不持久化）；到点先 `autoNext.cancel()` 再暂停 mpv，并下发 `sleep:on-expired` 让 renderer 停 renderer 引擎音乐——**两个引擎都可能是"正在放的那个"**，只处理自己那侧

## 已知机制与陷阱（改相关代码前必读）

### 播放进度
- 容器（Series/Season/Folder）无 MediaSources，播放前要解析到第一个可播子项；解析后必须把**子项的 id/标题/季集编号**传进 `mediaContext`，否则历史信息缺失（修复过的 bug）
- `MediaContext`（`shared/types`）字段：mediaType/mediaId/title/seriesName/seasonNumber/episodeNumber/mediaSourceId
- 历史缩略图**不落库**：展示时按归属服务器现场拼 `…/Items/{id}/Images/Primary?maxHeight=200`（不带 tag，Emby 返回当前主图，见 `pages/History`）

### 快捷键
- 全局快捷键：定义在 `shared/shortcut-defs.ts`；用户配置存 `app_config` 的 `shortcuts` 键（Electron accelerator 原文，如 `CommandOrControl+Shift+Q`）；注册失败要返回 failed 列表并由 UI 提示冲突
- **显示层必须格式化**：`CommandOrControl` → `Ctrl`（Mac 为 `Cmd`），`MediaPlayPause/Next/PreviousTrack` → `⏯/⏭/⏮`。不要把 Electron 内部术语直接亮给用户
- MPV 窗口按键：主进程按 `MPV_BINDINGS` 定义**动态生成** `userData/mpv-input.conf`（未配置的条目用 defaultKeys），启动时 `--input-conf` 加载；修改后用 `set_property('input-conf', path)` 热重载，失败则下次启动生效
- MPV 固定项（滚轮音量、双击全屏、a/c 菜单、Ctrl+1~5 比例预设）不可录制，UI 里归入"固定按键"区

### 窗口/托盘
- **主窗口是无边框的**（QYP3-042，`frame: false`）：标题栏与缩放全靠自绘
  `components/TitleBar`（`-webkit-app-region: drag` 的 36px 条 + 最小化/最大化
  /关闭三个按钮走 `WINDOW.*` IPC；双击拖动区最大化）。Linux 无边框窗口没有系统
  边框可拖，所以 `WindowResizeHandles` 贴了 8 个透明热区，只向主进程报**鼠标
  位移增量**（渲染层拿不到窗口在屏幕上的坐标，bounds 一律由主进程从
  `getBounds()` 算，并受 `getMinimumSize()` 夹住；最大化时忽略）。关闭按钮即
  退出应用。侧栏 `top-9`、Toast `top-12` 都是为让开这条标题栏；精简浮窗用的是
  28px 的紧凑版（带「还原窗口」按钮）
- 托盘只是运行中的显隐快捷方式；菜单里有"退出"兜底
- **音乐模式 = 主窗口原地变竖窄屏**（QYP3-044）：切到音乐模式时主窗口改成
  460×820 的竖屏（矮屏按工作区夹到 ≤ 屏高-48，下限 380×600），退出原样恢复——
  **同窗改尺寸，不新开 BrowserWindow**：播放状态与 30fps 频谱都在主窗口
  renderer 里，另开窗口就得把频谱跨进程转发。几何复用 `ui-shell/compact-window.ts`
  的 profile 机制（与精简浮窗共用同一份"正常几何"记忆；浮窗优先级更高，音乐
  模式里开浮窗再退出会回到竖屏而不是正常尺寸）。竖屏下侧栏收成 56px 图标轨
  （导航项靠 `aria-label` 保名），内容区 `ml-14`、播放控制条 `left-14`。
  **窗口形态的权威在主进程**：renderer reload（热重载）不重置主进程几何，渲染层
  store 却会归零——启动时 `WindowProfileHost` 要用 `WINDOW.GET_PROFILE` 回填
  `mode` / `compact`，否则小窗口里会画出完整影视界面。**形态与几何跨重启记忆**
  （QYP3-051）：`ui-shell/window-state.ts` 把 `{profile, music, bounds, maximized}`
  存进 `app_config` 的 `window.memory`，`createWindow()` 里按 profile 给构造参数
  （最小尺寸必须按 profile 给，否则 1280×800 的下限会把浮窗顶回去），再
  `restoreWindowProfile()` 套用。**音乐模式下用户改的尺寸不记忆**（每次重算标准
  460×820），边界用 `resolveRestoreBounds()` 夹回可见区域。记忆里的正常几何靠
  `getNormalBounds()`（最大化时 `getBounds()` 是最大化矩形），且 profile 不是
  normal 时绝不覆盖——否则退出音乐模式会回到竖屏尺寸
- **精简模式 = 主窗口原地缩小，不新开窗口**（QYP3-035）。播放音频时可点迷你条
  的「精简」按钮（或设置里开「播放音频时自动进入」）把主窗口缩成右上角小浮窗，
  渲染层切到 `components/CompactPlayer`（复用 `SpectrumGraph`）。**必须同窗
  改尺寸**：播放状态与 30fps 频谱都在主窗口 renderer 里（`getSpectrum` 读同一个
  WebAudioEngine），另开 BrowserWindow 就得把频谱跨进程转发，老机 CPU 不划算。
  几何全在 `ui-shell/compact-window.ts`：进入前记住 bounds/resizable/置顶，
  退出原样恢复；进入先放宽 `setMinimumSize`（否则 1280×800 的下限会把浮窗顶回
  去），退出先 resize 回原尺寸再恢复下限。音乐会话结束（`engine` 变 null，含
  视频接管 mpv）由 `App.tsx` 的 `CompactModeHost` 自动还原，别把用户困在空小窗
  ——**还原条件必须是"会话真正结束"（非 null → null）**，不能写成
  `compact && engine === null`：浮窗可以跨重启恢复（QYP3-051），冷启动时
  `compact` 已是 true 而 `engine` 还是 null，那样写会在第一帧就把浮窗撤销掉。
  这也是 `CompactModeHost` 的进入/退出必须合成**一个** effect 的原因（分开写时
  进入那个会先覆盖 `prevEngine`）。浮窗里没有浏览/播视频的入口，所以"空浮窗"
  的逃生口只有两处「还原窗口」按钮（紧凑标题栏 + CompactPlayer 头部）
- **性能保护**（QYP3-036）：主进程每 ~3s 采样 `loadavg()/核心数`
  （`ui-shell/resource-guard.ts`），分 normal/busy/critical 三档，**只在档位变化时**
  经 `RESOURCE.ON_PRESSURE` 推给渲染层；渲染层的 `useVisualizerFps`
  （`stores/resource-store.ts`）在开关开启时按档位把可视化帧率降到 30/12/3 fps
  （`Visualizer` 与 `SpectrumGraph` 都走这个 hook），CPU 紧张时把资源让给音频解码。
  只降可视化刷新，**不碰播放链路，也不改进程优先级**（老机/无 sudo 不可靠）。
  开关存 `playback.powerSave`（**默认开**），精简浮窗的仪表按钮与设置页都可切。
  改相关逻辑前确认：档位变化才推送、关掉开关恢复基准帧率、采样失败按 normal 兜底

### 音乐（两处静默失败陷阱，改前必读）
- **切引擎必须显式停掉另一侧**（QYP3-067，"多首同时播放"bug 的修复）。
  音乐→音乐在两引擎间切换**不经过**视频 LOAD_FILE，主进程不会替渲染层收尾：
  ① webaudio 分支起播前，若 `engine === 'mpv'` 必须先
  `playerControl('stop')`（主进程 PLAYER.CONTROL 有 stop case：saveProgressNow
  final=true → clearCurrentMedia）——mpv 音乐是压窗的（vid=no），漏了就是
  上一首在看不见的 mpv 里继续放；② mpv 直选分支起播前必须
  `engineSingleton?.pause()`（engine 改成 'mpv' 只让 onTime/onPlaying 静默，
  音频图照常出声；fallbackToMpv 一直有这句，直选分支曾漏）；③
  `WebAudioEngine.playCurrent` 有 loadSeq 代数守卫——懒解析（服务器曲目
  秒级网络请求）期间队列已前进的，旧解析回来必须让位，play() 的 abort 类
  rejection 被新起播取代时也不许沿调用链报错
- **音乐 loadfile 必须回传 `streamSessionId`（第 5 参）**。WebDAV 音频的
  直链不带凭据，Basic 认证头由主进程 stash、只把不透明会话 id 交给渲染层；
  漏传就是 mpv 静默 401——失败不上报，连 toast 都没有。类型上是 optional，
  所以漏了不报错（这正是它能活到 1.2.0 之后的原因），三处调用点
  （`playQueue` mpv 分支 / `playServerAt` / 内置引擎回退）都要带
- **direct 引擎失败兜底按「失败的那一首」重播，不读 `store.current`**。
  `error` 事件先于 `play()` 的 rejection 到达，而 current 是在
  `await playQueue()` 之后才写入的：读 current 会在首播时读到 null（兜底
  直接放弃）、换曲后读到上一首（把上一首喂给 mpv）。同理，已交给兜底的
  那次 rejection 不能再报错（`directFallbackTrackId` 负责认领），否则用户
  会看到"放不了"的假消息。内置引擎比 mpv 严格得多：FLAC 内嵌图片块的
  `picture.type` 非法（-1）时 Chromium 打开容器就失败，而 mpv 只当警告
  —— 这类文件全靠兜底救回
- **内置引擎起播必须 `AudioContext.resume()`**。`WebAudioEngine` 在
  `playQueue` 路径里构造（构造时 `new AudioContext()`），而该调用不在用户
  手势的同步栈内（`resolvePlayback` 的 IPC await 在它之前）——浏览器自动播放
  策略下上下文停在 `suspended`，整条图（source→analyser→…→destination）不
  运转：既无声、AnalyserNode 也只读全 0，拾音器频谱静止。起播前主动 resume
  （`web-audio-engine.ts` 的 `playCurrent`），暂停后的 `resume()` 已包含，勿
  删。mpv 引擎（转码/CUE/兼容性优先/冷门格式）渲染层拿不到真实音频数据，
  **没有真实频谱**——只有随播放节拍起伏的降级波形（AGENTS.md 拾音器条目 +
  架构总览音乐会话段）
- **真实波形/频谱只能来自 renderer 内置引擎（Web Audio）**（QYP3-033/037），
  且 **`AnalyserNode` 必须真的接进音频图**：`MediaElementSource → Analyser
  (fftSize 2048) → 10×BiquadFilter → Gain → destination`。只 `createAnalyser()`
  不 `connect()` 的话它读的是静音（频域恒全 0、时域恒 128），可视化会一直走
  "无真实数据"的静态进度线——看起来就是"一条直线"（QYP3-045 修的就是这个：
  analyser 自 QYP3-009 建图起就悬空，QYP3-031 只补了 AudioContext.resume，
  不够）。改音频图后先确认连线，别只看"有没有创建"。渲染层
  的 AnalyserNode 同时给频域（`getSpectrum`，`getByteFrequencyData`）与时域
  （`getWaveform`，`getByteTimeDomainData`）真实数据；拾音器据此画真波形/频谱。
  mpv 0.32 **没有**暴露实时频谱/波形的 IPC 接口（已用 `strings` 核实：只有
  `af-metadata`，无 `audio-fft`；且不存在该属性名——勿凭文档假设），升级 mpv 会
  破坏老系统兼容（见硬性约束 2）。QYP3-037 起服务器/WebDAV 音频经主进程
  `qy-stream://` 认证流代理也走内置引擎（真频谱/真波形/均衡器与本地一致），
  所以「拿不到真实波形」的只剩：转码 HLS、CUE、兼容性优先、非直解格式
  （codec 不在 `DIRECT_CODECS`）——`Visualizer` 在无真实数据时画一条静态进度线，
  **绝不画假跳动的正弦波**（改前就是假正弦，已被用户指出）。想给某音源加真
  波形，必须让它走内置引擎解码，而非指望从 mpv 拿数据。`components/SpectrumGraph`
  （QYP3-034）同此约束——mpv 源显示"无法显示真实频谱"提示，绝不画假数据。
  **QYP3-047 起**：音乐页顶部不再放频谱图（播放时只留底部播放条那一块，避免
  同屏两个频谱）；瀑布声谱图与其持久化（`playback.spectrumChart`）已删除，
  只剩经典弹跳柱状一种。柱状绘制统一走 `Visualizer/bars-painter.ts`
  （分段 LED 柱 + 峰值帽，峰值帽按 `dt` 缓慢下落——`paint` 的 dt 必须在推进
  `last` **之前**算，否则峰值帽永远不落）；`Visualizer`（48 柱/8 段）
  与 `SpectrumGraph`（56 柱/16 段）复用同一个 painter。**painter 只画"点亮的
  格 + 峰值帽"、不清底**——调用方每帧必须先 `clearRect`（SpectrumGraph 漏了
  导致浮窗里残影叠影，QYP3-058 修复；Visualizer 一直是清的，别再拆）。
  **QYP3-048 起**：播放条里的拾音器高 32px（`MusicMiniBar` 的
  `VISUALIZER_HEIGHT`），控制条上还有「显示/隐藏频谱」按钮（`Activity` 图标、
  `aria-pressed`），开关持久化到 `playback.showSpectrum`（走 SETTINGS 的 JSON
  对称契约，GET 回来是 boolean）——关掉时**不渲染 canvas**、rAF 也随之停，
  不是"画成空白"。
  **QYP3-049 起**：`Visualizer` **不再**在无真实数据时画进度线（进度归播放条
  自己的那一行），只画一根静音底线——所以它不再收 `position`/`duration`。
  **QYP3-059 起：暂停 ≠ 冻结最后一帧**——暂停后频谱/波形**整体回落**：频谱走
  `createSpectrumDecay`（τ≈150ms 指数衰减快照喂 painter）、波形柱高线性回落
  （`FALL_PER_SEC`），峰值帽落底（`painter.settled()`）后**停掉 rAF 不空转**；
  复播从活数据立即恢复。`painter`/decay 缓存/波形柱高必须放 ref 里跨 effect
  重跑存活（依赖里有 `isPlaying`）。**dt 必须钳制（≤100ms）**：effect 重跑后
  `last` 从 0 起算，首帧 dt 是页面运行时长，不钳会把回落快照一帧清空
  **QYP3-050 起**：mpv 音源不再永远是静音底线——主进程用外部 **ffmpeg** 离线
  预算一份频谱（`music-spectrum/`：ffmpeg 解 PCM → 手写 radix-2 FFT → 12fps ×
  48 频带字节矩阵落盘，一首 4 分钟 ≈138KB），渲染层按 mpv 报回的进度（1Hz 离散
  → `player/spectrum-anchor.ts` 线性外推）索引回放。**声音仍由 mpv 播放，播放
  路径一行不改**；ffmpeg 探测不到（`~/.local/bin/ffmpeg` → PATH）就静默降级成
  静音底线——所以"看不见频谱"永远是可接受的降级，不是错误。注意 mpv 0.32 的
  **编码模式是坏的**（`--o=` 每帧 `error encoding`，实测），别想拿它当 ffmpeg 用
  **QYP3-057 起**：两个引擎的频谱都是**对数分带**（40Hz~8kHz）。内置引擎的
  `getSpectrum()` 在引擎内把线性 bin 按同一套 `bandBinRanges`（复用 pcm-fft）
  聚成 **64 带**峰值再返回——AnalyserNode 的 bin 是线性等宽的，画图方若按 bin
  线性等宽下采样，左边（低频能量区）永远比右边活跃；**勿再改回按 bin 直通**。
  画图方的 `downsamplePeaks` 对已分带的数据做线性下采样 = 柱子在 log 频轴等距
- **FLAC 因内嵌封面非法被 Chromium 拒绝时，剥离封面自救**（QYP3-033/037）。
  某些 FLAC 的 `METADATA_BLOCK_PICTURE` 块损坏（如 `picture.type=-1` /
  0xFFFFFFFF），Chromium 的 ffmpeg 在打开容器阶段就 `DEMUXER_ERROR_COULD_NOT_OPEN`
  整文件失败，导致该 FLAC 走不了内置引擎（既无真波形、又会被兜底到 mpv 弹黑窗）；
  mpv 0.32 对同样的块只 warning。`music-playback-store.ts` 的 `onError` 在 mpv
  兜底**前**先调 `WebAudioEngine.recoverFlac(track)`：fetch 字节（QYP3-037 起
  服务器/WebDAV 的 `qy-stream://` 也可，但**只能靠 `codec === 'flac'` 判定**——
  代理 URL 不带扩展名，`isFlacUrl` 对任意 qy-stream 都为真，会造成 mp3 白拉
  整文件；本地 `qy-file://audio` 仍按扩展名兜底）、用 `flac-strip.ts` 移除所有
  type=6 封面块、重封装成 blob 在内置引擎重播——音频帧原样保留（无损）。封面
  展示走 `covers` 缓存分区，与播放流内嵌封面无关，剥离不影响封面。改相关逻辑
  前确认：本地/服务器 FLAC 仍能在内置引擎出真波形、非法封面文件不再兜底 mpv、
  封面照常显示。**渲染层 CSP 的 `media-src`/`connect-src` 必须放行 `blob:` 与
  `qy-stream:`**（`src/renderer/index.html`），否则剥离后的 blob / 代理流会被
  CSP 拒载（`Refused to load media from ...`），自救失效并退到 mpv
- **服务器/WebDAV 音频的 `qy-stream://` 代理是安全边界，别拆**（QYP3-037）。
  渲染层只见 `qy-stream://audio/<opaqueId>`；真实上游 URL 与认证头
  （`X-Emby-Token` / Basic）在主进程 `StreamRouteCache`（可重复读取 + 滑动
  TTL + LRU，**与单次消费的 `StreamHeaderCache` 是两套语义**）。代理用裸
  `node:http(s)` 字节转发：上游强制 `Accept-Encoding: identity`、下游只透传
  白名单头（Range/206 如实透传才有 seek）；**不要**换 axios/Electron net
  （透明解压会让 Content-Length 与实体不符），也不要给 scheme 加
  `corsEnabled`（可能破坏 `createMediaElementSource` 出频谱的既有事实）。
  引擎队列**按需懒解析**单曲 URL：解析结果非 webaudio（NEEDS_MPV）→ 服务器
  曲目直接兜底 mpv（`serverQueue/serverIndex` 已随 webaudio 会话记录，mpv 可
  继续推进队列）；本地/WebDAV 先跳下一首、整队失败才兜底（防 repeat=all 空转）
- **服务器音乐的进度靠两条专用 IPC**（QYP3-038/053）。webaudio 播放不经
  LOAD_FILE，`MUSIC.START_SERVER_SESSION`（起播报告 Sessions/Playing，
  记 `playSessionId`）与 `MUSIC.REPORT_SERVER_PROGRESS`（节流 Progress /
  收尾 Stopped）补齐服务器侧；收尾一律 Stopped（Emby 仅在 Stopped 时把
  PositionTicks 写入 UserData），是否标记看完由位置比率判定。**这两个 handler
  只管服务器回传**——QYP3-053 起不再写本地两表（音乐不进播放历史；本地/WebDAV
  落 `MUSIC.SET_NOW_PLAYING` 的"当前播放的音乐"一条）。
  队列条目的权威 `mediaId`/`mediaSourceId` 来自解析结果的 `mediaContext`
  回填（懒解析曲子在 resolver 里回填），Sessions 回传从这取
- **mpv IPC 连接要容忍启动竞态**（QYP3-033）。`MpvProcessManager.start` 只等
  socket 文件出现，而文件由 `bind()` 创建、`listen()` 之后才可连接；两者之间
  connect 会 `ECONNREFUSED`（首个 loadfile 直接报错）。`MpvIpcClient.connect`
  做有界重试（默认约 1.2s），只吞连接建立前的错误；`connectOnce` 里失败的尝试
  不派发 `disconnect`，只有真正建立过连接的套接字关闭才算断开
- **音乐经 mpv 解码时绝不能让 mpv 弹窗**（QYP3-032）。mpv 共享实例由
  `playerLoadFile` 懒启动；音频文件（含内嵌封面，mpv 当成一条 mjpeg video
  轨）若不压窗会露出黑屏。修复路径：启动参数 `--force-window=no`，音乐加载
  时 `setVideoWindowForMusic(true)`（`vid=no` + `force-window=no`），视频加载
  时 `setVideoWindowForMusic(false)`（`force-window=yes` + `vid=auto`）。
  改相关逻辑前确认：音乐（本地冷门格式 / 服务器 / WebDAV / 内置引擎兜底）无
  弹窗、视频仍有窗口
- **封面文件名不能硬编码扩展名**。落盘名按内嵌图片真实格式生成
  （`<trackId>.jpg` 占真实世界绝大多数），渲染层无从得知格式，请求
  `<id>.png` 必须经 `resolveCoverFileName`（`cover-service.ts`）按
  「原名 → 同名其他扩展名」解析；目录包含校验留在协议层。测试夹具全是
  PNG，只加 PNG 用例会漏掉这条分支

### 跨平台（QYP3-061~064，改相关代码前必读）
- **Linux 行为逐字节不变是硬纪律**：`binary-locator` 的 linux 分支、
  `playlist-io` 的 POSIX file URL、托盘/桌面歌词的默认行为都必须与 1.4.0
  完全一致——单测里有逐字节断言，改平台代码先看这些断言红没红
- **二进制查找唯一入口**是 `platform/binary-locator.ts`（mpv/ffmpeg 都走
  它）：QY_MPV_PATH/QY_FFMPEG_PATH → 打包内置 `resourcesPath/mpv/` →
  平台候选 → PATH 裸名。新功能不要自己写 candidates 数组
- **mpv IPC 端点只经 `platform/ipc-endpoint.ts` 创建**：Windows 是命名
  管道（connect-probe 判就绪），Unix 是 socket 文件（existsSync 轮询）。
  `MpvIpcClient` 用 `net.createConnection`，两种端点通用，不要按平台分叉
  客户端代码
- **Windows 上 SIGTERM 等价 TerminateProcess**：杀 mpv 前必须先发 `quit`
  IPC 命令优雅退出（1s 竞速），否则最后一段进度丢失（`player-core` quit）
- **路径语义按目标平台注入**：跨平台单测断言 win32 路径形态时用
  `path.win32`（`joinFor(platform)`）；**绝不用 `pathToFileURL`** 处理
  Windows 路径——它按宿主平台解析，Linux 主机会把 `C:\...` 当相对路径
  （`playlist-io/localTrackFileUrl` 手工构造）
- **界面适配的平台分支**：darwin 红绿灯（`titleBarStyle:'hidden'` +
  `trafficLightPosition`，裸 `frame:false` 会吞掉红绿灯，TitleBar 按
  `electronAPI.platform` 避让 76px/64px）；托盘 darwin 用
  `icon-tray-Template.png`（`setTemplateImage(true)`）；win 路径解析用
  `path.win32.resolve`；`setIgnoreMouseEvents` 的 `forward` 仅 Windows
  有效，非 win 传 `{}`
- **打包**：`dist:win`（NSIS+portable，x64）先跑 `scripts/fetch-mpv-win.js`
  （zhongfly/mpv-winbuild **固定 tag**，改 tag = 显式升级决策）；
  `dist:mac`（dmg x64+arm64）先跑 `scripts/collect-mpv-mac.sh`（otool
  dylib 闭包 + 重写引用 + ad-hoc 签名 + 冒烟；`QY_SKIP_MPV_BUNDLE=1`
  是定义化兜底）。`electronDist` 已从 yml 移到 linux dist 脚本的
  `-c.electronDist=`（mac 双架构必须按架构下载，固定本地目录只有宿主
  架构）；测试脚本用 `cross-env`（Windows shell 不认 `VAR=1 cmd`）

## 新增功能的固定套路

### 加一个 IPC 接口
1. `src/shared/ipc-channels.ts` 加通道常量（禁止裸字符串通道名）
2. `src/main/ipc/index.ts` 加 `ipcMain.handle`
3. `src/preload/index.ts` 的 `electronAPI` 加包装方法（renderer 禁止直接碰 ipcRenderer）
4. 需要跨进程传复杂上下文时，扩展 `shared/types` 的类型（如 `MediaContext`），主/渲染两端共用

### 数据库结构变更
- 只能**追加** migration 到 `storage/db.ts` 的 `MIGRATIONS` 数组末尾；每个 migration 是一段 SQL，包在事务里按 `schema_version` 顺序执行
- 绝不修改已发布的 migration；SQLite 用 `ALTER TABLE ADD COLUMN`，不改列
- 保留 upsert 模式：`watch_history`/`playback_progress` 都按业务键 ON CONFLICT 更新，写入时用 `COALESCE(excluded.x, x)` 防止 null 抹掉旧值

### UI 约定（用户偏好，勿回退）
- **音乐模式默认就是"曲目列表 + 播放控件"**（QYP3-045）：`pages/Music` 的默认
  视图是「全部曲目」（不是专辑网格），tab 顺序 全部曲目 / 专辑 / 歌手 / 收藏；
  有音乐会话时 `MusicMiniBar` **停靠**在音乐窗口底部（`bottom-0 left-14 right-0`），
  在其他模式仍是居中浮卡。内容区在有会话时加 `pb-28` 给它让位。竖窄屏下控件行
  允许换行，不要加横向滚动
- **应用顶层双模式**（QYP3-040/041）：视频模式（默认，`stores/app-mode-store`）与音乐模式完全隔离——切换即导航到该模式默认页（`/` 或 `/music`）；导航项、设置页签、媒体库入口随模式整组更换（音乐媒体库在 `/music-sources`）。**影视是主场景，音乐是可选功能**：模式入口是侧栏底部一个低调小按钮（「音乐模式」/「返回影视」），不要做成与影视并列的大分段控件。迷你条/精简浮窗**跨模式保留**（由音乐会话门禁，非页面门禁）；直达 hash 路由不做模式推断（只控制可见入口）。**模式跨重启记忆**（QYP3-051/054）：上次退出时在音乐模式就还是音乐模式，且冷启动直接落在 `/music`（`WindowProfileHost` 回填 `mode` 后若处于初始路由 `/` 就 navigate 过去；热重载保留的深链不抢）；首次启动/记忆损坏时才是视频模式。**陷阱（QYP3-056）**：该恢复 effect 绝不能依赖 `useNavigate`——v6 每次 location 变化返回新函数，恢复导航自己就会触发 effect 重跑、把任何路由无限弹回 `/music`（菜单点不动）；navigate 经 ref 挂载时捕获一次，effect 用空依赖且**不加**"只跑一次"哨兵（StrictMode 双跑会废掉哨兵，见 `WindowProfileHost` 注释）
- **设置页仅软件配置**（服务器、快捷键等）；媒体来源按模式拆分管理（QYP3-039/040/041）：视频模式「媒体库」（`/media-sources`）管媒体服务器与影视来源、音乐模式「音乐媒体库」（`/music-sources`）只管音乐来源（服务器配置入口只保留在影视模式，音乐模式给一句提示）。**来源只属于一域**：`purpose` 只有 `music|video`（不支持音乐与视频混放同一目录——视频源要读 NFO 归类，混在一起两边都差）；存量 `all` 由 migration 010 归一为 `video`。扫描严格按域：视频源索引视频+NFO 并跳过音频/CUE（且跳过 `cleanupMissingMusic`，否则会误删存量音轨），音乐源只索引音频+CUE；勿合并回单一页面或恢复"两者"选项。**音乐域 = 音乐来源**（QYP3-055）：音乐列表/专辑/歌手/收藏/搜索统一走 `repo.listMusicSourceIds()`（`purpose='music'`），影视来源扫出的音轨不进音乐界面、resolver 也拒绝播放（`UNAVAILABLE`）——改查询范围时勿再回到"只按 kind 过滤"；拆域遗留需要一个恢复入口，媒体库页把不属于本域的目录/WebDAV 来源列在「其它来源」区一键转域（`CATALOG.SOURCE_SET_PURPOSE`，只改用途标签、已索引内容不动，扫描中拒绝转换）。**WebDAV 音频标签与本地同待遇**（QYP3-060）：`createWebDavScanDriver` 的 `readAudio` 走 `adapter.open(locator, signal, 'bytes=0-524287')` bounded GET（窗口与本地一致），封面/歌词落同一套缓存分区；`upsertMusicTrack` 的 `hasCover`/`hasLyrics` 是 **tri-state**（null = 本轮没读到 → COALESCE 保留旧值，true/false = 确定性结论 → 覆盖）——UPDATE 分支绝不能写 `COALESCE(excluded.has_cover, has_cover)`，`excluded` 里是 VALUES 侧兜底后的 0，tri-state 会被吞（UPDATE 分支用同值再绑一次的裸参数，见 repository.ts 注释）
- **设置页按模式分页签**（`Settings/index.tsx`：视频=播放/插件/快捷键，音乐=音乐/快捷键），一次只显示一个板块——影视与音乐是两套独立配置域，音乐项（引擎/音量链路/均衡器/拾音器/歌词/睡眠定时）只出现在音乐模式，勿塞回播放板块（用户明确要求两者不要混在一起）；快捷键是应用级配置，两种模式共用同一份 `ShortcutsContent`
- **`SETTINGS.GET`/`SET` 是 JSON 对称契约**：SET 走 `JSON.stringify`，GET 走 `decodeConfigValue` 解析回来（解析失败退回裸串，兼容主进程裸值）。renderer 侧读设置**不要**再手动 `JSON.parse`，也**不要**假设返回字符串——历史上这条不对称让均衡器/ReplayGain/自定义预设/拾音器开关四项静默失效
- **拒绝横向滚动条**：超宽内容一律换行（`flex-wrap` / grid），用户明确反对横向拖动
- Tailwind + 深色主题语义 token（`bg-card`/`border-border`/`text-muted-foreground`/`focus-ring`）
- 异步操作必须有 Toast 反馈（`stores/toast-store`）；列表操作用乐观更新 + 失败回滚
- 面向用户的文案用中文；技术内部术语（accelerator、mpv 属性名）不得出现在 UI
- **列表页必须区分「加载中 / 空 / 失败」**（前端审查）：`null` 不能同时表示"在加载"和"失败了"——失败要显式呈现可重试的错误态（`role="alert"` + 「重试」），否则会落成"暂无记录"这种误导性空态（History / Music / Playlists 都踩过）
- **自绘控件要补齐键盘路径**：`div` 画的进度条/滑块必须能 Tab 聚焦并响应方向键（见 `PlayerControls` 的 `onKeyDown`）；`opacity-0 group-hover:opacity-100` 的悬浮操作区要加 `group-focus-within`，否则键盘过去是隐形的
- **焦点样式统一用 `focus-ring`**（`index.css` 里的 `focus-visible:ring-2`），不要在各处自造 `focus:border-primary/50` / `focus:ring-2`
- **每页一个 h1，标题不跳级**（h1→h2→h3）；子视图（如 `ServerMusicBrowser`）用 h2，不要自己造 h1
- 组件超过 ~500 行就把自洽的一块抽成 hook/子组件（如 `MediaSources` 的 `use-servers`），页面只留编排

## 构建与发版

```bash
npm run dev          # 开发（构建 main/preload + vite renderer + electron）
npm run typecheck    # 提交前必跑
npm run dist:all     # Linux 全格式打包（AppImage/deb/rpm/pacman/tar）
npm run dist:win     # Windows（NSIS + portable，x64；自动内置 mpv）
npm run dist:mac     # macOS（dmg x64+arm64；需在 mac 上跑，自动收集 brew mpv）
```

- renderer 构建必须用 `vite build --config vite.renderer.config.ts`（`index.html` 在 `src/renderer/`），`npm run build` 已串好，不要单独裸跑 `vite build`
- `better-sqlite3` 是原生模块：`postinstall` 里的 `electron-builder install-app-deps` 负责 rebuild，别删
- 发版 = 推 tag：`git tag v1.0.x && git push origin v1.0.x`，GitHub Actions 自动打包发布（workflow 依赖 `rpm` 和 `libarchive-tools`，pacman 目标需要 bsdtar）
- 仓库：`git@github.com:wenfer/qy-player.git`；远端操作可能遇到瞬时 `EOF`，重试即可

## 调试

- 渲染进程 console 已转发到主进程 stdout（`[RENDERER:ERROR]` 前缀）
- MPV 日志被有意静默（见硬性约束 3）；需要看 mpv 行为时，用独立脚本连 socket 测试（参考 `scripts/cdp-test.mjs` 里的 MpvSocket 类）
- CDP 调试：`scripts/dev.js` 可临时加 `--remote-debugging-port=9222`，配 `npm run test:ui`
- 用户数据库在 `~/.config/qy-player/qy-player.db`，可用 sqlite3 直接查证数据问题

## 文档索引

- 三期规划（音乐播放，001～023、025、026 及 020b 已完成，024 发布门禁待人工批准）：
  `docs/PHASE3-PLAN.md` + `tasks/todo.md`
  + ADR-0007（音乐引擎）/ADR-0008（桌面歌词）

- 运行时说明（缓存/并发预算/诊断/回滚）：`docs/OPERATIONS.md`
- 发布后待目标机验证清单：`docs/TARGET-VERIFY.md`
- 架构决策记录：`docs/decisions/`（0001 MediaRef/目录域、0005 mpv probe、
  0006 豆瓣门禁、0009 网络收音机 spike 结论）
- mpv 老系统编译：`docs/BUILD-MPV.md`
- 版本历史：`CHANGELOG.md`
- 发布流程：tag 由人工批准发布说明后创建；GitHub Actions 全格式打包
  （依赖 `rpm`、`libarchive-tools`）

## Git 规范

- 提交信息：`feat|fix|chore|docs: 中文或英文摘要`，一行说清动机
- 推送前 typecheck 必须过；文档（README/AGENTS.md）随行为变更同步更新
