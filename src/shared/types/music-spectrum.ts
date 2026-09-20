/**
 * 离线频谱契约（QYP3-050）。
 *
 * 背景：mpv 引擎的音乐（非 Chromium 直解格式、CUE、兼容性优先、直解失败兜底）
 * 在 mpv 0.32 下拿不到实时频谱（无 `audio-fft`），渲染层只能画一根静音底线。
 * 这里改成**主进程离线预算**：用外部 ffmpeg 把该曲目解码成 PCM，算成
 * 「每 1/12 秒 × 48 频带」的字节矩阵落盘，渲染层按 mpv 报回的进度索引回放。
 * 声音仍由 mpv 播放，播放路径不变。
 *
 * 按 `mediaId` 区分曲目；缓存与回包都带它，渲染层据此丢弃过期结果（切歌竞态）。
 */

/** 一次离线频谱任务的输入（主进程内部构造，不跨 IPC）。 */
export interface SpectrumJob {
  /** 播放侧身份：本地 `<sourceId>:<path>`、服务器 `srv:<provider>:<serverId>:<itemId>`。 */
  mediaId: string;
  /** mpv 实际加载的地址：本地绝对路径，或服务器/WebDAV 的上游 URL。 */
  url: string;
  /** 与 mpv 同一份认证头（`Header: value\r\n` 形式；本地文件为空）。 */
  headers?: string;
  /** 时长（秒）：超长曲目直接跳过，也用于 `-t` 截断。 */
  durationSec?: number;
  /** 分轨起点（CUE 预留，暂未接线）。 */
  startSec?: number;
  /** 本地文件的廉价指纹 `size:mtimeMs`，文件被换掉时让缓存失效。 */
  fileStamp?: string;
}

/** ask → 主进程当前 mpv 音乐曲目的频谱状态（非关键路径，永不 err）。 */
export type GetSpectrumResult =
  /** 已就绪：`data` 是 `frameCount × bands` 的连续字节（每帧一字节一频带）。 */
  | { status: 'ready'; mediaId: string; fps: number; bands: number; frameCount: number; data: Uint8Array }
  /** 正在算（后台解码中）：稍后会有 ON_SPECTRUM_READY 推送。 */
  | { status: 'pending'; mediaId: string }
  /** 本会话不可用（没找到可用的 ffmpeg）——不再重试。 */
  | { status: 'unavailable'; mediaId: string; reason: 'no-ffmpeg' }
  /** 这一首算失败了（解码错误/超时/取消）——本会话不重试。 */
  | { status: 'failed'; mediaId: string }
  /** 当前没有 mpv 音乐曲目（或该曲目不需要/不生成）。 */
  | { status: 'none' };

/**
 * main → renderer 推送：某曲目的离线频谱**已定论**（就绪/不可用/失败都会推）。
 * 只带身份与结局，数据仍由 `GET_SPECTRUM` 取（缓存命中时才有 100+KB 要搬）。
 */
export interface SpectrumReadyEvent {
  mediaId: string;
  status: 'ready' | 'unavailable' | 'failed';
}
