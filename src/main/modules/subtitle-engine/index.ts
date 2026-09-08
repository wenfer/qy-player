import { scanForSubtitles, selectBestSubtitle, SubtitleTrack } from './scanner';
import { PlayerCore } from '../player-core';

export { scanForSubtitles, selectBestSubtitle };
export type { SubtitleTrack };

export class SubtitleEngine {
  private player: PlayerCore;
  private currentTracks: SubtitleTrack[] = [];

  constructor(player: PlayerCore) {
    this.player = player;
  }

  scanForSubtitles(videoPath: string): SubtitleTrack[] {
    this.currentTracks = scanForSubtitles(videoPath);
    return this.currentTracks;
  }

  async autoLoadSubtitle(videoPath: string, preferredLang = 'zh'): Promise<void> {
    const tracks = this.scanForSubtitles(videoPath);
    const best = selectBestSubtitle(tracks, preferredLang);
    if (best) {
      await this.player.addSubtitle(best.path);
    }
  }

  async setSubtitleDelay(delayMs: number): Promise<void> {
    const delaySeconds = delayMs / 1000;
    await this.player.setSubtitleDelay(delaySeconds);
  }

  getCurrentTracks(): SubtitleTrack[] {
    return [...this.currentTracks];
  }
}
