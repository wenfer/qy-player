import { useCallback, useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import DeleteMediaDialog, { type DeleteOutcome } from './DeleteMediaDialog';
import { useToastStore } from '../../stores/toast-store';

/**
 * Media actions container (QYP2-025): the destructive "删除" entry that
 * owns the two-phase dialog. A failed preview/execute never mutates the
 * view — the item stays until a definite deletion is reported.
 */

export interface MediaActionsProps {
  sourceId: number;
  itemId: number;
  /** Invoked only after a definite/unknown server answer, so the list can
   * drop or re-probe the item. */
  onDeleted?: (outcome: DeleteOutcome) => void;
}

export default function MediaActions({ sourceId, itemId, onDeleted }: MediaActionsProps) {
  const addToast = useToastStore((s) => s.addToast);
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const handleDeleted = useCallback(
    (outcome: DeleteOutcome) => {
      if (outcome.status === 'unknown') {
        // Unknown: the item may still exist — refresh instead of dropping.
        addToast('删除结果未知，列表已刷新以重新确认', 'info');
      }
      onDeleted?.(outcome);
    },
    [addToast, onDeleted]
  );

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen(true)}
        className="w-full mt-2 flex items-center justify-center gap-1.5 px-3 py-2 border border-border rounded-lg hover:bg-destructive/10 hover:text-destructive hover:border-destructive/40 transition-colors focus-ring text-xs text-muted-foreground"
      >
        <Trash2 size={12} />
        删除媒体
      </button>
      <DeleteMediaDialog
        sourceId={sourceId}
        itemId={itemId}
        open={open}
        onClose={() => setOpen(false)}
        onDeleted={handleDeleted}
        returnFocusRef={buttonRef}
      />
    </>
  );
}
