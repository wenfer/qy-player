import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import { useToastStore } from '../../stores/toast-store';
import MetadataField, { FIELD_SHAPES, textToValue, valueToText } from './MetadataField';
import type { MetadataConflict, MetadataFieldInfo, MetadataSavePatch } from '../../../shared/types/metadata-editor';

/**
 * Metadata editor dialog (QYP2-023, plan §14.1): drafts, batch save with
 * revision checks, per-field conflict diffs, per-field restore, image
 * import. Failures keep the drafts (nothing the user typed is ever lost).
 */

const EDITOR_FIELDS = [
  'title', 'originalTitle', 'sortTitle', 'tagline', 'contentRating',
  'year', 'premiered', 'rating', 'genres', 'countries', 'directors',
  'actors', 'uniqueIds', 'plot', 'season', 'episode', 'poster', 'fanart',
];

export interface MetadataEditorProps {
  itemId: number;
  open: boolean;
  onClose: () => void;
}

export default function MetadataEditor({ itemId, open, onClose }: MetadataEditorProps) {
  const addToast = useToastStore((s) => s.addToast);
  const [fields, setFields] = useState<MetadataFieldInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  /** field → draft text ('' means the draft equals an empty value). */
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [conflicts, setConflicts] = useState<Record<string, MetadataConflict>>({});
  const dialogRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = (await window.electronAPI.getMetadataFields(itemId)) as {
        ok: boolean;
        data?: { fields: MetadataFieldInfo[] };
      };
      setFields(result.ok && result.data ? result.data.fields : []);
    } catch {
      setFields([]);
      addToast('加载元数据失败', 'error');
    } finally {
      setLoading(false);
    }
  }, [itemId, addToast]);

  useEffect(() => {
    if (open) {
      setDrafts({});
      setConflicts({});
      load();
      // Dialog focus management: move focus inside, restore on close.
      setTimeout(() => {
        // Initial focus on the first FIELD control, not the destructive
        // "恢复全部" button sitting in the header.
        dialogRef.current?.querySelector<HTMLElement>('input, textarea')?.focus();
      }, 50);
    }
  }, [open, load]);

  const requestClose = useCallback(() => {
    onClose();
  }, [onClose]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        requestClose();
        return;
      }
      // Focus trap: keep Tab cycling inside the dialog.
      if (e.key === 'Tab' && dialogRef.current) {
        const focusables = dialogRef.current.querySelectorAll<HTMLElement>(
          'input:not(:disabled), textarea:not(:disabled), button:not(:disabled)'
        );
        if (focusables.length === 0) return;
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

  const changedPatches = useCallback((): MetadataSavePatch[] => {
    const patches: MetadataSavePatch[] = [];
    for (const info of fields) {
      const shape = FIELD_SHAPES[info.field] ?? 'text';
      if (shape === 'image') continue; // images import directly
      const draft = drafts[info.field];
      if (draft === undefined) continue;
      const originalText = valueToText(info.winner?.value, shape);
      if (draft === originalText) continue; // untouched draft
      const value = textToValue(info.field, shape, draft);
      patches.push({
        field: info.field,
        value,
        expectedRevision: info.winner?.revision ?? 0,
      });
    }
    return patches;
  }, [fields, drafts]);

  const handleSave = useCallback(async () => {
    const patches = changedPatches();
    if (patches.length === 0) {
      addToast('没有需要保存的修改', 'info');
      return;
    }
    setSaving(true);
    try {
      const result = (await window.electronAPI.saveMetadataEdits(itemId, patches)) as {
        ok: boolean;
        data?: { changed?: string[]; cleared?: string[] };
        error?: { message: string; details?: { conflicts?: MetadataConflict[] } };
      };
      if (result.ok) {
        setDrafts({});
        setConflicts({});
        addToast('元数据已保存', 'success');
        await load();
      } else {
        // Conflicts keep the drafts: the user decides per field.
        const conflicts = result.error?.details?.conflicts;
        if (conflicts && conflicts.length > 0) {
          const map: Record<string, MetadataConflict> = {};
          for (const conflict of conflicts) map[conflict.field] = conflict;
          setConflicts(map);
          addToast('部分字段存在版本冲突，请逐个处理', 'warning');
        } else {
          // Validation/other failures also keep the drafts.
          addToast(result.error?.message ?? '保存失败', 'error');
        }
      }
    } catch {
      addToast('保存失败', 'error');
    } finally {
      setSaving(false);
    }
  }, [itemId, changedPatches, addToast, load]);

  /** Re-save one conflicted field with the current winner's revision. */
  const handleOverrideConflict = useCallback(
    async (field: string) => {
      const info = fields.find((f) => f.field === field);
      const conflict = conflicts[field];
      if (!info) return;
      const shape = FIELD_SHAPES[field] ?? 'text';
      const draft = drafts[field] ?? '';
      try {
        const result = (await window.electronAPI.saveMetadataEdits(itemId, [
          {
            field,
            value: textToValue(field, shape, draft),
            expectedRevision: conflict?.current?.revision ?? info.winner?.revision ?? 0,
          },
        ])) as { ok: boolean; error?: { message: string } };
        if (result.ok) {
          setConflicts((prev) => {
            const next = { ...prev };
            delete next[field];
            return next;
          });
          addToast('已覆盖保存', 'success');
          await load();
        } else {
          addToast(result.error?.message ?? '覆盖失败', 'error');
        }
      } catch {
        addToast('覆盖失败', 'error');
      }
    },
    [fields, conflicts, drafts, itemId, addToast, load]
  );

  const handleDropConflict = useCallback((field: string) => {
    setConflicts((prev) => {
      const next = { ...prev };
      delete next[field];
      return next;
    });
    setDrafts((prev) => {
      const next = { ...prev };
      delete next[field];
      return next;
    });
  }, []);

  const handleRestore = useCallback(
    async (field: string) => {
      try {
        const result = (await window.electronAPI.restoreMetadataFields(itemId, [field])) as {
          ok: boolean;
          error?: { message: string };
        };
        if (result.ok) {
          setDrafts((prev) => {
            const next = { ...prev };
            delete next[field];
            return next;
          });
          addToast('已恢复来源值', 'success');
          await load();
        } else {
          addToast(result.error?.message ?? '恢复失败', 'error');
        }
      } catch {
        addToast('恢复失败', 'error');
      }
    },
    [itemId, addToast, load]
  );

  const handleRemoveAll = useCallback(async () => {
    try {
      const result = (await window.electronAPI.restoreMetadataFields(itemId)) as {
        ok: boolean;
        data?: { cleared: string[] };
        error?: { message: string };
      };
      if (result.ok) {
        const count = result.data?.cleared.length ?? 0;
        setDrafts({});
        addToast(count > 0 ? `已恢复 ${count} 个字段` : '没有手工修改需要恢复', 'success');
        await load();
      } else {
        addToast(result.error?.message ?? '恢复失败', 'error');
      }
    } catch {
      addToast('恢复失败', 'error');
    }
  }, [itemId, addToast, load]);

  const handleImportImage = useCallback(
    async (field: 'poster' | 'fanart') => {
      try {
        const picked = await window.electronAPI.pickImageFile();
        if (!picked) return;
        const result = (await window.electronAPI.importImages(itemId, [
          { kind: field, sourcePath: picked },
        ])) as { ok: boolean; error?: { message: string } };
        if (result.ok) {
          addToast('图片已导入', 'success');
          await load();
        } else {
          addToast(result.error?.message ?? '图片导入失败', 'error');
        }
      } catch {
        addToast('图片导入失败', 'error');
      }
    },
    [itemId, addToast, load]
  );

  if (!open) return null;

  const sortedFields = [...fields].sort((a, b) => {
    const ia = EDITOR_FIELDS.indexOf(a.field);
    const ib = EDITOR_FIELDS.indexOf(b.field);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-8"
      onKeyDown={handleKeyDown}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="编辑元数据"
        className="w-full max-w-2xl max-h-[85vh] overflow-y-auto bg-card border border-border rounded-xl p-5"
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold">编辑元数据</h2>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleRemoveAll}
              className="px-2.5 py-1 text-xs border border-border rounded-md focus-ring text-muted-foreground hover:text-foreground"
            >
              恢复全部
            </button>
            <button
              type="button"
              onClick={requestClose}
              aria-label="关闭元数据编辑器"
              className="p-1.5 text-muted-foreground hover:text-foreground rounded-lg focus-ring"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {loading ? (
          <p className="text-sm text-muted-foreground flex items-center gap-2 py-8 justify-center" aria-busy="true">
            <Loader2 size={16} className="animate-spin" />
            正在加载…
          </p>
        ) : (
          <>
            {sortedFields.map((info) => (
              <MetadataField
                key={info.field}
                info={info}
                draftText={drafts[info.field] ?? ''}
                hasDraft={drafts[info.field] !== undefined}
                conflict={conflicts[info.field]}
                disabled={saving}
                onChange={(text) => setDrafts((prev) => ({ ...prev, [info.field]: text }))}
                onRestore={() => handleRestore(info.field)}
                onOverrideConflict={() => handleOverrideConflict(info.field)}
                onDropConflict={() => handleDropConflict(info.field)}
                onImportImage={
                  info.field === 'poster' || info.field === 'fanart'
                    ? () => handleImportImage(info.field as 'poster' | 'fanart')
                    : undefined
                }
              />
            ))}

            <div className="flex justify-end gap-2 pt-2 border-t border-border">
              <button
                type="button"
                onClick={requestClose}
                className="px-3 py-2 text-sm text-muted-foreground hover:text-foreground focus-ring rounded-md"
              >
                取消
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                className="flex items-center gap-1.5 px-4 py-2 text-sm bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors focus-ring disabled:opacity-50"
              >
                {saving ? <Loader2 size={14} className="animate-spin" /> : null}
                保存
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
