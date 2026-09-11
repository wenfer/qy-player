import { create } from 'zustand';

/**
 * Next-episode provider registry (QYP2-035).
 *
 * 播放中的页面（Detail 的剧集视图）在挂载时注册「给我当前剧集的下一集」
 * 的回调；全局倒计时组件在 main 推送 countdown 事件后调用它决定是否
 * 有下一集。页面卸载即注销——离开页面后倒计时自动取消，不会串集。
 */

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

interface AutoNextStore {
  provider: ((media: {
    mediaType: string;
    mediaId: string;
    seasonNumber?: number | null;
    episodeNumber?: number | null;
  }) => Promise<NextEpisodeChoice | null>) | null;
  setProvider: (provider: AutoNextStore['provider']) => void;
}

export const useAutoNextStore = create<AutoNextStore>((set) => ({
  provider: null,
  setProvider: (provider) => set({ provider }),
}));
