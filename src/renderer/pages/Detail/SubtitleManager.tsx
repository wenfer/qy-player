import { useCallback, useEffect, useState } from 'react';
import { Loader2, Plus, Star, Trash2, Captions, AlertTriangle } from 'lucide-react';
import { useToastStore } from '../../stores/toast-store';
import { toSubtitleAttachmentInfo, type SubtitleAttachmentInfo } from '../../../shared/types/subtitles';


/**
 * Subtitle manager for catalog items (QYP2-021, plan §13): sidecar and
 * imported subtitles in one list; import via the system file picker only;
 * optimistic updates with rollback on failure.
 */

type ManagerSubtitle = SubtitleAttachmentInfo;

export default function SubtitleManager({ itemId }: { itemId: number }) {
  const addToast = useToastStore((s) => s.addToast);
  const [subtitles, setSubtitles] = useState<ManagerSubtitle[]>([]);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const result = (await window.electronAPI.listSubtitles(itemId)) as {
        ok: boolean;
        data?: Array<Parameters<typeof toSubtitleAttachmentInfo>[0]>;
      };
      setSubtitles(result.ok && result.data ? result.data.map(toSubtitleAttachmentInfo) : []);
    } catch {
      setSubtitles([]);
    } finally {
      setLoading(false);
    }
  }, [itemId]);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  /** Import through the system picker: the renderer never passes paths. */
  const handleImport = useCallback(async () => {
    setImporting(true);
    try {
      const picked = await window.electronAPI.pickSubtitleFile();
      if (!picked) return;
      const result = (await window.electronAPI.importSubtitle({ itemId, sourcePath: picked })) as {
        ok: boolean;
        error?: { message: string };
      };
      if (result.ok) {
        addToast('字幕已导入', 'success');
        await load();
      } else {
        addToast(result.error?.message ?? '字幕导入失败', 'error');
      }
    } catch {
      addToast('字幕导入失败', 'error');
    } finally {
      setImporting(false);
    }
  }, [itemId, addToast, load]);

  /** Optimistic default switch; rollback on failure. */
  const handleSetDefault = useCallback(
    async (row: ManagerSubtitle) => {
      const previous = subtitles;
      setSubtitles((rows) => rows.map((r) => ({ ...r, isDefault: r.id === row.id })));
      setBusyId(row.id);
      try {
        const result = (await window.electronAPI.setDefaultSubtitle(itemId, row.id)) as {
          ok: boolean;
          error?: { message: string };
        };
        if (!result.ok) {
          setSubtitles(previous);
          addToast(result.error?.message ?? '设置默认字幕失败', 'error');
        } else {
          addToast('已设为默认字幕', 'success');
        }
      } catch {
        setSubtitles(previous);
        addToast('设置默认字幕失败', 'error');
      } finally {
        setBusyId(null);
      }
    },
    [subtitles, itemId, addToast]
  );

  /** Optimistic removal; rollback on failure. Imported rows lose their
   * managed copy; sidecar rows only drop the association. */
  const handleRemove = useCallback(
    async (row: ManagerSubtitle) => {
      const previous = subtitles;
      setSubtitles((rows) => rows.filter((r) => r.id !== row.id));
      setBusyId(row.id);
      try {
        const result = (await window.electronAPI.removeSubtitle(itemId, row.id)) as {
          ok: boolean;
          error?: { message: string };
        };
        if (!result.ok) {
          setSubtitles(previous);
          addToast(result.error?.message ?? '移除字幕失败', 'error');
        } else {
          addToast('字幕已移除', 'success');
        }
      } catch {
        setSubtitles(previous);
        addToast('移除字幕失败', 'error');
      } finally {
        setBusyId(null);
      }
    },
    [subtitles, itemId, addToast]
  );

  return (
    <section className="mt-8" aria-label="字幕">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold flex items-center gap-1.5">
          <Captions size={14} className="text-muted-foreground" />
          字幕
        </h3>
        <button
          type="button"
          onClick={handleImport}
          disabled={importing}
          className="flex items-center gap-1.5 px-2.5 py-1 text-xs bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 active:scale-[0.98] transition-all focus-ring disabled:opacity-50"
        >
          {importing ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
          导入字幕
        </button>
      </div>

      {loading ? (
        <p className="text-xs text-muted-foreground flex items-center gap-1.5" aria-busy="true">
          <Loader2 size={12} className="animate-spin" />
          正在加载字幕列表…
        </p>
      ) : subtitles.length === 0 ? (
        <p className="text-xs text-muted-foreground py-3">
          暂无字幕。可导入本机字幕文件（SRT/ASS/SSA/SUB/VTT，≤ 20 MiB），播放时自动挂载。
        </p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {subtitles.map((row) => (
            <li
              key={row.id}
              className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg border text-xs transition-colors ${
                row.isDefault ? 'border-primary/50 bg-primary/10' : 'border-border bg-card'
              }`}
            >
              <span className="font-medium">
                {row.language ?? '未知语言'}
                {row.title ? ` · ${row.title}` : ''}
              </span>
              <span className="text-[10px] text-muted-foreground uppercase">{row.format}</span>
              <span className="text-[10px] text-muted-foreground">
                {row.origin === 'imported' ? '已导入' : '外挂'}
              </span>
              {row.status !== 'ok' && (
                <span className="inline-flex items-center gap-0.5 text-[10px] text-amber-500">
                  <AlertTriangle size={10} />
                  {row.status === 'missing' ? '缺失' : '损坏'}
                </span>
              )}
              {row.isDefault ? (
                <span className="inline-flex items-center gap-0.5 text-[10px] text-primary">
                  <Star size={10} fill="currentColor" />
                  默认
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => handleSetDefault(row)}
                  disabled={busyId === row.id || row.status !== 'ok'}
                  className="p-0.5 text-muted-foreground hover:text-primary rounded focus-ring disabled:opacity-40"
                  aria-label={`设为默认字幕 ${row.language ?? row.id}`}
                  title={row.status !== 'ok' ? '字幕文件不可用，无法设为默认' : '设为默认'}
                >
                  <Star size={11} />
                </button>
              )}
              <button
                type="button"
                onClick={() => handleRemove(row)}
                disabled={busyId === row.id}
                className="p-0.5 text-muted-foreground hover:text-destructive rounded focus-ring"
                aria-label={`移除字幕 ${row.language ?? row.id}`}
                title={row.origin === 'imported' ? '移除（删除受管副本）' : '移除关联（不删原文件）'}
              >
                <Trash2 size={11} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
