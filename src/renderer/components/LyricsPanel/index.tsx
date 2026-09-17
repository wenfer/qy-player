import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Upload, X } from 'lucide-react';
import {
  findCurrentLine,
  parseLrc,
} from '../../../main/modules/playback-engine/lrc-parser';
import { useToastStore } from '../../stores/toast-store';
import type { MusicSourceRef } from '../../stores/music-playback-store';

/**
 * 歌词面板（QYP3-021）：当前曲目的歌词，随播放位置同步高亮，
 * 点击行跳转；无词时可手动导入 .lrc（落盘到受保护的 lyrics 分区）。
 * 高亮行号由 lrc-parser 的纯函数决定，UI 不复制算法。
 *
 * QYP3-020b：歌词按来源路由——本地音轨读 lyrics 缓存分区；服务器曲目
 * 走 Jellyfin `/Audio/{id}/Lyrics`（Emby 无端点 → 无词）。导入只对
 * 本地音轨开放（服务器歌词是只读的，缓存按 trackId 落盘）。
 */
interface LyricsPanelProps {
  source: MusicSourceRef;
  title: string;
  position: number;
  onSeek: (time: number) => void;
  onClose: () => void;
}

export default function LyricsPanel({ source, title, position, onSeek, onClose }: LyricsPanelProps) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const addToast = useToastStore((s) => s.addToast);
  const activeRef = useRef<HTMLButtonElement | null>(null);
  const { trackId, serverId, itemId } = source;
  const isServer = Boolean(serverId && itemId);

  const load = useCallback(async () => {
    setLoading(true);
    const request =
      serverId && itemId
        ? window.electronAPI.getServerLyrics(serverId, itemId)
        : window.electronAPI.getMusicLyrics(trackId);
    const res = (await request) as {
      ok?: boolean;
      data?: { hasLyrics: boolean; content: string | null };
    };
    setContent(res?.data?.content ?? null);
    setLoading(false);
  }, [trackId, serverId, itemId]);

  useEffect(() => {
    void load();
  }, [load]);

  const parsed = useMemo(() => (content ? parseLrc(content) : null), [content]);
  const lines = parsed?.lines ?? [];
  const currentIndex = lines.length > 0 ? findCurrentLine(lines, position) : -1;

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [currentIndex]);

  const importLyrics = async (): Promise<void> => {
    const res = (await window.electronAPI.importMusicLyrics(trackId)) as {
      ok?: boolean;
      data?: { imported: boolean; content: string | null };
      error?: { message: string };
    };
    if (!res?.ok) {
      addToast(res?.error?.message ?? '导入歌词失败', 'error');
      return;
    }
    if (!res.data?.imported) return; // 用户取消
    setContent(res.data.content ?? null);
    addToast('歌词已导入', 'success');
  };

  const hasTimedLines = lines.length > 0;

  return (
    <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-40 w-[min(560px,calc(100vw-2rem))] max-h-[46vh] bg-card/95 backdrop-blur border border-border rounded-xl shadow-lg flex flex-col">
      <div className="flex items-center justify-between px-4 py-2 border-b border-border flex-shrink-0">
        <div className="min-w-0">
          <p className="text-xs font-medium truncate">{title}</p>
          <p className="text-[10px] text-muted-foreground">
            {hasTimedLines ? '点击歌词可跳转到该句' : '暂无可同步的歌词'}
          </p>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {!isServer && (
            <button
              type="button"
              onClick={() => void importLyrics()}
              className="px-2 py-1 rounded-lg text-xs hover:bg-accent text-muted-foreground hover:text-foreground focus-ring flex items-center gap-1"
            >
              <Upload size={12} />
              导入歌词
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭歌词面板"
            className="p-1.5 rounded-lg hover:bg-accent text-muted-foreground hover:text-foreground focus-ring"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3">
        {loading ? (
          <p className="text-xs text-muted-foreground">加载中…</p>
        ) : !content ? (
          <p className="text-xs text-muted-foreground">
            {isServer ? '服务器上没有这首曲目的歌词。' : '这首曲目还没有歌词，可导入 .lrc 文件。'}
          </p>
        ) : !hasTimedLines ? (
          <pre className="text-xs text-muted-foreground whitespace-pre-wrap break-words font-sans">
            {content}
          </pre>
        ) : (
          <div className="space-y-2">
            {lines.map((line, index) => (
              <button
                key={`${line.time}-${index}`}
                type="button"
                ref={index === currentIndex ? activeRef : null}
                onClick={() => onSeek(line.time)}
                className={`block w-full text-left rounded-lg px-2 py-1 transition-colors focus-ring break-words ${
                  index === currentIndex
                    ? 'text-foreground font-medium bg-accent'
                    : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
                }`}
              >
                {line.text || '·'}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
