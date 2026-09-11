import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Play, RotateCcw } from 'lucide-react';
import type { ResumeTarget } from '../../../shared/types/playback';

/**
 * Series primary resume button (QYP2-034, plan §12.2).
 *
 * 文案规则（§12.2：按钮文案必须明确）：
 * - resume →「继续播放 S01E05 · 23:18」
 * - next-episode →「播放下一集 S01E06」
 * - start →「播放第一集 S01E01」
 * - replay →「重新播放」，先确认再从第一集开始（两段式按钮）
 *
 * 算法在 main 侧（renderer 不得复制）；本组件只负责取目标 + 文案。
 */

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function formatEpisodeCode(target: ResumeTarget): string {
  if (target.seasonNumber == null && target.episodeNumber == null) return '';
  return `S${pad(target.seasonNumber ?? 0)}E${pad(target.episodeNumber ?? 0)}`;
}

function formatTime(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

function buttonLabel(target: ResumeTarget): string {
  const code = formatEpisodeCode(target);
  const codePart = code ? `${code} · ` : '';
  switch (target.reason) {
    case 'resume':
      return `继续播放 ${codePart}${formatTime(target.position)}`;
    case 'next-episode':
      return `播放下一集 ${code}`.replace(/\s+$/, '');
    case 'start':
      return `播放第一集 ${code}`.replace(/\s+$/, '');
    case 'replay':
      return '重新播放';
  }
}

export default function SeriesResumeButton({
  resolve,
  onPlay,
}: {
  /** 取最新目标（main 侧 resolver）；focus/播放结束后会被再次调用。 */
  resolve: () => Promise<ResumeTarget | null>;
  onPlay: (target: ResumeTarget) => void;
}) {
  const [target, setTarget] = useState<ResumeTarget | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirmingReplay, setConfirmingReplay] = useState(false);
  const aliveRef = useRef(true);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const next = await resolve();
      if (aliveRef.current) {
        setTarget(next);
        setConfirmingReplay(false);
      }
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, [resolve]);

  useEffect(() => {
    aliveRef.current = true;
    void refresh();
    // §12.2/验收: focus 后静默刷新（播放窗口关闭/eof 回到本页时命中）。
    const onFocus = (): void => {
      void refresh();
    };
    window.addEventListener('focus', onFocus);
    return () => {
      aliveRef.current = false;
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh]);

  if (loading && !target) {
    return (
      <button
        type="button"
        disabled
        className="mt-6 w-full sm:w-auto sm:min-w-64 flex items-center justify-center gap-2 px-6 py-2.5 bg-primary/60 text-primary-foreground rounded-lg text-sm font-medium"
      >
        <Loader2 size={14} className="animate-spin" />
        解析进度…
      </button>
    );
  }

  if (!target) {
    return null; // 无可播内容：交给集列表区呈现
  }

  const handle = (): void => {
    if (target.reason === 'replay' && !confirmingReplay) {
      setConfirmingReplay(true);
      return;
    }
    onPlay(target);
  };

  return (
    <div className="mt-6 flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={handle}
        className={`flex items-center justify-center gap-2 px-6 py-2.5 rounded-lg transition-colors focus-ring text-sm font-medium ${
          confirmingReplay
            ? 'bg-amber-600 hover:bg-amber-500 text-white'
            : 'bg-primary hover:bg-primary/90 text-primary-foreground'
        }`}
      >
        {confirmingReplay ? <RotateCcw size={14} /> : <Play size={14} fill="currentColor" />}
        {confirmingReplay ? '确认重新播放（从第一集开始）' : buttonLabel(target)}
      </button>
      {confirmingReplay && (
        <button
          type="button"
          onClick={() => setConfirmingReplay(false)}
          className="px-3 py-2.5 border border-border rounded-lg text-xs text-muted-foreground hover:text-foreground hover:bg-accent focus-ring"
        >
          取消
        </button>
      )}
    </div>
  );
}
