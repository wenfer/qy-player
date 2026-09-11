/**
 * Unified resume contracts (QYP2-033, plan §12.1/§12.2).
 *
 * 单一事实来源：电影/单集/剧集的起播位置与原因只在这里定义一次，
 * playback-state、PlaybackResolver 与 renderer 都消费同一个纯函数，
 * 不允许各处复制 30s/90% 规则。
 */

/** §12.1: 有效续播门槛——position 至少 30 秒。 */
export const RESUME_MIN_POSITION_S = 30;
/** §12.1: 完成阈值沿用 90%（二期不做迁移变更）。 */
export const RESUME_FINISHED_RATIO = 0.9;

export interface ResumeProgress {
  position: number;
  duration: number;
  isFinished?: boolean;
  /** Epoch ms；剧集「最近播放」排序用。缺省视为未知（排最后）。 */
  updatedAt?: number;
}

export type ResumeReason =
  /** 有效历史，从 position 继续。 */
  | 'resume'
  /** 无有效历史/已看完/从头播放：从 0 开始。 */
  | 'start'
  /** 最近一集已完成且存在下一集：下一集从 0 开始（§12.2 规则 2）。 */
  | 'next-episode'
  /** 全部完成：确认后从第一集重播（§12.2 规则 4）。 */
  | 'replay';

export interface ResumeTarget {
  itemId: number;
  position: number;
  reason: ResumeReason;
  seasonNumber?: number | null;
  episodeNumber?: number | null;
  /** 目标单集标题（§12.2：按钮文案「继续播放 S01E05 · 23:18」直接可用）。 */
  title?: string | null;
}

/** 剧集续播解析的输入：该系列下全部单集（季/集号与各自进度）。 */
export interface ResumeEpisodeInput {
  itemId: number;
  seasonNumber?: number | null;
  episodeNumber?: number | null;
  progress?: ResumeProgress | null;
  /** 单集标题（透传到 ResumeTarget，§12.2 按钮文案用）。 */
  title?: string | null;
}
