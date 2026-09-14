import { useCallback, useEffect, useRef, useState } from 'react';
import { RotateCcw, Timer, X } from 'lucide-react';
import { useToastStore } from '../../stores/toast-store';

/**
 * 剧集自定义片头/片尾（整剧生效）——弹窗配置（用户反馈：表单占版面）。
 * 服务器识别不可用（Emby/旧版 Jellyfin/未开启片头检测）时的人工设定。
 * 存 SQLite skip_overrides（migration 006，scope=series，按 serverId
 * 精确隔离）。输入为秒数；片头/片尾各自独立保存，留空 = 清除该类型。
 */
interface RangeInput {
  start: string;
  end: string;
}

const EMPTY = { start: '', end: '' };

export default function SkipOverrideDialog({
  open,
  onClose,
  serverType,
  serverId,
  itemId,
  seriesName,
  returnFocusRef,
}: {
  open: boolean;
  onClose: () => void;
  serverType: string;
  serverId: number;
  itemId: string;
  seriesName: string;
  returnFocusRef?: React.RefObject<HTMLElement | null>;
}) {
  const addToast = useToastStore((s) => s.addToast);
  const [intro, setIntro] = useState<RangeInput>(EMPTY);
  const [outro, setOutro] = useState<RangeInput>(EMPTY);
  const [saving, setSaving] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  // 每次打开都拉最新设定（对话框内容与库内状态一致）
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const res = (await window.electronAPI.getSkipOverride({
          serverType,
          serverId,
          itemId,
          seriesName,
        })) as {
          ok: boolean;
          data?: { override?: { intro?: { start: number; end: number }; outro?: { start: number; end: number } } | null };
        };
        if (cancelled) return;
        const o = res.ok ? res.data?.override : null;
        setIntro(o?.intro ? { start: String(Math.floor(o.intro.start)), end: String(Math.floor(o.intro.end)) } : EMPTY);
        setOutro(o?.outro ? { start: String(Math.floor(o.outro.start)), end: String(Math.floor(o.outro.end)) } : EMPTY);
      } catch {
        if (!cancelled) {
          setIntro(EMPTY);
          setOutro(EMPTY);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, serverType, serverId, itemId, seriesName]);

  useEffect(() => {
    if (open) dialogRef.current?.focus();
  }, [open]);

  // 关闭后焦点回到触发按钮（键盘导航可用性）
  useEffect(() => {
    if (!open) returnFocusRef?.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const parseRange = useCallback((r: RangeInput): { start: number; end: number } | null | 'invalid' => {
    const start = Number(r.start);
    const end = Number(r.end);
    if (r.start === '' && r.end === '') return null; // 留空 = 清除
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) return 'invalid';
    return { start, end };
  }, []);

  const validIntro = parseRange(intro) !== 'invalid';
  const validOutro = parseRange(outro) !== 'invalid';

  const save = useCallback(async (): Promise<void> => {
    const introRange = parseRange(intro);
    const outroRange = parseRange(outro);
    if (introRange === 'invalid' || outroRange === 'invalid') {
      addToast('开始时间必须小于结束时间', 'error');
      return;
    }
    setSaving(true);
    try {
      const res = (await window.electronAPI.setSkipOverride({
        serverType,
        serverId,
        itemId,
        seriesName,
        intro: introRange,
        outro: outroRange,
      })) as { ok: boolean };
      if (res.ok) {
        addToast('片头/片尾设定已保存，下次播放生效', 'success');
        onClose();
      } else {
        addToast('保存失败，请重试', 'error');
      }
    } catch {
      addToast('保存失败，请重试', 'error');
    } finally {
      setSaving(false);
    }
  }, [intro, outro, parseRange, serverType, serverId, itemId, seriesName]);

  const reset = useCallback(async (): Promise<void> => {
    setSaving(true);
    try {
      const res = (await window.electronAPI.setSkipOverride({
        serverType,
        serverId,
        itemId,
        seriesName,
        intro: null,
        outro: null,
      })) as { ok: boolean };
      if (res.ok) {
        setIntro(EMPTY);
        setOutro(EMPTY);
        addToast('已恢复使用服务器识别', 'success');
      } else {
        addToast('保存失败，请重试', 'error');
      }
    } catch {
      addToast('保存失败，请重试', 'error');
    } finally {
      setSaving(false);
    }
  }, [serverType, serverId, itemId, seriesName]);

  if (!open) return null;

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') onClose();
  };

  const hasAny = intro.start !== '' || intro.end !== '' || outro.start !== '' || outro.end !== '';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-8"
      onKeyDown={handleKeyDown}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="片头片尾设定"
        tabIndex={-1}
        className="w-full max-w-md bg-card border border-border rounded-xl p-5 focus:outline-none"
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold flex items-center gap-1.5">
            <Timer size={15} className="text-muted-foreground" />
            片头/片尾设定
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭片头片尾设定"
            className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground focus-ring"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex flex-col gap-3">
          {(['片头', '片尾'] as const).map((label) => {
            const state = label === '片头' ? intro : outro;
            const setState = label === '片头' ? setIntro : setOutro;
            const valid = label === '片头' ? validIntro : validOutro;
            return (
              <div key={label} className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground w-8">{label}</span>
                <input
                  type="number"
                  min={0}
                  step={1}
                  placeholder="开始"
                  value={state.start}
                  onChange={(e) => setState({ ...state, start: e.target.value })}
                  className={`w-20 px-2 py-1 text-xs bg-input border border-border rounded-lg focus-ring ${!valid ? 'border-destructive' : ''}`}
                />
                <span className="text-xs text-muted-foreground">至</span>
                <input
                  type="number"
                  min={0}
                  step={1}
                  placeholder="结束"
                  value={state.end}
                  onChange={(e) => setState({ ...state, end: e.target.value })}
                  className={`w-20 px-2 py-1 text-xs bg-input border border-border rounded-lg focus-ring ${!valid ? 'border-destructive' : ''}`}
                />
                <span className="text-[10px] text-muted-foreground">秒</span>
              </div>
            );
          })}
          <p className="text-[10px] text-muted-foreground leading-relaxed">
            以秒为单位填写；留空即清除该设定。整部剧生效，下次播放时在片头/片尾段内自动跳过。
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving}
              className="px-3 py-1.5 text-xs bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 focus-ring disabled:opacity-50"
            >
              保存设定
            </button>
            <button
              type="button"
              onClick={() => void reset()}
              disabled={saving || !hasAny}
              className="px-3 py-1.5 text-xs border border-border rounded-lg hover:bg-accent focus-ring flex items-center gap-1 disabled:opacity-50"
            >
              <RotateCcw size={12} /> 恢复默认
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** 详情页触发按钮（内联占位极小）。 */
export function SkipOverrideTrigger({
  onClick,
  returnFocusRef,
}: {
  onClick: () => void;
  returnFocusRef?: React.RefObject<HTMLButtonElement | null>;
}) {
  return (
    <button
      type="button"
      ref={returnFocusRef as React.Ref<HTMLButtonElement> | undefined}
      onClick={onClick}
      className="w-full mt-2 flex items-center justify-center gap-1 px-2 py-2 border border-border rounded-lg hover:bg-accent transition-colors text-xs focus-ring text-muted-foreground hover:text-foreground"
    >
      <Timer size={13} />
      片头/片尾
    </button>
  );
}
