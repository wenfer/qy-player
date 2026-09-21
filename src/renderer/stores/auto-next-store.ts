import { create } from 'zustand';

/**
 * Next-episode provider registry (QYP2-035).
 *
 * 播放中的页面（Detail 的剧集视图）在挂载时注册「给我当前剧集的下一集」
 * 的回调；全局倒计时组件在 main 推送 countdown 事件后调用它决定是否
 * 有下一集。页面卸载即注销——离开页面后倒计时自动取消，不会串集。
 *
 * QYP3-068q：同一个 provider 也承担**手动**上一集/下一集（播放条按钮、
 * 全局快捷键）——`direction` 由调用方给，排序仍在主进程的纯函数里，
 * 渲染层只提供"这部戏的全集列表"。
 */

/** 切集方向：自动连播恒为 next；手动按钮/快捷键可能是 prev。 */
export type EpisodeDirection = 'next' | 'prev';

export interface NextEpisodeChoice {
  itemId: number | string;
  title?: string | null;
  seasonNumber?: number | null;
  episodeNumber?: number | null;
  mediaSourceId?: string | null;
  /** Playback routing (strict per-server, QYP2-015). */
  provider?: string;
  serverId?: number;
}

/** 调用 provider 时告诉它"当前在播哪一集"（季/集号来自主进程的媒体快照）。 */
export interface EpisodeQuery {
  mediaType: string;
  mediaId: string;
  seasonNumber?: number | null;
  episodeNumber?: number | null;
}

interface AutoNextStore {
  provider:
    | ((media: EpisodeQuery, direction: EpisodeDirection) => Promise<NextEpisodeChoice | null>)
    | null;
  setProvider: (provider: AutoNextStore['provider']) => void;
}

export const useAutoNextStore = create<AutoNextStore>((set) => ({
  provider: null,
  setProvider: (provider) => set({ provider }),
}));
