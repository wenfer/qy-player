import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Play, RefreshCw, Square, Wand2 } from 'lucide-react';
import { useToastStore } from '../../stores/toast-store';

/**
 * Scrape job monitor (QYP2-032, plan §11.2): batch progress, cancel,
 * resume after pause/leave. Jobs persist main-side (app_config), so
 * leaving this page never kills a run — reopening re-attaches by polling.
 */

interface ScrapeItemResult {
  itemId: number;
  status: 'applied' | 'confirm' | 'rejected' | 'failed' | 'skipped';
  message?: string;
  errorCode?: string;
}

interface ScrapeJobRecord {
  id: string;
  status: 'running' | 'completed' | 'cancelled' | 'failed' | 'interrupted';
  createdAt: number;
  updatedAt: number;
  items: ScrapeItemResult[];
  pending: number[];
  pluginId: string;
}

const STATUS_BADGE: Record<ScrapeJobRecord['status'], { label: string; cls: string }> = {
  running: { label: '进行中', cls: 'bg-primary/10 text-primary' },
  completed: { label: '已完成', cls: 'bg-emerald-500/10 text-emerald-500' },
  cancelled: { label: '已取消', cls: 'bg-muted text-muted-foreground' },
  failed: { label: '已暂停/失败', cls: 'bg-amber-500/10 text-amber-500' },
  interrupted: { label: '上次未完成', cls: 'bg-amber-500/10 text-amber-500' },
};

/** Provider display names (no internal ids in the UI). */
const PROVIDER_NAMES: Record<string, string> = {
  tmdb: 'TMDB',
  douban: '豆瓣（实验性）',
};

const ITEM_LABEL: Record<ScrapeItemResult['status'], string> = {
  applied: '已应用',
  confirm: '待人工确认',
  rejected: '置信度不足',
  failed: '失败',
  skipped: '跳过',
};

export default function ScrapeJobs() {
  const addToast = useToastStore((s) => s.addToast);
  const [jobs, setJobs] = useState<ScrapeJobRecord[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busyJob, setBusyJob] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const aliveRef = useRef(true);

  const load = useCallback(async (): Promise<void> => {
    try {
      const res = (await window.electronAPI.scrapeJobs()) as { ok: boolean; data?: ScrapeJobRecord[] };
      if (aliveRef.current && res.ok) setJobs(res.data ?? []);
    } catch {
      /* 轮询失败保留旧列表 */
    } finally {
      if (aliveRef.current) setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
    pollRef.current = setInterval(() => void load(), 2000);
    return () => {
      aliveRef.current = false;
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [load]);

  const cancel = useCallback(
    async (jobId: string): Promise<void> => {
      setBusyJob(jobId);
      try {
        const res = (await window.electronAPI.scrapeCancel(jobId)) as {
          ok: boolean;
          data?: { cancelled: boolean };
          error?: { message: string };
        };
        if (res.ok && res.data?.cancelled) addToast('任务已取消', 'success');
        else if (res.ok) addToast('任务已不在运行（可能刚刚完成）', 'error');
        else addToast(res.error?.message ?? '取消失败', 'error');
        await load();
      } catch (err) {
        addToast(err instanceof Error ? err.message : '取消失败', 'error');
      } finally {
        setBusyJob(null);
      }
    },
    [addToast, load]
  );

  const resume = useCallback(
    async (job: ScrapeJobRecord): Promise<void> => {
      setBusyJob(job.id);
      try {
        const res = (await window.electronAPI.scrapeStart(job.pluginId, job.pending, job.id)) as {
          ok: boolean;
          error?: { message: string };
        };
        if (res.ok) addToast('任务已恢复', 'success');
        else addToast(res.error?.message ?? '恢复失败', 'error');
        await load();
      } catch (err) {
        addToast(err instanceof Error ? err.message : '恢复失败', 'error');
      } finally {
        setBusyJob(null);
      }
    },
    [addToast, load]
  );

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex flex-wrap items-center gap-2 mb-6">
        <Wand2 size={20} className="text-primary" />
        <h1 className="text-lg font-semibold">刮削任务</h1>
        <Loader2 size={14} className="animate-spin text-muted-foreground ml-auto" aria-hidden />
      </div>

      {loaded && jobs.length === 0 && (
        <div className="text-sm text-muted-foreground py-10 text-center border border-border rounded-xl bg-card">
          暂无刮削任务。在媒体库中打开条目详情可单项刮削，列表页可批量刮削。
        </div>
      )}

      <div className="flex flex-col gap-4">
        {jobs.map((job) => {
          const done = job.items.length;
          const total = done + job.pending.length;
          const applied = job.items.filter((entry) => entry.status === 'applied').length;
          const confirms = job.items.filter((entry) => entry.status === 'confirm').length;
          const failures = job.items.filter((entry) => entry.status === 'failed' || entry.status === 'rejected').length;
          const badge = STATUS_BADGE[job.status];
          const resumeable = job.pending.length > 0 && job.status !== 'running';
          return (
            <div key={job.id} className="bg-card border border-border rounded-xl p-4">
              <div className="flex flex-wrap items-center gap-2 mb-2">
                <span className={`text-xs px-2 py-0.5 rounded ${badge.cls}`}>{badge.label}</span>
                <span className="text-xs text-muted-foreground">{PROVIDER_NAMES[job.pluginId] ?? '第三方插件'}</span>
                <span className="text-xs text-muted-foreground">
                  {done}/{total} 项 · 成功 {applied}
                  {confirms > 0 ? ` · 待确认 ${confirms}` : ''}
                  {failures > 0 ? ` · 未应用 ${failures}` : ''}
                </span>
                <span className="ml-auto flex flex-wrap gap-2">
                  {job.status === 'running' && (
                    <button
                      type="button"
                      onClick={() => void cancel(job.id)}
                      disabled={busyJob === job.id}
                      className="flex items-center gap-1 px-2.5 py-1.5 border border-border rounded-lg text-xs hover:bg-accent focus-ring disabled:opacity-50"
                    >
                      <Square size={12} />
                      取消
                    </button>
                  )}
                  {resumeable && (
                    <button
                      type="button"
                      onClick={() => void resume(job)}
                      disabled={busyJob === job.id}
                      className="flex items-center gap-1 px-2.5 py-1.5 bg-primary text-primary-foreground rounded-lg text-xs hover:bg-primary/90 focus-ring disabled:opacity-50"
                    >
                      {busyJob === job.id ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
                      恢复剩余 {job.pending.length} 项
                    </button>
                  )}
                </span>
              </div>
              {/* 进度条：按已完成占比 */}
              <div className="h-1.5 w-full bg-muted rounded-full overflow-hidden" role="progressbar" aria-valuenow={total > 0 ? Math.round((done / total) * 100) : 0}>
                <div
                  className="h-full bg-primary"
                  style={{ width: `${total > 0 ? Math.min(100, (done / total) * 100) : 0}%` }}
                />
              </div>
              {failures > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-3">
                  {job.items
                    .filter((entry) => entry.status === 'failed' || entry.status === 'rejected')
                    .slice(0, 12)
                    .map((entry) => (
                      <span
                        key={entry.itemId}
                        title={entry.message}
                        className="text-[11px] px-1.5 py-0.5 bg-muted rounded text-muted-foreground"
                      >
                        条目 {entry.itemId} · {ITEM_LABEL[entry.status]}
                      </span>
                    ))}
                  {failures > 12 && <span className="text-[11px] text-muted-foreground self-center">…等 {failures} 项</span>}
                </div>
              )}
              {job.status === 'failed' && job.items.some((entry) => entry.errorCode === 'UPSTREAM_CHANGED') && (
                <p className="text-[11px] text-amber-500 mt-2">
                  上游页面结构变化，任务已自动暂停。待插件适配后可恢复剩余条目。
                </p>
              )}
            </div>
          );
        })}
      </div>

      <button
        type="button"
        onClick={() => void load()}
        className="mt-6 flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground focus-ring"
      >
        <RefreshCw size={12} />
        刷新列表
      </button>
    </div>
  );
}
