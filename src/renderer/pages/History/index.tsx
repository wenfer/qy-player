import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { History, Trash2, Play, Clock, Film, X } from 'lucide-react';
import { useToastStore } from '../../stores/toast-store';
import { getServerMap, buildImageUrl, findServerByType } from '../../utils/server-images';

interface HistoryRecord {
  media_type: string;
  media_id: string;
  title: string;
  poster_url?: string;
  path?: string;
  position: number;
  duration?: number;
  watched_at: number;
  series_name?: string;
  season_number?: number;
  episode_number?: number;
  /** Computed at load time from the owning server - not stored in the DB. */
  imageUrl?: string;
}

function formatDuration(seconds: number): string {
  if (!seconds || seconds <= 0) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatWatchedAt(timestamp: number): string {
  const now = Date.now() / 1000;
  const diff = now - timestamp;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 172800) return '昨天';
  const date = new Date(timestamp * 1000);
  return `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')}`;
}

function getProgressPercent(position: number, duration?: number): number {
  if (!duration || duration <= 0) return 0;
  const pct = (position / duration) * 100;
  return Math.min(Math.max(pct, 0), 100);
}

export default function HistoryPage() {
  const navigate = useNavigate();
  const addToast = useToastStore((s) => s.addToast);
  const [records, setRecords] = useState<HistoryRecord[]>([]);
  const [loading, setLoading] = useState(true);

  const loadHistory = useCallback(async () => {
    setLoading(true);
    try {
      const [data, serverMap] = await Promise.all([
        window.electronAPI.getRecentlyPlayed(100),
        getServerMap(),
      ]);
      const servers = [...serverMap.values()];
      // Online items: resolve the image from the owning server on the fly
      // (no tag needed - the server returns its current primary image).
      const mapped = (data as HistoryRecord[]).map((r) => {
        if (r.media_type === 'local') return { ...r, imageUrl: undefined };
        const server = findServerByType(servers, r.media_type);
        return {
          ...r,
          imageUrl: server
            ? buildImageUrl(serverMap, server.id, r.media_type, r.media_id, 'Primary', undefined, 200)
            : undefined,
        };
      });
      setRecords(mapped);
    } catch (err) {
      addToast(`加载历史记录失败: ${err instanceof Error ? err.message : '未知错误'}`, 'error');
    } finally {
      setLoading(false);
    }
  }, [addToast]);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  const handleClearAll = useCallback(async () => {
    if (!window.confirm('确定要清空所有观看历史吗？此操作不可恢复。')) return;
    try {
      await window.electronAPI.clearHistory();
      setRecords([]);
      addToast('已清空观看历史', 'success');
    } catch (err) {
      addToast(`清空失败: ${err instanceof Error ? err.message : '未知错误'}`, 'error');
    }
  }, [addToast]);

  const handleDelete = useCallback(async (record: HistoryRecord) => {
    try {
      await window.electronAPI.deleteHistoryItem(record.media_type, record.media_id);
      setRecords((prev) => prev.filter((r) => !(r.media_type === record.media_type && r.media_id === record.media_id)));
      addToast('已删除记录', 'success');
    } catch (err) {
      addToast(`删除失败: ${err instanceof Error ? err.message : '未知错误'}`, 'error');
    }
  }, [addToast]);

  // Online history records carry no serverId (phase-1 schema): resolve the
  // single matching active server; when several exist the record is
  // ambiguous and we refuse to guess (QYP2-015 exact routing).
  const resolveHistoryServer = useCallback(async (mediaType: string): Promise<number | null> => {
    const serverMap = await getServerMap();
    const matches = Array.from(serverMap.values()).filter((s) => s.is_active && s.type === mediaType);
    return matches.length === 1 ? matches[0].id : null;
  }, []);

  const handlePlay = useCallback(async (record: HistoryRecord) => {
    if (record.media_type === 'local' && record.path) {
      try {
        // Same completion rule as the catalog path (plan §12.1): nearly
        // finished records restart; small offsets are treated as noise.
        const finished = record.duration ? record.position / record.duration > 0.9 : false;
        const start = !finished && record.position > 5 ? Math.floor(record.position) : undefined;
        await window.electronAPI.playerLoadFile(record.path, start);
        addToast(`开始播放: ${record.title}`, 'success');
      } catch (err) {
        addToast(`播放失败: ${err instanceof Error ? err.message : '未知错误'}`, 'error');
      }
      return;
    }

    // Online media: redirect to detail page
    const serverType = record.media_type === 'emby' ? 'emby' : 'jellyfin';
    const serverId = await resolveHistoryServer(serverType);
    if (serverId === null) {
      addToast('无法确定该记录的服务器，请从媒体库进入播放', 'warning');
      return;
    }
    navigate(`/detail/${serverType}/${serverId}/${record.media_id}`);
  }, [navigate, addToast, resolveHistoryServer]);

  const handleClickTitle = useCallback(async (record: HistoryRecord) => {
    if (record.media_type === 'local' && record.path) {
      // Local files don't have a detail page; play directly
      handlePlay(record);
      return;
    }
    const serverType = record.media_type === 'emby' ? 'emby' : 'jellyfin';
    const serverId = await resolveHistoryServer(serverType);
    if (serverId === null) {
      addToast('无法确定该记录的服务器，请从媒体库进入播放', 'warning');
      return;
    }
    navigate(`/detail/${serverType}/${serverId}/${record.media_id}`);
  }, [navigate, handlePlay, addToast, resolveHistoryServer]);

  return (
    <div className="p-8 max-w-4xl">
      <header className="mb-8 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <History size={22} className="text-muted-foreground" />
          <div>
            <h1 className="text-2xl font-bold tracking-tight">观看历史</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              {records.length > 0 ? `共 ${records.length} 条记录` : '暂无记录'}
            </p>
          </div>
        </div>
        {records.length > 0 && (
          <button
            onClick={handleClearAll}
            className="flex items-center gap-1.5 px-3 py-2 text-sm text-destructive border border-destructive/30 rounded-lg hover:bg-destructive/10 transition-colors focus-ring"
          >
            <Trash2 size={14} />
            清空历史
          </button>
        )}
      </header>

      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4 p-3 rounded-xl bg-card border border-border animate-pulse">
              <div className="w-16 h-10 rounded bg-muted flex-shrink-0" />
              <div className="flex-1 space-y-2">
                <div className="h-4 bg-muted rounded w-1/3" />
                <div className="h-3 bg-muted rounded w-1/4" />
              </div>
            </div>
          ))}
        </div>
      ) : records.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20">
          <Film size={48} className="text-muted-foreground mb-4" />
          <h2 className="text-lg font-semibold mb-1">暂无观看记录</h2>
          <p className="text-sm text-muted-foreground">观看过的影片会出现在这里</p>
        </div>
      ) : (
        <div className="space-y-2">
          {records.map((record) => {
            const progress = getProgressPercent(record.position, record.duration);
            const isLocal = record.media_type === 'local';
            const serverLabel = isLocal ? '本地' : record.media_type === 'emby' ? 'Emby' : 'Jellyfin';

            return (
              <div
                key={`${record.media_type}-${record.media_id}`}
                className="group flex items-center gap-4 p-3 bg-card border border-border rounded-xl hover:border-primary/30 transition-colors"
              >
                {/* Thumbnail */}
                <button
                  onClick={() => handleClickTitle(record)}
                  className="relative w-20 h-12 rounded-lg overflow-hidden bg-muted flex-shrink-0 focus-ring"
                >
                  {record.imageUrl ? (
                    <img
                      src={record.imageUrl}
                      alt=""
                      className="w-full h-full object-cover"
                      loading="lazy"
                      onError={(e) => {
                        (e.target as HTMLImageElement).style.display = 'none';
                      }}
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-muted-foreground">
                      <Film size={16} />
                    </div>
                  )}
                </button>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <button
                    onClick={() => handleClickTitle(record)}
                    className="text-sm font-medium truncate hover:text-primary transition-colors text-left"
                  >
                    {record.series_name
                      ? `${record.series_name} - ${
                          record.season_number !== undefined && record.season_number > 0
                            ? `S${record.season_number.toString().padStart(2, '0')}E${record.episode_number?.toString().padStart(2, '0') ?? '??'}`
                            : `E${record.episode_number?.toString().padStart(2, '0') ?? '??'}`
                        }${record.title && record.title !== record.series_name ? ` - ${record.title}` : ''}`
                      : record.title}
                  </button>
                  <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                    <span className="px-1.5 py-0.5 bg-muted rounded text-[10px]">{serverLabel}</span>
                    <span className="flex items-center gap-1">
                      <Clock size={10} />
                      {formatWatchedAt(record.watched_at)}
                    </span>
                    {record.duration !== undefined && record.duration > 0 && (
                      <span>
                        进度 {formatDuration(record.position)} / {formatDuration(record.duration)}
                      </span>
                    )}
                  </div>
                  {/* Progress bar */}
                  {progress > 0 && (
                    <div className="mt-2 h-1 bg-muted rounded-full overflow-hidden">
                      <div
                        className="h-full bg-primary rounded-full"
                        style={{ width: `${progress}%` }}
                      />
                    </div>
                  )}
                </div>

                {/* Actions */}
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={() => handlePlay(record)}
                    className="p-2 rounded-lg hover:bg-accent transition-colors focus-ring"
                    title="播放"
                  >
                    <Play size={14} />
                  </button>
                  <button
                    onClick={() => handleDelete(record)}
                    className="p-2 rounded-lg hover:bg-accent text-muted-foreground hover:text-destructive transition-colors focus-ring"
                    title="删除记录"
                  >
                    <X size={14} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
