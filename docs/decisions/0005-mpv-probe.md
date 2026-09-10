# ADR-0005: mpv 探测方案（0.29 / 0.32）

- 状态：Proposed（QYP2-017 spike 结论；QYP2-018 落地 MediaProbe 服务后复核）
- 日期：2026-09-11
- 相关：计划 §10、QYP2-017、QYP2-018、`src/main/modules/media-probe/mpv-probe-spike.ts`

## 背景

详情页需要技术信息（容器、编码、分辨率、帧率、音频、字幕），但目标机只有两种 mpv：Debian 10 系统自带的 0.29 和自编译的 0.32。两者属性名不完全兼容（`video-params/*`、`audio-params/*` 是 0.30+ 才有的），且探测必须满足：无窗口、不继承用户脚本、不开硬解、stdout 有界、stderr 静默 drain、超时与并发有界、与播放进程隔离。

## 决策

**方案：一次性 headless mpv + 临时 JSON IPC socket + 逐属性回退查询。**

备选「单次 `mpv --frames=1` 解析终端输出」被否决：终端输出格式不稳定、字幕/音轨枚举不可靠、错误区分困难。JSON IPC 是播放器已在用的协议（`MpvIpcClient`），复用它零新增依赖。

### 锁定的探测参数

```
--input-ipc-server=<tmp-sock> --idle --no-config
--vo=null --ao=null --hwdec=no <target>
```

| 约束 | 取值 | 理由 |
|---|---|---|
| 窗口 | `--vo=null`（无 `--force-window`） | 永远不建窗口 |
| 音频设备 | `--ao=null` | 不抢声卡；demux 仍解析音轨 |
| 用户脚本/配置 | `--no-config` | 不继承 input conf、mpv.conf、scripts |
| 硬解 | `--hwdec=no` | 与播放一致（AGENTS.md 硬约束） |
| 存活 | `--idle` | 文件加载后保持 IPC 可查 |
| 超时 | 15s 总量（socket 等待 ≤5s，demux settle ≤3s） | 挂起属性用 deadline 竞速打断 |
| stdout | 64 KiB 上限收集 | 诊断用，不无界 |
| stderr | 静默 drain | 与播放进程一致 |
| 并发 | 1（QYP2-018 服务层串行队列） | plan §16.4 probe ≤ 1 |

### 版本兼容回退表

`PROBE_FIELD_CANDIDATES` 按新→旧顺序查询，全部失败记 `unsupported`（不抛错）：

| 字段 | 0.32 首选 | 0.29 回退 |
|---|---|---|
| 视频宽/高 | `video-params/w,h` | `width,height` |
| 音频声道 | `audio-params/channel-count` | `audio-channels` |
| 音频采样率 | `audio-params/samplerate` | `demux-samplerate` |
| 视频比例 | `video-params/aspect` | `video-aspect` |
| 帧率 | `container-fps` | `fps` |
| 时长/容器/编码 | `duration` / `file-format` / `video-format`→`video-codec` / `audio-codec` | 同（两版共有） |
| 音轨/字幕枚举 | `track-list`（两版共有，`demux-*`/`lang`/`external`/`default` 字段） | 同 |

`mpv-version` 属性用于记录版本；读不到记 `unknown`，不阻断探测。

## 缓存指纹的已知弱化（QYP2-019 注记）

在线（Jellyfin/Emby）详情页无本地 size/mtime/ETag，probe 缓存指纹退化为 `RunTimeTicks:Size`（服务器元数据）。文件被原地替换而时长与大小不变时，TTL（6h）内可能读到旧缓存；概率低，接受。transcode 模式的 URL 每次带新 PlaySessionId，缓存对其无效——probe 固定用 direct 模式（HLS 容器信息也有限），缓存语义仅对 direct/本地/WebDAV 成立。

## 后果

- QYP2-018 的 MediaProbe 服务复用 `spawnProbeProcess` + 回退表 + `assembleProbeResult`，加缓存（size+mtime/ETag 版本）与串行队列。
- 手工验证仍需在两台目标机各跑一次真实 mpv（spike 测试用 socket 级 fake 覆盖逻辑，覆盖不了真实属性名差异）。
- 若未来 mpv 属性再次改名，只需在回退表追加候选，无需改编排逻辑。
