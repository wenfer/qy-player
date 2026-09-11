import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, Loader2, RefreshCw, Wand2, XCircle } from 'lucide-react';
import { useToastStore } from '../../stores/toast-store';

/**
 * Single-item scrape dialog (QYP2-032, plan §11.2).
 *
 * 流程：启动单项任务 → 轮询状态 → 四种终态：
 * - applied：显示应用的字段数（低置信候选永远不会走到这里——main 侧
 *   matcher 门槛强制，UI 只呈现结果）；
 * - confirm：0.75–0.92 候选列表，人工点选后才应用；
 * - rejected：<0.75，保留现有元数据；
 * - failed：显示原因 + 重试（重新起一个单项任务）。
 *
 * 离开页面安全：任务持久在 main 侧 app_config，重开对话框重查即可。
 */

interface ScrapeItemResult {
  itemId: number;
  status: 'applied' | 'confirm' | 'rejected' | 'failed' | 'skipped';
  message?: string;
  errorCode?: string;
  candidates?: Array<{ id: string; title: string; score: number }>;
}

interface ScrapeJobRecord {
  id: string;
  status: 'running' | 'completed' | 'cancelled' | 'failed' | 'interrupted';
  items: ScrapeItemResult[];
  pending: number[];
  pluginId: string;
}

interface PluginListEntry {
  id: string;
  name: string;
  capability: string;
  enabled: boolean;
}

const SCORE_LABEL = (score: number): string => `${Math.round(score * 100)}%`;

export default function ScrapeDialog({
  itemId,
  open,
  onClose,
}: {
  itemId: number;
  open: boolean;
  onClose: () => void;
}) {
  const addToast = useToastStore((s) => s.addToast);
  const [pluginId, setPluginId] = useState<string | null>(null);
  const [providers, setProviders] = useState<PluginListEntry[]>([]);
  const [phase, setPhase] = useState<'idle' | 'running' | 'confirm' | 'applied' | 'rejected' | 'failed'>('idle');
  const [message, setMessage] = useState('');
  const [candidates, setCandidates] = useState<Array<{ id: string; title: string; score: number }>>([]);
  const [applying, setApplying] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const aliveRef = useRef(true);

  const stopPolling = useCallback((): void => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const handleResult = useCallback(
    (result: ScrapeItemResult): void => {
      if (result.status === 'applied') {
        setPhase('applied');
        setMessage(result.message ?? '已应用刮削结果');
      } else if (result.status === 'confirm') {
        setPhase('confirm');
        setCandidates(result.candidates ?? []);
        setMessage(result.message ?? '找到多个可能的匹配，请人工确认');
      } else if (result.status === 'rejected') {
        setPhase('rejected');
        setMessage(result.message ?? '置信度不足，保留现有元数据');
      } else {
        setPhase('failed');
        setMessage(result.message ?? '刮削失败');
      }
    },
    []
  );

  const start = useCallback(async (): Promise<void> => {
    if (!pluginId) return;
    setPhase('running');
    setMessage('正在搜索匹配…');
    setCandidates([]);
    try {
      const res = (await window.electronAPI.scrapeStart(pluginId, [itemId])) as {
        ok: boolean;
        data?: { jobId: string };
        error?: { message: string };
      };
      if (!res.ok || !res.data) {
        setPhase('failed');
        setMessage(res.error?.message ?? '任务启动失败');
        return;
      }
      const jobId = res.data.jobId;
      stopPolling();
      if (!aliveRef.current) return; // closed while starting: no orphan poller
      pollRef.current = setInterval(async () => {
        try {
          const status = (await window.electronAPI.scrapeStatus(jobId)) as {
            ok: boolean;
            data?: ScrapeJobRecord;
          };
          const record = status.ok ? status.data : undefined;
          if (!record) return;
          const result = record.items.find((entry) => entry.itemId === itemId);
          if (result && record.status !== 'running') {
            stopPolling();
            if (aliveRef.current) handleResult(result);
          }
        } catch {
          /* 轮询失败不打断；下一轮重试 */
        }
      }, 800);
    } catch (err) {
      setPhase('failed');
      setMessage(err instanceof Error ? err.message : '任务启动失败');
    }
  }, [pluginId, itemId, stopPolling, handleResult]);

  const applyCandidate = useCallback(
    async (candidateId: string): Promise<void> => {
      if (!pluginId) return;
      setApplying(true);
      try {
        const res = (await window.electronAPI.scrapeApply(pluginId, itemId, candidateId)) as {
          ok: boolean;
          data?: ScrapeItemResult;
          error?: { message: string };
        };
        if (!res.ok) {
          addToast(res.error?.message ?? '应用失败', 'error');
          return;
        }
        if (res.data) handleResult(res.data);
      } catch (err) {
        addToast(err instanceof Error ? err.message : '应用失败', 'error');
      } finally {
        setApplying(false);
      }
    },
    [pluginId, itemId, addToast, handleResult]
  );

  // Load enabled providers once per open. Every open resets to a fresh
  // run: phase stays from the previous run otherwise, and auto-start
  // (phase === 'idle') would never fire again.
  useEffect(() => {
    if (!open) return;
    aliveRef.current = true;
    setPhase('idle');
    setMessage('');
    setCandidates([]);
    (async () => {
      try {
        const res = (await window.electronAPI.listPlugins()) as { ok: boolean; data?: PluginListEntry[] };
        const usable = (res.ok ? res.data ?? [] : []).filter(
          (entry) => entry.capability === 'metadata-provider' && entry.enabled && entry.id !== 'douban'
        );
        setProviders(usable);
        setPluginId(usable[0]?.id ?? null);
      } catch {
        setProviders([]);
      }
    })();
    return () => {
      aliveRef.current = false;
      stopPolling();
    };
  }, [open, stopPolling]);

  // Auto-start on open.
  useEffect(() => {
    if (open && pluginId && phase === 'idle') {
      void start();
    }
  }, [open, pluginId, phase, start]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-label="刮削元数据">
      <div className="bg-card border border-border rounded-xl w-full max-w-lg p-5 max-h-[85vh] overflow-y-auto">
        <div className="flex items-center gap-2 mb-4">
          <Wand2 size={18} className="text-primary" />
          <h2 className="text-base font-semibold">刮削元数据</h2>
        </div>

        {providers.length > 1 && (
          <label className="block mb-4 text-xs text-muted-foreground">
            数据来源
            <select
              value={pluginId ?? ''}
              onChange={(e) => {
                setPluginId(e.target.value);
                setPhase('idle');
              }}
              disabled={phase === 'running'}
              className="mt-1 w-full bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground focus-ring"
            >
              {providers.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </select>
          </label>
        )}

        {phase === 'running' && (
          <div className="flex items-center gap-3 py-6 text-sm text-muted-foreground">
            <Loader2 size={18} className="animate-spin" />
            {message}
          </div>
        )}

        {phase === 'applied' && (
          <div className="py-4">
            <div className="flex items-center gap-2 text-emerald-500 text-sm">
              <CheckCircle2 size={18} />
              {message}
            </div>
          </div>
        )}

        {phase === 'confirm' && (
          <div className="py-2">
            <p className="text-sm text-muted-foreground mb-3">{message}</p>
            <div className="flex flex-col gap-2">
              {candidates.map((candidate) => (
                <button
                  key={candidate.id}
                  type="button"
                  disabled={applying}
                  onClick={() => void applyCandidate(candidate.id)}
                  className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 border border-border rounded-lg hover:border-primary/40 hover:bg-accent/50 transition-colors text-left focus-ring disabled:opacity-50"
                >
                  <span className="text-sm">{candidate.title}</span>
                  <span className="text-xs px-1.5 py-0.5 bg-muted rounded text-muted-foreground">
                    匹配度 {SCORE_LABEL(candidate.score)}
                  </span>
                </button>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground mt-3">
              低于 75% 的候选不会展示，也不会自动套用；人工锁定的字段保持不变。
            </p>
          </div>
        )}

        {(phase === 'rejected' || phase === 'failed') && (
          <div className="py-4">
            <div className="flex items-start gap-2 text-sm text-amber-500">
              <XCircle size={18} className="shrink-0 mt-0.5" />
              <span>{message}</span>
            </div>
          </div>
        )}

        <div className="flex flex-wrap gap-2 mt-5">
          {(phase === 'failed' || phase === 'rejected') && (
            <button
              type="button"
              onClick={() => void start()}
              className="flex items-center gap-1.5 px-3 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 text-xs focus-ring"
            >
              <RefreshCw size={13} />
              重试
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-2 border border-border rounded-lg hover:bg-accent text-xs text-muted-foreground hover:text-foreground focus-ring"
          >
            {phase === 'applied' ? '完成' : '关闭'}
          </button>
        </div>
      </div>
    </div>
  );
}
