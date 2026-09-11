// 播放器状态
export interface PlayerState {
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  isMuted: boolean;
  isFullscreen: boolean;
}

// 播放控制动作
export type PlayerControlAction =
  | 'play'
  | 'pause'
  | 'toggle-pause'
  | 'seek'
  | 'volume'
  | 'fullscreen'
  | 'cycle-subtitle'
  | 'add-subtitle';

// 服务器配置
export interface ServerConfig {
  id?: number;
  type: 'jellyfin' | 'emby';
  name?: string;
  baseUrl: string;
  // No apiKey on the shared contract (QYP2-015): tokens never cross the
  // renderer boundary. Main-side code keeps its own narrow config type.
  username?: string;
  password?: string;
  userId?: string;
  isActive?: boolean;
}

// 播放进度
export interface PlaybackProgress {
  mediaType: 'local' | 'jellyfin' | 'emby';
  mediaId: string;
  localMediaId?: number;
  position: number;
  duration?: number;
  isFinished?: boolean;
  updatedAt?: number;
}

// 播放上下文（用于历史记录存储）
export interface MediaContext {
  mediaType: string;
  mediaId: string;
  title?: string;
  seriesName?: string;
  seasonNumber?: number;
  episodeNumber?: number;
  mediaSourceId?: string;
}

// 观看历史
export interface WatchHistoryItem {
  id?: number;
  mediaType: string;
  mediaId: string;
  title: string;
  posterUrl?: string;
  path?: string;
  position: number;
  duration?: number;
  watchedAt: number;
  seriesName?: string;
  seasonNumber?: number;
  episodeNumber?: number;
}

// 字幕轨道
export interface SubtitleTrack {
  path: string;
  title: string;
  language: string;
  languageCode: string;
  isDefault: boolean;
}

// 统一媒体项（海报墙使用）
export interface MediaItem {
  id: string;
  type: 'movie' | 'series' | 'episode' | 'season';
  name: string;
  originalName?: string;
  overview?: string;
  year?: number;
  rating?: number;
  primaryImageUrl?: string;
  backdropImageUrl?: string;
  serverType: 'jellyfin' | 'emby';
  serverId: number;
  parentId?: string;
  seasonNumber?: number;
  episodeNumber?: number;
  seriesName?: string;
}

// ---- Phase 2 unified catalog & action contracts ----
export * from './catalog';
export * from './media-info';
export * from './subtitles';
export * from './metadata-editor';
export * from './safe-delete';
export * from './plugins';
export * from './actions';

export * from './playback';
