/**
 * Auto-next episode (QYP2-035, plan §12.3).
 *
 * 硬性规则：
 * - 仅自然 EOF 触发（mpv eof-reached；手动停止/崩溃/断开/退出走的是
 *   disconnect/crashed 事件，本控制器根本不监听它们）；
 * - 同一个 EOF 只触发一次（按当前 media 去重，loadfile 后重置）；
 * - 最终进度保存先于倒计时（wiring 侧：PlaybackStateManager 的 eof
 *   保存先注册，本控制器后注册——EventEmitter 顺序保证）；
 * - 倒计时期间取消 → 什么都不发生；fire 后由 renderer 走既有
 *   resolvePlayback + loadFile（顺序：保存 → 切 current media → load）。
 *
 * 「最后一集不显示倒计时」由 renderer 判定：拿不到下一集时立即取消。
 * 下一集的选择算法（pickNextEpisode）是纯函数，也在本文件。
 */

export interface AutoNextEpisodeLike {
  itemId: number | string;
  seasonNumber?: number | null;
  episodeNumber?: number | null;
  title?: string | null;
  mediaSourceId?: string | null;
}

export interface AutoNextMediaSnapshot {
  mediaType: string;
  mediaId: string;
  seriesName?: string | null;
  seasonNumber?: number | null;
  episodeNumber?: number | null;
}

export type AutoNextEvent =
  | { type: 'countdown'; seconds: number; media: AutoNextMediaSnapshot }
  | { type: 'fire'; media: AutoNextMediaSnapshot }
  | { type: 'cancelled'; reason: 'user' | 'no-next-episode' | 'setting' }
  | { type: 'ignored'; reason: 'not-episode' | 'duplicate' };

function orderKey(season: number | null | undefined, episode: number | null | undefined): [number, number] {
  const s = typeof season === 'number' && season >= 0 ? season : 0;
  const e = typeof episode === 'number' && episode >= 0 ? episode : 0;
  return [s, e];
}

/**
 * 给定当前集（季/集号），在全集列表里选下一集（季集升序；同季看集号，
 * 跨季取下一季第一集；特别篇 S0 参与同一排序）。找不到 → null。
 */
export function pickNextEpisode(
  episodes: AutoNextEpisodeLike[],
  currentSeason: number | null | undefined,
  currentEpisode: number | null | undefined
): AutoNextEpisodeLike | null {
  const [cs, ce] = orderKey(currentSeason, currentEpisode);
  const candidates = episodes
    .map((entry) => ({ entry, key: orderKey(entry.seasonNumber, entry.episodeNumber) }))
    .filter(({ key }) => key[0] > cs || (key[0] === cs && key[1] > ce))
    .sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1]);
  return candidates[0]?.entry ?? null;
}

export interface AutoNextOptions {
  countdownMs?: number;
  /** 设置开关（app_config playback.autoNext）；每秒可变，读取实时。 */
  isEnabled: () => boolean;
  /** 事件广播（main → renderer）。 */
  broadcast: (event: AutoNextEvent) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

const DEFAULT_COUNTDOWN_MS = 5000;

export class AutoNextController {
  private readonly options: Required<Pick<AutoNextOptions, 'countdownMs' | 'isEnabled' | 'broadcast'>> &
    Pick<AutoNextOptions, 'now' | 'setTimer' | 'clearTimer'>;
  /** 当前去重锚点：同一 media 的重复 eof 被忽略；loadfile 换 media 后重置。 */
  private pendingMediaId: string | null = null;
  private pendingMedia: AutoNextMediaSnapshot | null = null;
  private timerHandle: unknown = null;

  constructor(options: AutoNextOptions) {
    this.options = {
      countdownMs: options.countdownMs ?? DEFAULT_COUNTDOWN_MS,
      isEnabled: options.isEnabled,
      broadcast: options.broadcast,
      now: options.now,
      setTimer: options.setTimer,
      clearTimer: options.clearTimer,
    };
  }

  /** loadfile 后调用：新 media 重置去重锚点（也清掉残留的 pending）。 */
  markLoaded(media: AutoNextMediaSnapshot): void {
    this.clearPending();
    if (media && typeof media.mediaId === 'string') {
      this.pendingMediaId = null;
      this.currentMediaId = media.mediaId;
      this.currentMedia = media;
    }
  }

  private currentMediaId: string | null = null;
  private currentMedia: AutoNextMediaSnapshot | null = null;

  /** 自然 EOF。只有「当前 media 是剧集单集」才可能进入倒计时。 */
  handleEof(): void {
    const media = this.currentMedia;
    if (!media || media.mediaId !== this.currentMediaId) return;
    if (media.seasonNumber == null || media.episodeNumber == null || !media.seriesName) {
      this.options.broadcast({ type: 'ignored', reason: 'not-episode' });
      return;
    }
    if (!this.options.isEnabled()) {
      this.options.broadcast({ type: 'cancelled', reason: 'setting' });
      return;
    }
    if (this.pendingMediaId === media.mediaId && this.timerHandle !== null) {
      // 同一个 EOF 只触发一次（eof-reached 可能重复上报）。
      this.options.broadcast({ type: 'ignored', reason: 'duplicate' });
      return;
    }
    this.pendingMediaId = media.mediaId;
    this.pendingMedia = media;
    this.options.broadcast({ type: 'countdown', seconds: Math.round(this.options.countdownMs / 1000), media });
    const setTimer = this.options.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    this.timerHandle = setTimer(() => {
      this.timerHandle = null;
      const snapshot = this.pendingMedia;
      this.clearPending();
      if (snapshot) this.options.broadcast({ type: 'fire', media: snapshot });
    }, this.options.countdownMs);
  }

  /** 取消（用户点取消 / renderer 判定无下一集）。 */
  cancel(reason: 'user' | 'no-next-episode'): void {
    if (this.timerHandle === null && this.pendingMediaId === null) return;
    this.clearPending();
    this.options.broadcast({ type: 'cancelled', reason });
  }

  private clearPending(): void {
    if (this.timerHandle !== null) {
      const clearTimer = this.options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as NodeJS.Timeout));
      clearTimer(this.timerHandle);
      this.timerHandle = null;
    }
    this.pendingMediaId = null;
    this.pendingMedia = null;
  }
}
