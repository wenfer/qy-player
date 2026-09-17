# 决策记录 0009 — 网络收音机流（spike 结论）

- 状态：**Spike 完成，暂不实现**（计划 §9 P2「需先 spike」）
- 日期：2026-09-17
- 关联：ADR-0007（音频引擎）、`playback-state`（进度保存）、
  `player-core`（mpv 参数）；三期 `tasks/todo.md` QYP2P-005

## 背景

三期 P2 列表里的"网络收音机流"被标记为"需先 spike"：它和音乐播放的
假设冲突（直播流没有时长、不可 seek、曲目会变）。本文记录 spike 结论：
能不能做、代价在哪、要做先做什么。**结论是不做**，理由在下面。

## 静态核实（本机可做的部分）

本机 mpv 二进制因缺 `libluajit-5.1.so.2` 无法运行，因此无法做真实播放
验证；以下是从**目标 mpv 二进制**里提取到的能力证据：

```
$ strings -a ~/.local/bin/mpv | grep -iE 'icy'
icy-title
icy_metadata_headers
icy_metadata_packet
read_icy
icy_header
icy_packet
```

- ICY（Icecast/SHOUTcast 的"当前曲目"元数据）链路存在：`icy_metadata_*`
  是 libavformat HTTP 协议的 ICY 解析，`icy-title` 是 mpv/ffmpeg 暴露的
  元数据键。**但 mpv 动态链接系统 libavformat**，实际是否生效取决于目标
  机的 ffmpeg（Debian 10 是 4.1，ICY 支持自 2014 年起在 http 协议里）。
- 流播放本身不需要新能力：现有 mpv 管线就是 `loadfile <url>`，HTTP/HTTPS
  由 libavformat 处理；需要额外参数（`--stream-lavf-o=reconnect=1`、
  `--network-timeout`、`--cache`）来扛断流。

## 与现有设计的冲突（spike 的主要产出）

真正的问题不是"能不能出声"，而是**收音机不能被塞进现有的播放状态机**：

1. **进度保存会写垃圾数据**（`playback-state/index.ts:156`）。保存器
   每 10s 无条件 `addWatchHistory`（`duration > 0` 只影响 duration 字段），
   直播流的 position 会一直涨、duration 恒为 0 → 历史里堆出一条永远在
   "观看中"的记录；`getResumePosition`（同文件 :138）在 duration 缺失时
   **直接返回 position** → 下次点开电台会从"上次听到的第 3120 秒"续播，
   而直播流根本不存在这个位置。
2. **播放解析是 MediaRef 驱动**（`player-core/playback-resolver.ts`）。
   电台是用户手填的 URL，不是目录域里的条目 → 要么新增一个
   `radio` provider + 电台表，要么绕过 resolver 直接 `playerLoadFile`。
   后者等于在 IPC 契约外开一条旁路，前者要为"无 itemId/无来源"造一套
   新的 MediaRef 语义。
3. **播放队列假设有"曲目"**（`stores/music-playback-store`）。上下曲、
   收藏、歌词、歌词面板、桌面歌词、续播全部按 trackId 或
   `{serverId,itemId}` 走；电台没有 trackId、没有歌词、没有收藏对象。
4. **UI 语义不同**：进度条 / 剩余时间 / 拖拽 seek 对直播无意义，
   迷你条要变成"LIVE + 电台名 + 当前曲目（ICY）"的另一种形态；
   而 ICY 曲目更新需要主进程观察 mpv 的 `metadata`/`icy-title` 并转发
   （现有 `player:on-state-change` 只转 currentTime/duration/volume/
   isPlaying/fullscreen，**不含元数据**）——这是新增能力，不是接线。
5. **失败语义不同**：电台断流通常是 error 而不是 eof，需要重连退避
   （`reconnect`）、"重试中"状态、以及"永不自动下一曲"的显式规则。

## 决策

**不做**。理由：这是一条独立于"媒体库"的新形态（用户手填的直播源），
按上面的清点，等于要给播放状态机开一条平行通道（新 provider / 新表 /
新 UI 形态 / 新进度语义 / 新元数据转发），而不是像服务器音乐或服务器
歌单那样复用既有管线。相对而言它的用户价值（在媒体库里听电台）低于
同样的工作量放到"把现有音乐链路的边角补齐"。

保留的可能是"只读型电台"：不做进度/续播/歌词/收藏，纯粹
`loadfile <url>` + 极简控制条 + ICY 标题。若将来要做，按下面顺序：

1. `music_tracks` 之外新增 `radio_stations`（migration 追加）或先用
   `app_config` 存 URL 列表（省一次 migration，但不好查询）；
2. `playback-state` 增加"不可续播媒体"标志（`mediaType: 'radio'` 时
   跳过 `addWatchHistory` 与 `saveProgress`）——**这一步是硬前置**，
   否则会污染历史与续播；
3. mpv 侧 `--stream-lavf-o=reconnect=1`、`--network-timeout=10`、
   加大 `--cache`；error → 有限次重连而非 eof 自动下一曲；
4. 主进程观察 `metadata` 并转发 `icy-title` 作为"当前曲目"；
5. 迷你条增加 LIVE 形态（无进度条、无 seek、无收藏/歌词按钮）。

## 后果

- 正面：不引入平行播放通道，媒体库/历史/续播的既有不变量保持成立。
- 负面：明确放弃一个 P2 功能；**若将来要做，第 2 步（不可续播标志）
  必须先落地**，否则历史与续播会被直播流污染。
- 遗留验证（真要做时才需要，已进 `docs/TARGET-VERIFY.md`）：目标机
  ffmpeg 的 ICY 是否真的把 `icy-title` 填进 mpv 元数据；断流重连在
  老机 mpv 0.29 上的实际表现。
