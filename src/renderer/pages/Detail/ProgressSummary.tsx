import { useEffect, useState } from 'react';
import { History } from 'lucide-react';

/**
 * Last-position summary (QYP2-019, plan §15). Informational only — the
 * actual resume happens through the resolver's startPosition. Key rule:
 * finished content must NOT advertise a misleading "continue watching".
 */

export interface ProgressSummaryProps {
  mediaType: string;
  mediaId: string;
  /** Total duration in seconds when known (for the percentage). */
  durationHint?: number;
}

interface ProgressPayload {
  position: number;
  duration?: number;
  is_finished: number;
}

function formatClock(seconds: number): string {
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}小时${m}分钟`;
  if (m > 0) return `${m}分${s > 0 ? `${s}秒` : ''}`;
  return `${s}秒`;
}

export default function ProgressSummary({ mediaType, mediaId, durationHint }: ProgressSummaryProps) {
  const [progress, setProgress] = useState<ProgressPayload | null>(null);

  useEffect(() => {
    let cancelled = false;
    setProgress(null);
    if (!mediaType || !mediaId) return undefined;
    window.electronAPI
      .getProgress(mediaType, mediaId)
      .then((data) => {
        if (!cancelled) setProgress((data as ProgressPayload | undefined) ?? null);
      })
      .catch(() => {
        // Progress is informational; a read failure stays silent.
        if (!cancelled) setProgress(null);
      });
    return () => {
      cancelled = true;
    };
  }, [mediaType, mediaId]);

  if (!progress || progress.position <= 5) return null;

  const duration = progress.duration ?? durationHint;
  const percent = duration && duration > 0 ? Math.min(100, Math.round((progress.position / duration) * 100)) : null;
  // Same >90% rule the resume calculation uses: a legacy row with
  // is_finished=0 but >90% position would otherwise show a misleading
  // auto-resume hint while playback actually restarts.
  const finished = progress.is_finished === 1 || (duration !== undefined && duration > 0 && progress.position / duration > 0.9);

  return (
    <div className="mt-6 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm" role="status">
      <History size={14} className="text-muted-foreground" aria-hidden />
      {finished ? (
        // Never present finished content as "continue at minute X".
        <span className="text-muted-foreground">已看过（上次看完）</span>
      ) : (
        <span className="text-muted-foreground">
          上次看到 {formatClock(progress.position)}
          {percent !== null && <>（约 {percent}%）</>}
          ，播放时将自动续播
        </span>
      )}
    </div>
  );
}
