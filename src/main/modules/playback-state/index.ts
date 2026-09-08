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
  private onProgressSaved?: (payload: ProgressSyncPayload) => void | Promise<void>;

  constructor(player: PlayerCore, storage: Storage) {
    this.player = player;
    this.storage = storage;
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

    // Save on playback end
    this.player.on('eof', () => {
      this.saveCurrentProgress(true);
    });

    // Save when MPV disconnects (window closed, process killed)
    this.player.on('disconnect', () => {
      this.saveCurrentProgress();
      this.clearCurrentMedia();
    });

    // Save when MPV crashes/exits
    this.player.on('crashed', () => {
      this.saveCurrentProgress();
      this.clearCurrentMedia();
    });
  }

  destroy(): void {
    // Final save before shutdown
    this.saveCurrentProgress();
    if (this.saveInterval) {
      clearInterval(this.saveInterval);
      this.saveInterval = null;
    }
  }

  setOnProgressSaved(callback: (payload: ProgressSyncPayload) => void | Promise<void>): void {
    this.onProgressSaved = callback;
  }

  setCurrentMedia(
    mediaType: string,
    mediaId: string,
    title?: string,
    seriesName?: string,
    localMediaId?: number,
    seasonNumber?: number,
    episodeNumber?: number,
    mediaSourceId?: string
  ): void {
    this.currentMediaType = mediaType;
    this.currentMediaId = mediaId;
    this.currentTitle = title || extractTitleFromPath(mediaId);
    this.currentSeriesName = seriesName ?? null;
    this.currentLocalMediaId = localMediaId ?? null;
    this.currentSeasonNumber = seasonNumber ?? null;
    this.currentEpisodeNumber = episodeNumber ?? null;
    this.currentMediaSourceId = mediaSourceId ?? null;
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
  }

  getResumePosition(mediaType: string, mediaId: string): number {
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

  private saveCurrentProgress(forceFinished = false): void {
    if (!this.currentMediaType || !this.currentMediaId) return;

    const state = this.player.getState();
    const position = state.currentTime;
    const duration = state.duration;

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

    // Only save playback progress if we have valid duration
    if (duration > 0) {
      const isFinished = forceFinished || position / duration > 0.9;

      this.storage.saveProgress({
        mediaType: this.currentMediaType,
        mediaId: this.currentMediaId,
        localMediaId: this.currentLocalMediaId ?? undefined,
        position,
        duration,
        isFinished,
      });

      // Sync progress back to Emby/Jellyfin server
      this.onProgressSaved?.({
        mediaType: this.currentMediaType,
        mediaId: this.currentMediaId,
        position,
        duration,
        isFinished,
        mediaSourceId: this.currentMediaSourceId ?? undefined,
      });
    }
  }
}

function extractTitleFromPath(path: string): string {
  const name = basename(path, extname(path));
  return name.replace(/[._]/g, ' ').trim();
}
