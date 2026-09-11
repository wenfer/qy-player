import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Loader2, Trash2, X } from 'lucide-react';
import { useToastStore } from '../../stores/toast-store';
import type { MediaDeletionPreview } from '../../../shared/types/safe-delete';

/**
 * Two-phase delete dialog (QYP2-025, plan §14.2): shows the real scope
 * before anything is touched, keeps the opaque token client-side (paths
 * never cross), requires typing the title for WebDAV permanent deletes,
 * disables double-execution, and never loses honest state.
 */

export type DeleteOutcome =
  | { status: 'trashed' | 'deleted'; itemId: number }
  | { status: 'unknown'; itemId: number };

export interface DeleteMediaDialogProps {
  sourceId: number;
  itemId: number;
  open: boolean;
  onClose: () => void;
  /** Called after a definite success (item is gone from the library view). */
  onDeleted?: (outcome: DeleteOutcome) => void;
  /** Focus restoration target (the opener). */
  returnFocusRef?: React.RefObject<HTMLElement | null>;
}

export default function DeleteMediaDialog({ sourceId, itemId, open, onClose, onDeleted, returnFocusRef }: DeleteMediaDialogProps) {
  const addToast = useToastStore((s) => s.addToast);
  const [preview, setPreview] = useState<MediaDeletionPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const dialogRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setPreview(null);
    setConfirmText('');
    try {
      const result = (await window.electronAPI.previewMediaDeletion({ sourceId, itemId })) as {
        ok: boolean;
        data?: MediaDeletionPreview;
        error?: { message: string };
      };
      if (result.ok && result.data) {
        setPreview(result.data);
      } else {
        setError(result.error?.message ?? '无法生成删除预览');
      }
    } catch {
      setError('无法生成删除预览');
    } finally {
      setLoading(false);
    }
  }, [sourceId, itemId]);

  useEffect(() => {
    if (!open) return;
    load();
    // Focus once the dialog content settles (no setTimeout race).
    requestAnimationFrame(() => {
      dialogRef.current?.querySelector<HTMLElement>('input, button')?.focus();
    });
  }, [open, load]);

  const requestClose = useCallback(() => {
    if (executing) return; // execution in flight: no close (double-run guard)
    onClose();
    returnFocusRef?.current?.focus();
  }, [executing, onClose, returnFocusRef]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        requestClose();
        return;
      }
      if (e.key === 'Tab' && dialogRef.current) {
        const focusables = dialogRef.current.querySelectorAll<HTMLElement>(
          'input:not(:disabled), button:not(:disabled)'
        );
        if (focusables.length === 0) {
          // Everything disabled mid-execution: keep focus on the dialog.
          e.preventDefault();
          dialogRef.current.focus();
          return;
        }
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    },
    [requestClose]
  );

  const handleExecute = useCallback(async () => {
    if (!preview || executing) return;
    setExecuting(true);
    setError(null);
    try {
      const result = (await window.electronAPI.executeMediaDeletion({
        token: preview.token,
        ...(preview.requiresTitleConfirmation ? { confirmTitle: confirmText } : {}),
      })) as {
        ok: boolean;
        data?: { status: string; itemId: number };
        error?: { message: string; details?: { conflicts?: unknown } };
      };
      if (!result.ok) {
        // Failures keep the dialog with the preview state; the token is
        // consumed server-side, so a retry requires a fresh preview.
        setPreview(null);
        setError(result.error?.message ?? '删除失败');
        addToast(result.error?.message ?? '删除失败', 'error');
        return;
      }
      const rawStatus = result.data?.status;
      // Whitelist: an unrecognized status is treated as unknown, never
      // silently celebrated.
      const status: 'trashed' | 'deleted' | 'unknown' =
        rawStatus === 'trashed' || rawStatus === 'deleted' || rawStatus === 'unknown'
          ? rawStatus
          : 'unknown';
      returnFocusRef?.current?.focus();
      if (status === 'unknown') {
        addToast('删除结果未知（服务器未确认），已标记待重查', 'warning');
        onDeleted?.({ status: 'unknown', itemId });
        onClose();
        return;
      }
      addToast(status === 'trashed' ? '已移入回收站' : '已删除', 'success');
      onDeleted?.({ status, itemId });
      onClose();
    } catch {
      setPreview(null);
      setError('删除请求失败');
      addToast('删除请求失败', 'error');
    } finally {
      setExecuting(false);
    }
  }, [preview, executing, confirmText, addToast, onDeleted, onClose]);

  if (!open) return null;

  const titleConfirmed =
    !preview?.requiresTitleConfirmation || (confirmText.length > 0 && confirmText === preview.itemTitle);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-8" onKeyDown={handleKeyDown}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="删除媒体"
        tabIndex={-1}
        className="w-full max-w-lg bg-card border border-border rounded-xl p-5 focus:outline-none"
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold flex items-center gap-1.5">
            <Trash2 size={15} className="text-destructive" />
            删除媒体
          </h2>
          <button
            type="button"
            onClick={requestClose}
            disabled={executing}
            aria-label="关闭删除对话框"
            className="p-1.5 text-muted-foreground hover:text-foreground rounded-lg focus-ring disabled:opacity-40"
          >
            <X size={16} />
          </button>
        </div>

        {loading ? (
          <p className="text-sm text-muted-foreground flex items-center gap-2 py-8 justify-center" aria-busy="true">
            <Loader2 size={16} className="animate-spin" />
            正在计算删除范围…
          </p>
        ) : !preview ? (
          <div>
            {error && (
              <div className="flex items-start gap-2 p-3 bg-destructive/10 text-destructive rounded-lg text-sm" role="alert">
                <AlertTriangle size={16} className="flex-shrink-0 mt-0.5" />
                <div>
                  <p>{error}</p>
                  <button
                    type="button"
                    onClick={load}
                    className="mt-2 px-2.5 py-1 text-xs border border-border rounded-md focus-ring text-muted-foreground hover:text-foreground"
                  >
                    重新检查
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : (
          <>
            {/* Real scope (plan §14.2.4): genuine title + file range. */}
            <dl className="text-sm space-y-1.5 mb-4">
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">媒体</dt>
                <dd className="font-medium text-right">{preview.itemTitle}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">来源</dt>
                <dd className="text-right">{preview.sourceName}（{preview.sourceKind === 'local' ? '本地' : 'WebDAV'}）</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">目录</dt>
                <dd className="text-right font-mono text-xs break-all">{preview.targetDir}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">范围</dt>
                <dd className="text-right">
                  {preview.fileCount} 个文件，共 {(preview.totalBytes / 1024 / 1024).toFixed(1)} MiB
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">方式</dt>
                <dd className={`text-right font-medium ${preview.method === 'webdav-delete' ? 'text-destructive' : ''}`}>
                  {preview.method === 'local-trash' ? '移入系统回收站（可恢复）' : '从服务器永久删除（不可恢复）'}
                </dd>
              </div>
            </dl>

            {preview.method === 'webdav-delete' && (
              <div className="mb-4 p-3 bg-destructive/10 rounded-lg">
                <p className="text-xs text-destructive mb-2 flex items-start gap-1.5">
                  <AlertTriangle size={13} className="flex-shrink-0 mt-0.5" />
                  WebDAV 删除不可恢复。请输入媒体标题「{preview.itemTitle}」以确认。
                </p>
                <input
                  type="text"
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  placeholder={preview.itemTitle}
                  aria-label="输入媒体标题以确认永久删除"
                  className="w-full px-3 py-2 bg-secondary border border-border rounded-lg text-sm focus:outline-none focus:border-destructive/60"
                />
              </div>
            )}

            {error && (
              <div className="mb-4 p-3 bg-destructive/10 text-destructive rounded-lg text-sm" role="alert">
                {error}
              </div>
            )}

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={requestClose}
                disabled={executing}
                className="px-3 py-2 text-sm text-muted-foreground hover:text-foreground focus-ring rounded-md disabled:opacity-40"
              >
                取消
              </button>
              <button
                type="button"
                onClick={handleExecute}
                disabled={executing || !titleConfirmed}
                title={!titleConfirmed ? '请先输入标题确认' : undefined}
                className="flex items-center gap-1.5 px-4 py-2 text-sm bg-destructive text-destructive-foreground rounded-lg hover:bg-destructive/90 transition-colors focus-ring disabled:opacity-50"
              >
                {executing ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                {executing ? '正在删除…' : preview.method === 'local-trash' ? '移入回收站' : '永久删除'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
