# 决策记录 0007 — 音乐播放引擎双通道

- 状态：Draft（三期规划，待评审）
- 日期：2026-09-14
- 关联：ADR-0005（probe 预算）、ADR-0001（目录域 MediaRef）；实现位于
  `src/main/modules/playback-engine/`（规划路径）

## 背景

三期需要音乐播放。要求：①尽可能兼容音频格式；②拾音器（可视化频谱）
效果。两者天然冲突：兼容性最强的解码后端是 mpv/FFmpeg（ape/wma/wv/dsf
等 Chromium 都不支持），但 mpv 0.32 不暴露解码后 PCM，拿不到实时频谱；
Chromium `<audio>` + Web Audio 能给真频谱，却解不了冷门格式。

## 决策

音频按**探测结果**分两条播放通道，由主进程纯函数选择器收敛（单一来源，
UI 不得复制算法）：

1. **direct（renderer 引擎）**：Chromium 原生可解码格式
   （mp3/aac/m4a/flac/ogg/opus/wav 等）在 renderer 内播放：
   `<audio>` 元素 + Web Audio 图（`MediaElementSource → AnalyserNode →
   BiquadFilter×10 → GainNode → destination`）。实时频谱、均衡器、
   ReplayGain（若标签可读）全能力，上下曲零子进程开销。
2. **native（mpv 引擎）**：其余全部格式走现有 PlayerCore 子进程
   （FFmpeg 后端），追加音频参数：`--gapless-audio=weak`、
   `--replaygain=<用户设置>`；`--hwdec=no` 链路不变。兼容性最大化；
   拾音器降级为**播放波形**（基于时长+进度绘制，无需频谱数据）。

用户可设**引擎偏好**：`拾音器优先（默认）`= direct 可解码就用 renderer
引擎；`兼容性优先` = 全部走 mpv。偏好只在 direct/native 边界内生效，
不允许用户强行把 direct 格式推进 mpv（防止配置出奇异状态）。

## 后果

- 正面：一个应用同时拿到"全兼容"与"真频谱"；老机 CPU 开销可控
  （renderer 引擎不解冷门格式，mpv 不为可视化做额外解码）。
- 负面：两条通道的状态（进度/播放/暂停/队列位置）必须归一后对 UI 单点
  暴露——任务 QYP3-011 先行验收；均衡器参数需要双引擎各一份映射实现。
- 红线不变：不引入原生解码依赖；不升级 Electron；mpv 子进程管理规则
  （drain、静默、退出清理）原样适用。

## 拾音器数据源（附录）

- renderer 引擎：`AnalyserNode`（fftSize ≤ 2048，帧率 ≤ 30fps）。
- mpv 引擎：播放波形（纯绘制）；"离线频谱缓存"列为 spike（PHASE3-PLAN
  §5），spike 失败不阻塞、不引入新依赖。

## 修订（QYP3-037，2026-09-18）：服务器/WebDAV 音频改走 renderer 引擎

### 背景

初版把「服务器音频 → mpv」当成硬规则，理由有二：流需要认证头，渲染层无法
注入；跨源媒体经 `createMediaElementSource` 非 CORS-clean 时输出静音。代价是
服务器/WebDAV 音乐只有降级波形，频谱图永远显示「mpv 0.32 没有实时频谱接口」。
mpv 0.32 已核实无任何 IPC 音频采样接口，该限制无解——唯一出路是让这些音源
进 renderer 引擎。

### 决策

新增主进程认证流代理 `qy-stream://audio/<opaqueId>`（`registerStreamProtocol`，
特权元组 `standard/secure/supportFetchAPI/stream`，**不加** corsEnabled）：

- 路由表 `StreamRouteCache`（可重复读取 + 滑动 TTL + LRU）：渲染层只见
  不透明 id，真实上游 URL 与 token（X-Emby-Token / Basic）永不跨 IPC——
  顺带修掉了 `api_key` 拼在直链 query 里进渲染层的泄漏。
- 代理用裸 `node:http(s)` 字节转发：强制上游 `Accept-Encoding: identity`，
  下游只透传白名单头（content-type/length/range、accept-ranges 等），
  Range/206 如实透传支撑 seek；客户端中止即销毁上游 socket。
- `selectAudioEngine` 收敛：`sourceKind` 不再参与判定（`server-stream`/
  `webdav-auth` 两个 reason 删除），转码/CUE/兼容性优先/非直解仍 → mpv。
  服务器条目 codec 缺失时**乐观直解**（用户决策：真频谱优先），解码失败
  由既有的 direct → mpv 一次性回退兜底。
- 引擎队列改**按需懒解析**单曲 URL（整队预解析对服务器是 N 次网络请求）；
  解析结果非 webaudio（NEEDS_MPV）→ 服务器曲目直接兜底 mpv（队列可继续），
  本地/WebDAV 先跳下一首、跳不动才兜底。
- 服务器音乐的进度/续播补齐（QYP3-038）：`MUSIC.START_SERVER_SESSION` /
  `MUSIC.REPORT_SERVER_PROGRESS` 两条 IPC 复用既有 playSessionId 语义
  （Emby 要求 Playing/Progress/Stopped 同 id）；WebDAV 续播键修正为
  `<sourceId>:<path>`（原先误读 'local' 域，WebDAV 音乐续播从不生效）。

### 安全与兼容边界

- `qy-file://audio` 语义不变：只服务 local 包含校验内的文件；服务器/WebDAV
  永不在该协议解析。
- mpv 引擎路径（转码 HLS、非直解格式、兼容性优先）原样保留；mpv 子进程
  红线（drain、静默、--hwdec=no）不变。
- 实机行为（Range 流式经 `stream: true` scheme、服务器 seek、FLAC 自救
  走代理）列入 `docs/TARGET-VERIFY.md` 待目标机验证。
