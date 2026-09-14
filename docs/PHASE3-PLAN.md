# QY Player 三期迭代规划：音乐播放

> 文档状态：Draft（待人工评审批准后动工）
>
> 规范性：本文是三期范围、架构与质量要求的唯一事实来源；执行状态以
> `tasks/todo.md` 为准。与根目录 `AGENTS.md` 冲突时，AGENTS.md 优先。

## 1. 范围与目标

三期把 qy-player 从"视频播放器"扩展为"影音播放器"：

1. **音乐库与播放**：本地目录 / WebDAV 音频扫描入库；复用现有
   Jellyfin / Emby 连接器支持服务器**音频库**（Audio 条目、专辑/歌手浏览）。
2. **格式兼容最大化**：所有音频解码统一走 mpv（FFmpeg 解码后端），
   直连可解码格式额外提供 renderer 引擎（见 ADR-0007）。
3. **歌单**：内部歌单 + m3u/m3u8 导入导出（XSPF 导出）。
4. **桌面歌词**：置顶透明浮动歌词窗口，卡拉OK式高亮（ADR-0008）。
5. **拾音器（可视化频谱）**：双模式——实时频谱（Web Audio 引擎）与
   波形（离线缓存，全格式）。
6. **常见播放器功能**：队列/随机/循环、上下曲、进度/音量、均衡器预设、
   ReplayGain、睡眠定时、收藏、迷你控制条、全局快捷键（复用二期框架）。

### 红线（继承 AGENTS.md 全部硬约束）

- Electron 21.4.4 不升级；任何新能力不得引入需要 glibc > 2.28 的依赖。
- **禁止为音乐新增原生模块**（native tag 解析库等一律不用，见 §5）。
- mpv 仅软件解码；子进程 stdout/stderr 持续 drain；进度保存机制不变。
- migration 只能追加；SQLite 现有表不改列。
- UI 拒绝横向滚动；深色语义 token；中文文案；异步操作 Toast。

## 2. 复用现状（不重复建设）

| 现有资产 | 三期复用方式 |
|---|---|
| mpv 子进程 + JSON IPC + PlayerCore | 音频主引擎；`--gapless-audio=weak` 消除曲间爆音 |
| media-probe（ADR-0005，probe≤1） | 扩展 audio probe：时长/标签/封面存在性（不改动现有探测预算语义，音频库扫描排队共用同一预算） |
| catalog 域（ADR-0001 MediaRef） | 音乐条目以 `mediaType='music'` 入统一目录域；`catalog_user_state` 承载收藏/播放计数 |
| playback-state 进度保存 | 位置/时长保存链路对音频同样生效（resume 规则：音乐**总是**从上次位置续播，无 30s 阈值——音乐不怕重播） |
| shortcut-defs | 已含 MediaPlayPause/Next/PreviousTrack；新增「上一曲/下一曲」语义映射 |
| cache-manager 分区预算 | 新增 `lyrics`（受保护）与 `spectrum`（可清扫）分区 |
| unified-query | 音频加入统一搜索（provider 维度同源） |

## 3. 架构决策（ADR 摘要）

### ADR-0007 音乐播放引擎双通道（新）

- **引擎选择器**（主进程纯函数，单一来源）：按探测结果把音轨分为
  - `direct`（Chromium 可解码：mp3/aac/flac/ogg/opus/wav/m4a 等）→
    **renderer 引擎**：`<audio>` + Web Audio（AnalyserNode → 实时频谱、
    BiquadFilter 链 → 均衡器）；上下曲零进程开销，拾音器全能力。
  - `native`（ape/wma/wv/tak/dsf/dff/cue 分轨等）→ **mpv 引擎**（现有
    PlayerCore，音频参数子集）；兼容性最大化。
- 选择器必须同时尊重**用户偏好**（设置：拾音器优先 / 兼容性优先）：
  兼容性优先 = 全部走 mpv。
- 规则与 phase2 §12 同纪律：选择逻辑收敛为纯函数，UI 不得复制算法。
- mpv 音频固定参数：`--gapless-audio=weak`、`--replaygain=<设置>`、
  不改 `--hwdec=no`（对音频无意义但保持链路一致）。

### ADR-0008 桌面歌词窗口（新）

- 独立 BrowserWindow：`transparent + frameless + alwaysOnTop(toolTip) +
  skipTaskbar`，X11 ARGB；`setIgnoreMouseEvents({forward:true})` 默认穿透，
  按住拖动区域/快捷键临时可交互。
- 渲染：两行文本（当前行+下一行）+ 逐字渐变填充；行高亮进度由 renderer
  引擎的 `timeupdate`（或 mpv time-pos 事件）驱动，更新频率 ≤ 30fps，
  空闲时（纯音乐/无词）自动隐藏。
- 歌词来源优先级：内嵌歌词（ID3v2 USLT/SYLT、FLAC Lyrics/UNSYNCEDLYRICS、
  m4a ©lyr）→ 同名 .lrc 边车 → 服务器（Jellyfin 10.9+ Lyrics 端点）→
  手动导入。**不支持在线歌词 API**（版权与外联红线）。
- 主屏失焦时保持刷新（音频继续播）；合成器不可用（无 ARGB）时降级为
  不透明纯黑窗口并提示。

### 歌单契约（并入本计划，不单设 ADR）

- 表：`playlists(id, name, created_at, updated_at)`、
  `playlist_items(playlist_id, position, item_ref, added_at)`；
  item_ref 用 MediaRef（provider+owner+itemId 或本地 path）。
- 导入：m3u/m3u8（相对路径解析基准=文件所在目录；缺失项保留占位并报告）。
  导出：m3u8（本地项相对路径）+ XSPF（全部来源，URL 化）。
- 导入/导出只涉及**本地与 WebDAV 项**；Jellyfin/Emby 服务器内建歌单三期
  只读展示（P2）。

## 4. 能力地图

| 能力 | 本地 | WebDAV | Jellyfin/Emby |
|---|---|---|---|
| 音频扫描入库 | ✓（含标签/封面/CUE） | ✓（PROPFIND 扩展音频后缀） | ✓（Items Type=Audio/Album） |
| 播放/续播 | 双引擎 | mpv 引擎（直链） | mpv 引擎（直连/服务端转码） |
| 歌单 | 读写 | 读写 | 只读展示（P2） |
| 歌词 | 内嵌/.lrc | 内嵌/.lrc（下载后） | Lyrics 端点 |
| 拾音器 | 全模式 | waveform 缓存 | waveform 缓存 |
| 桌面歌词 | ✓ | ✓ | ✓ |

## 5. 数据与迁移（追加，migration 007 起）

- `music_tracks`（audio 媒体条目：path/itemId、title、artist、album、
  albumartist、track_no、disc_no、year、duration、codec、bitrate、
  has_cover、has_lyrics、source_id、fingerprint）
- `music_cue_entries`（CUE 分轨：起始/结束/标题，指向父音轨）
- `playlists` / `playlist_items`（见 §3）
- `catalog_user_state` 复用（favorite/playcount 面向 music 条目）
- `watch_history` 不动：音乐续播走 catalog 域与内存态，不写旧表
- 标签解析 = **自研 TS 解析器**（ID3v2.3/2.4 + FLAC + m4a 最小集：
  标题/艺术家/专辑/音轨号/年份/内嵌封面/内嵌歌词；APEv2 只读标题级字段）。
  禁止引入 jsmediatags/music-metadata 等依赖（体积+老机兼容）。
- 封面：优先内嵌 picture block → 临时文件入 `covers/` 缓存分区；无内嵌时
  用 mpv 单帧导出兜底（spike 验证 0.29/0.32 行为一致，失败用占位图）。
- 离线频谱缓存：扫描期 ffmpeg-free 方案不可行 → **mpv 探测进程解一次**：
  `--ao=null` + `--af=lavfi=[astats=metadata=1]` 不可行（无频域）→ 采用
  自研降采样：`--o=pcm` 不改声卡（`--ao=null` 下 `--af=lavfi=[aresample=8000]`
  + 输出到文件仅限 spike 验证）；如 spike 失败则三期拾音器在 mpv 引擎
  下降级为**播放波形**（已有 duration+进度即可绘制，无需缓存）。

## 6. IPC 面（§16.6 全流程，禁止裸字符串通道）

新增通道组：`MUSIC.*`（扫描/查询/队列控制）、`PLAYLIST.*`（CRUD/导入/
导出）、`LYRICS.*`（解析结果/歌词获取）、`DESKLYRICS.*`（开关/位置/字号
/锁定/拖动同步）、`EQUALIZER.*`（设置）。所有跨窗口消息走主进程中转，
桌面歌词窗口不直连播放状态。

## 7. UI 面

- 新导航页：「音乐」（库浏览：专辑/歌手/全部曲目/收藏）、「歌单」。
- 详情/操作沿用现有 Detail 模式：音频详情 = 标签 + 封面 + 内嵌/挂载歌词
  编辑 + 「重扫此曲目」。
- 迷你控制条：底部常驻（可折叠），展示当前曲目/封面缩略/进度/拾音器迷你条。
- 设置新增「音乐」区：引擎偏好、replaygain、均衡器、桌面歌词、拾音器
  模式、睡眠定时。
- 桌面歌词窗口样式：描边可读性（暗底浅字+外描边）、颜色两套（跟随主题
  /自定义），字号/位置持久化。

## 8. Checkpoints

| CP | 内容 | 出口条件 |
|---|---|---|
| A | 目录域扩展 + 音频扫描/标签/封面/CUE + 冒烟 | 迁移测试 + 扫描 fixture 绿；三来源可发现 |
| B | 播放引擎 + 队列/循环/随机 + 均衡器/RG + 库 UI | 引擎选择器表驱动测试全绿；实机播放 |
| C | 歌单 CRUD + m3u/m3u8/XSPF 导入导出 | 往返导入导出无损（fixture） |
| D | 歌词管线 + 桌面歌词窗口 | LRC 用例全绿；实机验证置顶/穿透/拖动 |
| E | 拾音器双模式 + 缓存降级 | 双引擎可视化切换实机验证 |
| F | 全量回归 + 文档 + 发布门禁 | 同二期 Checkpoint F 标准 |

## 9. 任务分解（QYP3-001～024）

| ID | 任务 | 依赖 |
|---|---|---|
| 001 | migration 007：music_tracks / music_cue / playlists / playlist_items | — |
| 002 | 音频后缀白名单 + 分类器扩展（本地扫描识别音频） | 001 |
| 003 | WebDAV 音频扫描（PROPFIND 含音频后缀 + 目录域入库） | 002 |
| 004 | 自研标签解析器（ID3v2/FLAC/m4a + 单测 fixture） | — |
| 005 | 封面提取管线（内嵌优先 + mpv 兜底 spike） | 004 |
| 006 | CUE 解析与分轨入库（strict=必须引用真实文件） | 004 |
| 007 | 音频 probe 扩展（复用 media-probe，串行预算） | 005 |
| 008 | 音乐库 UI：专辑/歌手/全部曲目/收藏 + 统一搜索接入 | 003,007 |
| 009 | 引擎选择器（纯函数 + 用户偏好 + 表驱动测试） | 007 |
| 010 | renderer 引擎：WebAudio + 队列/上下曲/循环/随机 | 009 |
| 011 | mpv 引擎音频参数（gapless/replaygain）+ 双引擎状态归一 | 009 |
| 012 | 均衡器（10 频段预设 + 自定义；双引擎参数映射） | 010,011 |
| 013 | 迷你控制条 + 全局快捷键「上一曲/下一曲/收藏」接线 | 010 |
| 014 | 音乐播放进度保存与续播（无 30s 阈值，永远续播） | 011 |
| 015 | 歌单表 CRUD + IPC + 歌单页 UI | 001 |
| 016 | m3u/m3u8 导入（相对路径/占位报告）+ 导出 | 015 |
| 017 | XSPF 导出 + 往返一致性测试 | 016 |
| 018 | LRC 解析器（标准/增强/多时间标签 + 容错） | — |
| 019 | 内嵌歌词提取（ID3 USLT/FLAC/m4a）+ 歌词缓存分区 | 004 |
| 020 | Jellyfin 10.9+ Lyrics 端点接入（Emby 静默降级） | 019 |
| 021 | 歌词面板（详情页内嵌显示/编辑器） | 018 |
| 022 | 桌面歌词窗口（ADR-0008：透明/穿透/拖动/样式/持久化） | 021 |
| 023 | 拾音器：实时频谱（AnalyserNode）+ 波形（mpv 引擎）+ 模式切换 | 010,011 |
| 024 | Checkpoint F：全量回归/文档/CHANGELOG/发布门禁 | 全部 |

标记（任务内细化）：P1=012 预设编辑器、013 收藏快捷键；P2=服务器歌单
只读、睡眠定时、ReplayGain 高级设置、网络收音机流（需先做 spike）。

## 10. 风险

1. **Chromium 解码边界**：直连格式清单必须以 spike 实测为准（任务 009
   的 fixture 从真实文件产出），不得凭文档假设。
2. **mpv 引擎与 renderer 引擎切换时的状态撕裂**：状态归一（任务 011）
   先行验收，再接 UI。
3. **桌面歌词在无合成器 WM 上黑底**：降级路径写进验收（不透明窗口 +
   提示），不做"假装透明"。
4. **离线频谱 spike 可能失败**：失败则 mpv 引擎降级为播放波形，不改红线
   （不引入 ffmpeg 依赖）。
5. **老机 CPU**：拾音器默认帧率 30fps；AnalyserNode fftSize ≤ 2048；
   频谱缓存仅扫描期一次性计算且并发=0（借用 probe 预算）。

## 11. 测试与门禁

- 继承二期全部门禁；新增表驱动测试：标签解析 fixture（真实采样文件）、
  LRC 解析用例、m3u 往返、引擎选择器矩阵、歌词同步纯函数。
- 实机验证项追加进 `docs/TARGET-VERIFY.md`（桌面歌词 ARGB、双引擎、
  gapless 实听）。
