import { Play, RotateCcw } from 'lucide-react';
import { RESUME_FINISHED_RATIO } from '../../../shared/types/playback';
import type { Episode } from './index';

/**
 * Episode grid (QYP2-034, plan §12.2): per-episode progress from server
 * UserData + a per-episode 从头播放 affordance. No horizontal scrolling —
 * the grid wraps (AGENTS.md UI 约定).
 */

function formatRuntimeTicks(ticks?: number): string | undefined {
  if (!ticks) return undefined;
  const totalSeconds = Math.floor(ticks / 10000000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export default function EpisodeGrid({
  episodes,
  getImageUrl,
  onPlay,
  onPlayFromStart,
}: {
  episodes: Episode[];
  getImageUrl: (itemId: string, imageType: string, tag: string) => string | undefined;
  onPlay: (episode: Episode) => void;
  onPlayFromStart: (episode: Episode) => void;
}) {
  if (episodes.length === 0) return null;
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
      {episodes.map((ep) => {
        const msId = ep.MediaSources?.[0]?.Id;
        const epPosterUrl = ep.ImageTags?.Primary ? getImageUrl(ep.Id, 'Primary', ep.ImageTags.Primary) : undefined;
        const duration = ep.RunTimeTicks ? ep.RunTimeTicks / 10000000 : 0;
        const position = ep.UserData?.PlaybackPositionTicks ? ep.UserData.PlaybackPositionTicks / 10000000 : 0;
        const finished = ep.UserData?.Played === true || (duration > 0 && position / duration > RESUME_FINISHED_RATIO);
        const pct = duration > 0 && !finished ? Math.min(100, Math.round((position / duration) * 100)) : 0;
        return (
          <div
            key={ep.Id}
            className="group relative rounded-xl overflow-hidden bg-card border border-border hover:border-primary/30 transition-colors text-left"
          >
            <button
              type="button"
              className="relative block w-full aspect-[16/10] focus-ring"
              onClick={() => msId && onPlay(ep)}
              aria-label={`播放第 ${ep.IndexNumber ?? ''} 集 ${ep.Name ?? ''}`}
            >
              {epPosterUrl ? (
                <img
                  src={epPosterUrl}
                  alt=""
                  className="absolute inset-0 w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity"
                />
              ) : (
                <div className="absolute inset-0 flex items-center justify-center bg-muted">
                  <span className="text-3xl font-bold text-muted-foreground/20 select-none">{ep.IndexNumber}</span>
                </div>
              )}
              <div className="absolute inset-0 bg-gradient-to-t from-background via-background/50 to-transparent" />
              {/* 进度条：已看完显示看完标记，未看完显示比例 */}
              {pct > 0 && (
                <div className="absolute bottom-0 left-0 right-0 h-1 bg-muted">
                  <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
                </div>
              )}
              {finished && (
                <span className="absolute top-1.5 right-1.5 text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/90 text-white">
                  已看完
                </span>
              )}
              <div className="absolute bottom-0 left-0 right-0 p-2">
                <div className="text-xs font-medium line-clamp-2 leading-snug">
                  {ep.IndexNumber !== undefined ? `${ep.IndexNumber}. ` : ''}
                  {ep.Name}
                </div>
                {ep.RunTimeTicks && (
                  <div className="text-[10px] text-muted-foreground mt-0.5">{formatRuntimeTicks(ep.RunTimeTicks)}</div>
                )}
              </div>
              <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-black/20">
                <div className="p-2 bg-primary text-primary-foreground rounded-full">
                  <Play size={14} fill="currentColor" />
                </div>
              </div>
            </button>
            {/* 从头播放：不从进度续播，也不清除历史（§12.1） */}
            {(pct > 0 || finished) && (
              <button
                type="button"
                onClick={() => msId && onPlayFromStart(ep)}
                className="w-full flex items-center justify-center gap-1 py-1.5 text-[11px] text-muted-foreground hover:text-foreground border-t border-border hover:bg-accent transition-colors focus-ring"
                aria-label={`从头播放第 ${ep.IndexNumber ?? ''} 集`}
              >
                <RotateCcw size={11} />
                从头播放
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
