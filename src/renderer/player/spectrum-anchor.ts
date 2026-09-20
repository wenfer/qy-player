/**
 * 播放位置锚点（QYP3-050）。
 *
 * mpv 音乐的位置由主进程状态事件推送（`attachMusicMpvBridge`），但那是**离散**
 * 的（mpv 本身约 1Hz 上报）。离线频谱是 12fps 的矩阵，直接拿离散位置去索引会
 * 一秒一跳。所以这里维护一个锚点：每次收到位置事件就重置，两次之间按
 * `(now - at) / 1000` 线性外推。
 *
 * 纯函数：不读时钟、不碰 store，`now` 由调用方传入（`performance.now()`）。
 */

export interface PositionAnchor {
  position: number;
  /** 收到这个位置时的时刻（与 `now` 同一时间基准）。 */
  at: number;
  playing: boolean;
}

/** 收到一份新的播放状态（主进程推送 / 本地播放回调）时重建锚点。 */
export function makeAnchor(position: number, playing: boolean, now: number): PositionAnchor {
  return { position, at: now, playing };
}

/**
 * 估算当前播放位置（秒）：播放中外推，暂停/未播放冻结在锚点。
 * 永远不小于 0（seek 到 0 之后外推也不会变负）。
 */
export function estimatePosition(anchor: PositionAnchor, playing: boolean, now: number): number {
  if (!playing || !anchor.playing) return Math.max(0, anchor.position);
  const elapsed = (now - anchor.at) / 1000;
  if (!Number.isFinite(elapsed) || elapsed <= 0) return Math.max(0, anchor.position);
  return Math.max(0, anchor.position + elapsed);
}
