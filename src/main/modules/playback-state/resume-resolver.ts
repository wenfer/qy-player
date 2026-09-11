/**
 * ResumeResolver — pure functions (QYP2-033, plan §12.1/§12.2).
 *
 * 单一事实来源：电影/单集/剧集的起播位置与原因只在这里计算一次。
 * 硬性规则：
 * - 有效续播：position ≥ 30s 且 duration 有效且未完成（§12.1）；
 * - 完成阈值 90%（二期不变更）；
 * - 0/null 进度一律视为「无历史」，绝不覆盖真实历史（与存储层
 *   COALESCE 语义呼应——resolver 是最后一道防线）；
 * - isFinished 标记优先于比例推导（两者不一致时按已看完处理）；
 * - 「从头播放」不清历史：调用方直接以 position 0 起播即可，本模块
 *   不提供删除入口。
 *
 * 剧集主按钮算法 = §12.2 的 1–4 规则，纯函数、表驱动可测：
 *   1. 最近播放单集未完成 → 续播该集该位置；
 *   2. 已完成且存在下一集 → 下一集从 0；
 *   3. 无历史 → 排序后第一集（含特别篇 S0 排最前）；
 *   4. 全部完成 → 重播第一集（reason 'replay'，UI 负责确认文案）。
 */

import {
  RESUME_FINISHED_RATIO,
  RESUME_MIN_POSITION_S,
  type ResumeEpisodeInput,
  type ResumeProgress,
  type ResumeReason,
  type ResumeTarget,
} from '../../../shared/types/playback';

/** 单集进度是否代表「已看完」（isFinished 标记优先，比例推导兜底）。 */
export function isProgressFinished(progress: ResumeProgress): boolean {
  if (progress.isFinished === true) return true;
  const { position, duration } = progress;
  if (typeof duration === 'number' && duration > 0 && typeof position === 'number' && position > 0) {
    return position / duration > RESUME_FINISHED_RATIO;
  }
  return false;
}

/**
 * 进度快照是否构成有效续播历史（用于单集续播）：≥30s、未看完；
 * 0/null 一律无效。已看完的快照是「真实历史」但不可续播——
 * 用 hasWatchHistory 区分。
 */
export function hasValidProgress(progress: ResumeProgress | null | undefined): progress is ResumeProgress {
  if (!hasWatchHistory(progress)) return false;
  if (isProgressFinished(progress)) return false;
  return true;
}

/**
 * 进度快照是否代表真实观看历史（剧集规则 1–2 的「最近播放」判定）：
 * position ≥ 30s 或被标记看完。0/null 不构成历史。
 */
export function hasWatchHistory(progress: ResumeProgress | null | undefined): progress is ResumeProgress {
  if (!progress || typeof progress !== 'object') return false;
  const { position } = progress;
  if (typeof position === 'number' && Number.isFinite(position) && position >= RESUME_MIN_POSITION_S) {
    return true;
  }
  return isProgressFinished(progress);
}

/**
 * 电影/单集起播决策（§12.1）。
 * 无历史 / 不足 30s / 已看完 → 从 0 开始（reason 'start'）。
 */
export function resolveSingleResume(progress: ResumeProgress | null | undefined): {
  position: number;
  reason: ResumeReason;
} {
  if (!hasValidProgress(progress)) {
    return { position: 0, reason: 'start' };
  }
  return { position: progress.position, reason: 'resume' };
}

/** 季集排序键：特别篇（S0/无季号）排最前，其后按季、集升序。 */
function episodeOrderKey(episode: ResumeEpisodeInput): [number, number] {
  const season = typeof episode.seasonNumber === 'number' && episode.seasonNumber >= 0 ? episode.seasonNumber : 0;
  const ep = typeof episode.episodeNumber === 'number' && episode.episodeNumber >= 0 ? episode.episodeNumber : 0;
  return [season, ep];
}

function sortedEpisodes(episodes: ResumeEpisodeInput[]): ResumeEpisodeInput[] {
  return [...episodes].sort((a, b) => {
    const [sa, ea] = episodeOrderKey(a);
    const [sb, eb] = episodeOrderKey(b);
    return sa - sb || ea - eb;
  });
}

/**
 * 剧集主按钮解析（§12.2 规则 1–4）。episodes 为空 → null（调用方决定
 * 展示「无可播内容」）。输出必须带明确的 reason，renderer 不得复制算法。
 */
export function resolveSeriesResume(episodes: ResumeEpisodeInput[]): ResumeTarget | null {
  if (!Array.isArray(episodes) || episodes.length === 0) return null;
  const sorted = sortedEpisodes(episodes);

  // 最近播放：统计真实观看历史（≥30s 或已看完——看完的集要参与
  // 「下一集」推导，§12.2 规则 2）；updatedAt 缺省排最后。
  const watched = sorted.filter((entry) => hasWatchHistory(entry.progress));
  if (watched.length === 0) {
    // 规则 3：无历史 → 第一集未播放内容。第一集若已看完（如 <30s 的
    // 脏数据不算看完，真实看完走 watched 分支）从 0 正常覆盖。
    const first = sorted[0];
    return toTarget(first, 0, 'start');
  }

  const last = watched.reduce((acc, entry) => {
    const a = acc.progress?.updatedAt ?? -1;
    const b = entry.progress?.updatedAt ?? -1;
    return b > a ? entry : acc;
  }, watched[0]);

  const lastFinished = isProgressFinished(last.progress as ResumeProgress);
  if (!lastFinished) {
    // 规则 1：最近播放单集未完成 → 该集该位置。
    return toTarget(last, last.progress!.position, 'resume');
  }

  // 规则 2：已完成且存在下一集 → 下一集从 0。
  const lastKey = episodeOrderKey(last);
  const next = sorted.find((entry) => {
    const key = episodeOrderKey(entry);
    return key[0] > lastKey[0] || (key[0] === lastKey[0] && key[1] > lastKey[1]);
  });
  if (next) {
    return toTarget(next, 0, 'next-episode');
  }

  // 规则 4：全部完成 → 重播第一集（UI 显示「重新播放」并确认）。
  return toTarget(sorted[0], 0, 'replay');
}

function toTarget(
  episode: ResumeEpisodeInput,
  position: number,
  reason: ResumeReason
): ResumeTarget {
  return {
    itemId: episode.itemId,
    position: Number.isFinite(position) && position > 0 ? position : 0,
    reason,
    seasonNumber: episode.seasonNumber ?? null,
    episodeNumber: episode.episodeNumber ?? null,
  };
}
