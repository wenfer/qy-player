import { basename, extname } from 'path';
import { PlayerCore } from '../player-core';
import { Storage } from '../storage/db';

export interface ContinueWatchingItem {
  media_type: string;
  media_id: string;
  title?: string;
  poster_url?: string;
  position: number;
  duration?: number;
}

export interface ProgressSyncPayload {
  mediaType: string;
  mediaId: string;
  position: number;
  duration?: number;
  isFinished: boolean;
  mediaSourceId?: string;
  playSessionId?: string;
  /** 连接断开/退出等收尾场景：服务端走 Stopped（位置才能落 UserData）。 */
  final?: boolean;
}

/**
 * Phase-2 progress sink for catalog media whose keys the phase-1
 * playback_progress CHECK cannot hold (webdav). Wired by the IPC layer to
 * catalog_user_state; local path keys stay on the legacy tables.
 */
export interface CatalogProgressSink {
  save(mediaType: string, mediaId: string, position: number, duration: number, isFinished: boolean): void;
  getResumePosition(mediaType: string, mediaId: string): number;
}

export class PlaybackStateManager {
  private player: PlayerCore;
  private storage: Storage;
  private saveInterval: NodeJS.Timeout | null = null;
  private currentMediaType: string | null = null;
  private currentMediaId: string | null = null;
  private currentTitle: string | null = null;
  private currentSeriesName: string | null = null;
  private currentLocalMediaId: number | null = null;
  private currentSeasonNumber: number | null = null;
  private currentEpisodeNumber: number | null = null;
  private currentMediaSourceId: string | null = null;
  private currentPlaySessionId: string | null = null;
  private onProgressSaved?: (payload: ProgressSyncPayload) => void | Promise<void>;
  private catalogProgress?: CatalogProgressSink;
  /**
   * 当前加载的是不是音乐（QYP3-053）。音乐**不写播放历史**（用户诉求），
   * 但仍要把进度回传给 Emby/Jellyfin；mpv 音乐由 `isMpvMusicActive()` 判定。
   */
  private isMusic?: () => boolean;

  constructor(
    player: PlayerCore,
    storage: Storage,
    catalogProgress?: CatalogProgressSink,
    isMusic?: () => boolean
  ) {
    this.player = player;
    this.storage = storage;
    this.catalogProgress = catalogProgress;
    this.isMusic = isMusic;
  }

  init(): void {
    // Auto-save progress every 10 seconds - frequent enough to capture
    // position accurately, but not so often that it hammers SQLite/HTTP.
    this.saveInterval = setInterval(() => {
      this.saveCurrentProgress();
    }, 10000);

    // Save immediately on pause
    this.player.on('pause', () => {
      this.saveCurrentProgress();
    });

    // Save on playback end (natural EOF only)
    this.player.on('eof', () => {
      this.saveCurrentProgress();
    });

    // Save when MPV disconnects (window closed, process killed).
    // final=true：服务端走 Stopped——Emby 仅以 Stopped 把位置写入
    // UserData（实测教训），Progress 只更新会话状态。
    this.player.on('disconnect', () => {
      this.saveCurrentProgress(true);
      this.clearCurrentMedia();
    });

    // Save when MPV crashes/exits
    this.player.on('crashed', () => {
      this.saveCurrentProgress(true);
      this.clearCurrentMedia();
    });
  }

  destroy(): void {
    // Final save before shutdown
    this.saveCurrentProgress(true);
    if (this.saveInterval) {
      clearInterval(this.saveInterval);
      this.saveInterval = null;
    }
  }

  setOnProgressSaved(callback: (payload: ProgressSyncPayload) => void | Promise<void>): void {
    this.onProgressSaved = callback;
  }

  /**
   * 立即保存一次进度并按收尾语义上报（QYP3-067：mpv stop——音乐引擎切换/
   * 队尾停时 renderer 显式触发）。final=true → 服务端走 Stopped，位置才能
   * 落 UserData。时间轴读的是 PlayerCore 保留的最后一次真实 time-pos
   * （mpv 卸载文件时补发 null 不归零，见硬性约束）。
   */
  saveProgressNow(): void {
    this.saveCurrentProgress(true);
  }

  setCurrentMedia(
    mediaType: string,
    mediaId: string,
    title?: string,
    seriesName?: string,
    localMediaId?: number,
    seasonNumber?: number,
    episodeNumber?: number,
    mediaSourceId?: string,
    playSessionId?: string
  ): void {
    this.currentMediaType = mediaType;
    this.currentMediaId = mediaId;
    this.currentTitle = title || extractTitleFromPath(mediaId);
    this.currentSeriesName = seriesName ?? null;
    this.currentLocalMediaId = localMediaId ?? null;
    this.currentSeasonNumber = seasonNumber ?? null;
    this.currentEpisodeNumber = episodeNumber ?? null;
    this.currentMediaSourceId = mediaSourceId ?? null;
    // 服务端播放会话（Sessions/Playing 系列 API 的 PlaySessionId）。
    this.currentPlaySessionId = playSessionId ?? null;
  }

  clearCurrentMedia(): void {
    this.currentMediaType = null;
    this.currentMediaId = null;
    this.currentTitle = null;
    this.currentSeriesName = null;
    this.currentLocalMediaId = null;
    this.currentSeasonNumber = null;
    this.currentEpisodeNumber = null;
    this.currentMediaSourceId = null;
    this.currentPlaySessionId = null;
  }

  getResumePosition(mediaType: string, mediaId: string): number {
    // WebDAV keys never touch the phase-1 tables (CHECK constraint);
    // they live in catalog_user_state through the injected sink.
    if (mediaType === 'webdav' && this.catalogProgress) {
      return this.catalogProgress.getResumePosition(mediaType, mediaId);
    }
    const progress = this.storage.getProgress(mediaType, mediaId);
    if (!progress) return 0;
    if (progress.duration && progress.position / progress.duration > 0.9) {
      return 0;
    }
    return progress.position;
  }

  getContinueWatching(limit = 20): ContinueWatchingItem[] {
    return this.storage.getContinueWatching(limit);
  }

  private saveCurrentProgress(final = false): void {
    if (!this.currentMediaType || !this.currentMediaId) return;

    const state = this.player.getState();
    const position = state.currentTime;
    const duration = state.duration;
    // Finished-ness is position-derived ONLY (plan §12.1): a stream that
    // dies mid-file fires eof too, and must never be marked finished.
    const isFinished = duration > 0 && position / duration > 0.9;

    // 音乐不写播放历史（QYP3-053）：只回传服务器；"上次在放哪首/放到哪"
    // 由渲染层经 MUSIC.SET_NOW_PLAYING 单独存一条（见 now-playing.ts）。
    const music = this.isMusic?.() ?? false;

    if (!music) {
      // Always save watch history, even if duration is not yet available
      this.storage.addWatchHistory({
        mediaType: this.currentMediaType,
        mediaId: this.currentMediaId,
        title: this.currentTitle || this.currentMediaId,
        // For local media, mediaId is the file path
        path: this.currentMediaType === 'local' ? this.currentMediaId : undefined,
        position,
        duration: duration > 0 ? duration : undefined,
        seriesName: this.currentSeriesName ?? undefined,
        seasonNumber: this.currentSeasonNumber ?? undefined,
        episodeNumber: this.currentEpisodeNumber ?? undefined,
      });

      // WebDAV progress lives in catalog_user_state (the phase-1 CHECK
      // rejects webdav keys); local path keys stay on the legacy tables.
      if (this.currentMediaType === 'webdav' && this.catalogProgress) {
        if (duration > 0) {
          this.catalogProgress.save(
            this.currentMediaType,
            this.currentMediaId,
            position,
            duration,
            isFinished
          );
        }
      } else if (duration > 0) {
        // Progress rows are never zeroed here — a network/auth failure keeps
        // the last known position for resume.
        this.storage.saveProgress({
          mediaType: this.currentMediaType,
          mediaId: this.currentMediaId,
          localMediaId: this.currentLocalMediaId ?? undefined,
          position,
          duration,
          isFinished,
        });
      }
    }

    // 服务器回传与本地写解耦（QYP3-053）：音乐（服务器曲目）也要回传；
    // 本地写已被上面的 !music 闸门挡住。webdav 没有服务器，天然不过这里。
    if (duration > 0 && this.currentMediaType !== 'webdav') {
      // Sync progress back to Emby/Jellyfin server
      this.onProgressSaved?.({
        mediaType: this.currentMediaType,
        mediaId: this.currentMediaId,
        position,
        duration,
        isFinished,
        mediaSourceId: this.currentMediaSourceId ?? undefined,
        playSessionId: this.currentPlaySessionId ?? undefined,
        final,
      });
    }
  }
}

function extractTitleFromPath(path: string): string {
  const name = basename(path, extname(path));
  return name.replace(/[._]/g, ' ').trim();
}
