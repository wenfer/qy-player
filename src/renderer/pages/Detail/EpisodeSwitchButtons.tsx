import { useCallback, useState } from 'react';
import { SkipBack, SkipForward } from 'lucide-react';
import { playAdjacentEpisode } from '../../utils/play-episode';

/**
 * 手动切集（QYP3-068q）：剧集详情页左栏，紧挨「继续播放 SxxExx」。
 *
 * 为什么放这里而不是播放条：影视播放走的是**独立的 mpv 窗口**，主窗口里的
 * `PlayerControls` 目前从不显示（`player-store` 的 `isVisible` 无人置位），
 * 把按钮塞进去等于没有。剧集页是"看这部剧"时必然停留的地方（自动连播的
 * provider 也只在剧集页注册），按钮放这儿才点得到。
 *
 * 「上一集/下一集是哪一集」由 Detail 注册的 provider 回答（整部戏的剧集列表
 * + 主进程的纯选择器）；当前在播哪一集由主进程的媒体快照回答。
 */

const BTN =
  'flex items-center justify-center gap-1.5 px-3 py-2 text-xs rounded-lg border border-border hover:bg-accent text-muted-foreground hover:text-foreground transition-colors focus-ring disabled:opacity-40 disabled:pointer-events-none';

export default function EpisodeSwitchButtons() {
  const [busy, setBusy] = useState(false);

  const switchTo = useCallback(
    async (direction: 'next' | 'prev'): Promise<void> => {
      if (busy) return;
      setBusy(true);
      try {
        await playAdjacentEpisode(direction);
      } finally {
        setBusy(false);
      }
    },
    [busy]
  );

  return (
    <div className="grid grid-cols-2 gap-2 mt-2">
      <button
        type="button"
        onClick={() => void switchTo('prev')}
        disabled={busy}
        className={BTN}
        aria-label="上一集"
        title="上一集（Ctrl+Shift+←）"
      >
        <SkipBack size={14} /> 上一集
      </button>
      <button
        type="button"
        onClick={() => void switchTo('next')}
        disabled={busy}
        className={BTN}
        aria-label="下一集"
        title="下一集（Ctrl+Shift+→）"
      >
        下一集 <SkipForward size={14} />
      </button>
    </div>
  );
}
