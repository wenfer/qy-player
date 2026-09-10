import { useState, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { FolderOpen, FileVideo, Play, Clock, Film, Trash2, Library, ArrowRight, Loader2, AlertCircle, RefreshCw } from 'lucide-react';
import { useToastStore } from '../../stores/toast-store';
import type { SourceListEntry, ScanProgressEvent } from '../../../shared/types';

interface HistoryItem {
  media_id: string;
  media_type: string;
  title: string;
  poster_url?: string;
  path?: string;
  position: number;
  duration?: number;
  watched_at: number;
}

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export default function Local() {
  const [recentFiles, setRecentFiles] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const addToast = useToastStore((s) => s.addToast);
  const navigate = useNavigate();
  const [sources, setSources] = useState<SourceListEntry[]>([]);
  const [sourcesLoading, setSourcesLoading] = useState(true);
  const [sourcesError, setSourcesError] = useState<string | null>(null);
  const [scanningIds, setScanningIds] = useState<Set<number>>(new Set());

  const loadSources = useCallback(async () => {
    setSourcesLoading(true);
    setSourcesError(null);
    try {
      const result = (await window.electronAPI.listSources()) as Array<SourceListEntry>;
      setSources(result);
    } catch (err) {
      setSourcesError(err instanceof Error ? err.message : '加载来源失败');
    } finally {
      setSourcesLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSources();
  }, [loadSources]);

  // Keep scan badges live via the push channel (deduped per sender).
  useEffect(() => {
    const unsubscribe = window.electronAPI.onScanProgress((event) => {
      const e = event as ScanProgressEvent;
      if (e.state === 'indexing' || e.state === 'discovering' || e.state === 'enriching' || e.state === 'queued') {
        setScanningIds((prev) => new Set(prev).add(e.sourceId));
      } else {
        setScanningIds((prev) => {
          const next = new Set(prev);
          next.delete(e.sourceId);
          return next;
        });
        loadSources();
      }
    });
    return unsubscribe;
  }, [loadSources]);

  const handleScanToggle = useCallback(
    async (source: SourceListEntry) => {
      const running = scanningIds.has(source.id);
      try {
        const result = running
          ? await window.electronAPI.cancelScan(source.id)
          : await window.electronAPI.startScan(source.id);
        const r = result as { ok: boolean; error?: { message: string } };
        if (!r.ok) {
          addToast(r.error?.message ?? '操作失败', 'error');
          return;
        }
        if (running) {
          addToast('扫描已请求停止', 'info');
        } else {
          setScanningIds((prev) => new Set(prev).add(source.id));
          addToast('扫描已开始', 'success');
        }
      } catch (err) {
        addToast(`扫描操作失败: ${err instanceof Error ? err.message : '未知错误'}`, 'error');
      }
    },
    [scanningIds, addToast]
  );

  const loadHistory = useCallback(async () => {
    try {
      const history = await window.electronAPI.getRecentlyPlayed(20);
      setRecentFiles(history as HistoryItem[]);
    } catch {
      // Ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadHistory();

    // Refresh when window regains focus (user returns from MPV)
    const onFocus = () => loadHistory();
    window.addEventListener('focus', onFocus);

    // Refresh when playback ends
    let unsubscribe: (() => void) | undefined;
    if (window.electronAPI) {
      unsubscribe = window.electronAPI.onPlayerStateChange((state: unknown) => {
        const s = state as Record<string, unknown>;
        if (s.eof === true) {
          loadHistory();
        }
      });
    }

    return () => {
      window.removeEventListener('focus', onFocus);
      unsubscribe?.();
    };
  }, [loadHistory]);

  // Reset confirm state after timeout
  useEffect(() => {
    if (!confirmingClear) return;
    const timer = setTimeout(() => setConfirmingClear(false), 4000);
    return () => clearTimeout(timer);
  }, [confirmingClear]);

  const handleOpenFile = async () => {
    try {
      const path = await window.electronAPI.openFile();
      if (path) {
        await window.electronAPI.playerLoadFile(path);
        addToast('开始播放', 'success');
      }
    } catch (err) {
      addToast(`打开文件失败: ${err instanceof Error ? err.message : '未知错误'}`, 'error');
    }
  };

  const handleOpenFolder = async () => {
    try {
      const files = await window.electronAPI.openFolder();
      if (files.length > 0) {
        await window.electronAPI.playerLoadFile(files[0]);
        addToast(`开始播放 (${files.length} 个文件)`, 'success');
      }
    } catch (err) {
      addToast(`打开文件夹失败: ${err instanceof Error ? err.message : '未知错误'}`, 'error');
    }
  };

  const handlePlayHistory = async (item: HistoryItem) => {
    // For local media, media_id is the file path (fallback for older records)
    const filePath = item.path || (item.media_type === 'local' ? item.media_id : null);
    if (!filePath) {
      addToast('记录缺少文件路径，无法播放', 'warning');
      return;
    }
    try {
      const progress = await window.electronAPI.getProgress('local', filePath);
      const startPosition = progress?.position || 0;
      await window.electronAPI.playerLoadFile(filePath, startPosition > 30 ? startPosition : 0);
      addToast('开始播放', 'success');
    } catch (err) {
      addToast(`播放失败: ${err instanceof Error ? err.message : '未知错误'}`, 'error');
    }
  };

  const handleDeleteItem = async (item: HistoryItem) => {
    try {
      await window.electronAPI.deleteHistoryItem(item.media_type, item.media_id);
      setRecentFiles((prev) =>
        prev.filter((h) => !(h.media_type === item.media_type && h.media_id === item.media_id))
      );
      addToast('已删除该记录', 'success');
    } catch (err) {
      addToast(`删除失败: ${err instanceof Error ? err.message : '未知错误'}`, 'error');
    }
  };

  const handleClearAll = async () => {
    try {
      await window.electronAPI.clearHistory();
      setRecentFiles([]);
      setConfirmingClear(false);
      addToast('已清空所有播放记录', 'success');
    } catch (err) {
      addToast(`清空失败: ${err instanceof Error ? err.message : '未知错误'}`, 'error');
    }
  };

  return (
    <div className="p-8 max-w-4xl">
      <h1 className="text-2xl font-bold tracking-tight mb-8">本地播放</h1>

      {/* Actions */}
      <div className="flex gap-3 mb-10">
        <button
          onClick={handleOpenFile}
          className="flex items-center gap-2 px-5 py-2.5 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors focus-ring text-sm font-medium"
        >
          <FileVideo size={16} />
          打开文件
        </button>
        <button
          onClick={handleOpenFolder}
          className="flex items-center gap-2 px-5 py-2.5 bg-card border border-border rounded-lg hover:border-primary/30 transition-colors focus-ring text-sm font-medium"
        >
          <FolderOpen size={16} />
          打开文件夹
        </button>
      </div>

      {/* Catalog sources */}
      <section className="mb-12">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
            <Library size={14} />
            媒体库
          </h2>
        </div>
        {sourcesLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground p-4" role="status">
            <Loader2 size={14} className="animate-spin" /> 加载来源中…
          </div>
        ) : sourcesError ? (
          <div className="flex flex-col items-start gap-2 p-4 bg-card border border-border rounded-xl" role="alert">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <AlertCircle size={14} /> {sourcesError}
            </div>
            <button onClick={loadSources} className="px-3 py-1.5 text-xs border border-border rounded-lg hover:bg-accent focus-ring">
              重试
            </button>
          </div>
        ) : sources.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 bg-card border border-dashed border-border rounded-xl">
            <Library size={28} className="text-muted-foreground/40 mb-2" />
            <p className="text-sm text-muted-foreground">还没有媒体库来源</p>
            <p className="text-xs text-muted-foreground mt-1 mb-3">在设置中添加本地目录并扫描后，即可在这里浏览</p>
            <button
              onClick={() => navigate('/settings')}
              className="px-4 py-2 text-xs bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 focus-ring"
            >
              前往设置
            </button>
          </div>
        ) : (
          <div className="flex flex-wrap gap-3">
            {sources.map((source) => {
              const scanning = scanningIds.has(source.id) || (source.lastRun && ['queued', 'discovering', 'indexing', 'enriching'].includes(source.lastRun.status));
              return (
                <div
                  key={source.id}
                  className="flex items-center gap-3 p-3 bg-card border border-border rounded-xl hover:border-primary/30 transition-colors min-w-0 flex-1 basis-64"
                >
                  <button
                    onClick={() => navigate(`/browse/${source.id}`, { state: { name: source.name } })}
                    className="flex items-center gap-3 flex-1 min-w-0 text-left focus-ring rounded-lg"
                    aria-label={`浏览 ${source.name}`}
                  >
                    <div className="w-9 h-9 rounded-lg bg-muted flex items-center justify-center flex-shrink-0">
                      <Library size={16} className="text-muted-foreground" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">{source.name}</div>
                      <div className="text-[11px] text-muted-foreground truncate">
                        {scanning
                          ? '扫描中…'
                          : source.lastRun
                            ? source.lastRun.status === 'completed'
                              ? `已扫描 ${source.lastRun.processed ?? 0} 项`
                              : source.lastRun.status === 'failed'
                                ? '上次扫描失败'
                                : '尚未扫描'
                            : '尚未扫描'}
                      </div>
                    </div>
                    <ArrowRight size={14} className="text-muted-foreground flex-shrink-0" />
                  </button>
                  <button
                    onClick={() => handleScanToggle(source)}
                    disabled={source.kind !== 'local'}
                    className="p-2 text-muted-foreground hover:text-foreground hover:bg-accent rounded-lg transition-colors focus-ring flex-shrink-0 disabled:opacity-40"
                    aria-label={scanning ? `取消扫描 ${source.name}` : `扫描 ${source.name}`}
                    title={scanning ? '取消扫描' : '扫描'}
                  >
                    {scanning ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* History */}
      <section>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
            <Clock size={14} />
            最近播放
          </h2>

          {recentFiles.length > 0 && (
            confirmingClear ? (
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">清除全部记录和进度？</span>
                <button
                  onClick={handleClearAll}
                  className="px-2.5 py-1 text-xs font-medium text-white bg-destructive rounded-md hover:bg-destructive/90 transition-colors focus-ring"
                >
                  确认清空
                </button>
                <button
                  onClick={() => setConfirmingClear(false)}
                  className="px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground transition-colors focus-ring rounded-md"
                >
                  取消
                </button>
              </div>
            ) : (
              <button
                onClick={() => setConfirmingClear(true)}
                className="flex items-center gap-1.5 px-2.5 py-1 text-xs text-muted-foreground hover:text-destructive transition-colors focus-ring rounded-md"
                aria-label="清空所有播放记录"
              >
                <Trash2 size={12} />
                清空记录
              </button>
            )
          )}
        </div>

        {loading ? (
          <div className="space-y-2" aria-busy="true">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-center gap-4 p-3 bg-card border border-border rounded-xl">
                <div className="w-10 h-10 rounded-lg bg-muted animate-pulse flex-shrink-0" />
                <div className="flex-1 space-y-1.5">
                  <div className="h-4 bg-muted rounded animate-pulse w-2/3" />
                  <div className="h-3 bg-muted rounded animate-pulse w-1/3" />
                </div>
              </div>
            ))}
          </div>
        ) : recentFiles.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16" role="status">
            <Film size={40} className="text-muted-foreground mb-3" />
            <p className="text-muted-foreground">暂无播放记录</p>
            <p className="text-xs text-muted-foreground mt-1">播放过的视频将显示在这里</p>
          </div>
        ) : (
          <div className="space-y-1.5">
            {recentFiles.map((item) => (
              <div
                key={`${item.media_type}-${item.media_id}`}
                className="flex items-center gap-4 p-3 bg-card border border-border rounded-xl hover:border-primary/30 transition-colors group"
              >
                <button
                  className="flex items-center gap-4 flex-1 min-w-0 text-left focus-ring rounded-lg"
                  onClick={() => handlePlayHistory(item)}
                  aria-label={`播放 ${item.title}`}
                >
                  <div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center flex-shrink-0">
                    {item.poster_url ? (
                      <img src={item.poster_url} alt="" className="w-full h-full object-cover rounded-lg" />
                    ) : (
                      <FileVideo size={16} className="text-muted-foreground" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{item.title}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {item.path && <span className="truncate block">{item.path}</span>}
                      {item.duration && (
                        <span>进度 {formatTime(item.position)} / {formatTime(item.duration)}</span>
                      )}
                    </div>
                  </div>
                  <div className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
                    <div className="p-2 rounded-full bg-primary text-primary-foreground">
                      <Play size={14} fill="currentColor" />
                    </div>
                  </div>
                </button>
                <button
                  onClick={() => handleDeleteItem(item)}
                  className="p-2 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-lg transition-all opacity-0 group-hover:opacity-100 focus-visible:opacity-100 focus-ring flex-shrink-0"
                  aria-label={`删除 ${item.title} 的播放记录`}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
