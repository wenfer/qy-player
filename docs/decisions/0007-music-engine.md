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
