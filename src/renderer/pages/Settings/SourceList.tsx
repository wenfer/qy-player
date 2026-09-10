import { Loader2, RefreshCw, Trash2, X, Lock, Unlock, Globe, AlertTriangle } from 'lucide-react';
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

function isPlaintextHttp(root: string): boolean {
  return /^http:\/\//i.test(root);
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
        return (
          <div key={source.id} className="p-4 bg-card border border-border rounded-xl">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-sm">{source.name}</span>
                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-secondary text-secondary-foreground text-[10px] font-medium">
                    {isWebdav ? <Globe size={10} /> : null}
                    {isWebdav ? 'WebDAV' : '本地'}
                  </span>
                  {source.readOnly && <span className="text-[10px] text-muted-foreground">只读</span>}
                  {isWebdav && isPlaintextHttp(source.root) && (
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-500 text-[10px] font-medium">
                      <AlertTriangle size={10} />
                      http 明文
                    </span>
                  )}
                  {isWebdav && (
                    <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                      {source.hasCredential ? <Lock size={10} /> : <Unlock size={10} />}
                      {source.hasCredential ? '凭据已保存' : '无凭据'}
                    </span>
                  )}
                </div>
                <div className="text-xs text-muted-foreground mt-0.5 truncate" title={source.root}>
                  {source.root}
                </div>
                {isWebdav && (
                  <div className="flex items-center gap-1.5 mt-1 flex-wrap" aria-label="来源能力">
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
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground mt-1" aria-live="polite">
                    <Loader2 size={12} className="animate-spin" />
                    扫描中
                    {progress?.total ? `（${progress.processed ?? 0}/${progress.total}）` : ''}
                  </div>
                ) : progress ? (
                  <div className="text-[11px] text-muted-foreground mt-1">
                    上次扫描：
                    {progress.status === 'completed'
                      ? `完成，共 ${progress.processed ?? 0} 项`
                      : progress.status === 'failed'
                        ? `失败${progress.message ? `：${progress.message}` : ''}`
                        : progress.status}
                  </div>
                ) : (
                  <div className="text-[11px] text-muted-foreground mt-1">尚未扫描</div>
                )}
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                <button
                  onClick={() => onScanToggle(source)}
                  disabled={isWebdav}
                  className="p-2 text-muted-foreground hover:text-foreground hover:bg-accent rounded-lg transition-colors focus-ring disabled:opacity-40 disabled:hover:bg-transparent"
                  aria-label={scanning ? `取消扫描 ${source.name}` : `扫描 ${source.name}`}
                  title={isWebdav ? 'WebDAV 扫描即将支持' : scanning ? '取消扫描' : '扫描'}
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
          </div>
        );
      })}
    </div>
  );
}
