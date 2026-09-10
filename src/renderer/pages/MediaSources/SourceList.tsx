import { Loader2, RefreshCw, Trash2, X, Lock, Unlock, Globe, AlertTriangle, HeartPulse, HardDrive } from 'lucide-react';
import { urlLooksPlaintextHttp } from './WebDavFields';
import type { SourceListEntry } from '../../../shared/types';

export interface SourceListProps {
  sources: SourceListEntry[];
  scanningIds: Set<number>;
  /** Live push events win over the persisted last run while scanning. */
  liveProgress: Record<number, { state: string; processed?: number; total?: number; message?: string }>;
  onScanToggle: (source: SourceListEntry) => void;
  onRemove: (source: SourceListEntry) => void;
}

const NON_TERMINAL = new Set(['queued', 'discovering', 'indexing', 'enriching']);

const HEALTH_LABEL: Record<string, string> = {
  ok: '在线',
  degraded: '部分可用',
  offline: '离线',
  'auth-required': '需要认证',
};

/** Small tinted badge (keeps texts the tests assert on). */
function Badge({ tone, children }: { tone: 'neutral' | 'warn' | 'ok'; children: React.ReactNode }) {
  const cls =
    tone === 'warn'
      ? 'bg-amber-500/10 text-amber-500'
      : tone === 'ok'
        ? 'bg-emerald-500/10 text-emerald-500'
        : 'bg-secondary text-secondary-foreground';
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-medium ${cls}`}>
      {children}
    </span>
  );
}

/** Source rows for 本地 + WebDAV sources (plan §7/§8, QYP2-008/013). */
export default function SourceList({ sources, scanningIds, liveProgress, onScanToggle, onRemove }: SourceListProps) {
  return (
    <div className="space-y-2">
      {sources.map((source) => {
        const live = liveProgress[source.id];
        const progress = live
          ? { status: live.state, processed: live.processed, total: live.total, message: live.message }
          : source.lastRun;
        const scanning = scanningIds.has(source.id) || (progress?.status !== undefined && NON_TERMINAL.has(progress.status));
        const isWebdav = source.kind === 'webdav';
        const percent =
          progress?.total && progress.total > 0
            ? Math.min(100, Math.round(((progress.processed ?? 0) / progress.total) * 100))
            : null;
        return (
          <div
            key={source.id}
            className={`flex items-start gap-3 p-4 bg-card border border-border rounded-xl transition-colors ${
              scanning ? 'border-primary/40' : 'hover:border-primary/30'
            }`}
          >
            {/* Kind icon tile */}
            <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-primary/10 text-primary flex-shrink-0">
              {isWebdav ? <Globe size={17} /> : <HardDrive size={17} />}
            </div>

            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium text-sm">{source.name}</span>
                <Badge tone="neutral">
                  {isWebdav ? <Globe size={10} /> : null}
                  {isWebdav ? 'WebDAV' : '本地'}
                </Badge>
                {source.readOnly && <span className="text-[10px] text-muted-foreground">只读</span>}
                {isWebdav && urlLooksPlaintextHttp(source.root) && (
                  <Badge tone="warn">
                    <AlertTriangle size={10} />
                    http 明文
                  </Badge>
                )}
                {isWebdav && (
                  <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                    {source.hasCredential ? <Lock size={10} /> : <Unlock size={10} />}
                    {source.hasCredential ? '凭据已保存' : '无凭据'}
                  </span>
                )}
                {source.health && (
                  <span
                    className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-medium ${
                      source.health === 'ok'
                        ? 'bg-emerald-500/10 text-emerald-500'
                        : source.health === 'auth-required' || source.health === 'offline'
                          ? 'bg-amber-500/10 text-amber-500'
                          : 'bg-muted text-muted-foreground'
                    }`}
                  >
                    <HeartPulse size={10} />
                    {HEALTH_LABEL[source.health] ?? source.health}
                  </span>
                )}
              </div>
              <div className="text-xs text-muted-foreground mt-1 truncate font-mono" title={source.root}>
                {source.root}
              </div>
              {isWebdav && (
                <div className="flex items-center gap-1.5 mt-1.5 flex-wrap" aria-label="来源能力">
                  <span className="px-1.5 py-0.5 rounded bg-muted text-[10px] text-muted-foreground">
                    {source.capabilities.supportsRange ? '可拖动/续播' : '拖动不可靠'}
                  </span>
                  <span className="px-1.5 py-0.5 rounded bg-muted text-[10px] text-muted-foreground">
                    {source.capabilities.supportsEtag ? 'ETag' : '无 ETag'}
                  </span>
                  <span className="px-1.5 py-0.5 rounded bg-muted text-[10px] text-muted-foreground">
                    {source.capabilities.canDelete ? '可删除' : '删除已禁用'}
                  </span>
                </div>
              )}
              {scanning ? (
                <div className="mt-2" aria-live="polite">
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Loader2 size={12} className="animate-spin" />
                    扫描中
                    {progress?.total ? `（${progress.processed ?? 0}/${progress.total}）` : ''}
                  </div>
                  {percent !== null && (
                    <div className="h-1 mt-1.5 rounded-full bg-secondary overflow-hidden">
                      <div
                        className="h-full bg-primary rounded-full transition-[width] duration-300"
                        style={{ width: `${percent}%` }}
                      />
                    </div>
                  )}
                </div>
              ) : progress ? (
                <div className="text-[11px] text-muted-foreground mt-1.5">
                  上次扫描：
                  {progress.status === 'completed'
                    ? `完成，共 ${progress.processed ?? 0} 项`
                    : progress.status === 'failed'
                      ? `失败${progress.message ? `：${progress.message}` : ''}`
                      : progress.status}
                </div>
              ) : (
                <div className="text-[11px] text-muted-foreground mt-1.5">尚未扫描</div>
              )}
            </div>

            <div className="flex items-center gap-1 flex-shrink-0 self-center">
              <button
                onClick={() => onScanToggle(source)}
                className="p-2 text-muted-foreground hover:text-foreground hover:bg-accent rounded-lg transition-colors focus-ring"
                aria-label={scanning ? `取消扫描 ${source.name}` : `扫描 ${source.name}`}
                title={scanning ? '取消扫描' : '扫描'}
              >
                {scanning ? <X size={15} /> : <RefreshCw size={15} />}
              </button>
              <button
                onClick={() => onRemove(source)}
                className="p-2 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-lg transition-colors focus-ring"
                aria-label={`移除 ${source.name}（不删除文件）`}
                title="移除（不删除文件）"
              >
                <Trash2 size={15} />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
