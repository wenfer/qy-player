import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Play, X } from 'lucide-react';
import { useAutoNextStore } from '../stores/auto-next-store';

/**
 * Auto-next countdown overlay (QYP2-035, plan §12.3).
 *
 * 交互流：
 * - main 推送 countdown（EOF 后，最终进度已保存）→ 本组件询问注册的
 *   provider 是否存在下一集；没有 → 立即取消（最后一集不显示无效倒计时）；
 * - 显示 5s 倒计时 + 取消按钮；
 * - 倒计时归零（main 推送 fire）→ 播放下一集（走既有 resolvePlayback +
 *   loadFile，顺序由 main 保证：保存 → 切 media → load）；
 * - 用户取消 / provider 失效（离开剧集页）/ 收到新事件 → 复位。
 *
 * 竞态防护：provider 解析是异步的——resolve 期间到达的 fire/cancelled
 * 会推进事件代数，迟到的 resolve 结果直接丢弃（overlay 不会复活）。
 */

interface AutoNextEvent {
  type: 'countdown' | 'fire' | 'cancelled' | 'ignored';
  seconds?: number;
  reason?: string;
  media?: {
    mediaType: string;
    mediaId: string;
    seasonNumber?: number | null;
    episodeNumber?: number | null;
  };
}

export default function NextEpisodeCountdown({ onPlayNext }: { onPlayNext: (choice: { itemId: number | string; mediaSourceId?: string | null; position?: number }) => void }) {
  const provider = useAutoNextStore((s) => s.provider);
  const [visible, setVisible] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(5);
  const [totalSeconds, setTotalSeconds] = useState(5);
  const [busy, setBusy] = useState(false);
  const nextRef = useRef<Parameters<typeof onPlayNext>[0] | null>(null);
  /** 事件代数：每次新事件 +1；跨 await 的迟到结果按代数丢弃。 */
  const epochRef = useRef(0);

  const reset = useCallback((): void => {
    setVisible(false);
    nextRef.current = null;
    setBusy(false);
  }, []);

  const handleEvent = useCallback(
    async (event: AutoNextEvent): Promise<void> => {
      const epoch = ++epochRef.current;
      if (event.type === 'countdown') {
        if (!provider || !event.media) return;
        const next = await provider({
          mediaType: event.media?.mediaType ?? '',
          mediaId: event.media?.mediaId ?? '',
          seasonNumber: event.media?.seasonNumber ?? null,
          episodeNumber: event.media?.episodeNumber ?? null,
        });
        // 迟到结果：provider 等待期间来了新事件（fire/取消/换集）→ 丢弃。
        if (epoch !== epochRef.current) return;
        if (!next) {
          void window.electronAPI.autoNextCancel('no-next-episode');
          return;
        }
        nextRef.current = { itemId: next.itemId, mediaSourceId: next.mediaSourceId ?? undefined, position: 0 };
        setSecondsLeft(event.seconds ?? 5);
        setTotalSeconds(event.seconds ?? 5);
        setBusy(false);
        setVisible(true);
        return;
      }
      if (event.type === 'fire') {
        const next = nextRef.current;
        setVisible(false);
        nextRef.current = null;
        if (!next) return;
        setBusy(true);
        try {
          onPlayNext(next);
        } finally {
          setBusy(false);
        }
        return;
      }
      if (event.type === 'cancelled') {
        reset();
      }
    },
    [provider, onPlayNext, reset]
  );

  // Local 1s ticker for the visual countdown (main owns the real timer).
  useEffect(() => {
    if (!visible) return;
    const timer = setInterval(() => setSecondsLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(timer);
  }, [visible]);

  // provider 失效（离开剧集页）：倒计时还挂着就立即取消——main 侧
  // 计时器与 overlay 一起消失（评审 REQUIRED：不能 fire 到已卸载的页面）。
  useEffect(() => {
    if (provider === null && visible) {
      void window.electronAPI.autoNextCancel('user');
      reset();
    }
  }, [provider, visible, reset]);

  useEffect(() => {
    const unsubscribe = window.electronAPI.onAutoNextEvent((payload) => {
      void handleEvent(payload as AutoNextEvent);
    });
    return () => {
      unsubscribe();
    };
  }, [handleEvent]);

  if (!visible) return null;

  const cancel = (): void => {
    void window.electronAPI.autoNextCancel('user');
    reset();
  };

  return (
    <div
      className="fixed bottom-6 right-6 z-50 bg-card border border-border rounded-xl shadow-lg p-4 w-72"
      role="alertdialog"
      aria-label="自动播放下一集"
    >
      <div className="flex items-center gap-2 mb-2">
        {busy ? <Loader2 size={15} className="animate-spin text-primary" /> : <Play size={15} className="text-primary" fill="currentColor" />}
        <span className="text-sm font-medium">
          {busy ? '正在切换下一集…' : `${secondsLeft} 秒后播放下一集`}
        </span>
        <button
          type="button"
          onClick={cancel}
          disabled={busy}
          className="ml-auto p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground focus-ring disabled:opacity-50"
          aria-label="取消自动播放"
        >
          <X size={15} />
        </button>
      </div>
      <div className="h-1 w-full bg-muted rounded-full overflow-hidden" role="progressbar" aria-valuenow={secondsLeft} aria-valuemax={totalSeconds}>
        <div
          className="h-full bg-primary transition-all duration-1000 ease-linear"
          style={{ width: `${totalSeconds > 0 ? (secondsLeft / totalSeconds) * 100 : 0}%` }}
        />
      </div>
      <button
        type="button"
        onClick={cancel}
        disabled={busy}
        className="mt-3 w-full py-1.5 text-xs border border-border rounded-lg hover:bg-accent text-muted-foreground hover:text-foreground focus-ring disabled:opacity-50"
      >
        取消自动播放
      </button>
      <p className="text-[10px] text-muted-foreground mt-2">仅在完整播完一集后触发；可在设置中关闭。</p>
    </div>
  );
}
