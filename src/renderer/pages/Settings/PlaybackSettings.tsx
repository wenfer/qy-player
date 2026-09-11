import { useCallback, useEffect, useState } from 'react';
import { useToastStore } from '../../stores/toast-store';

/**
 * Playback preferences (QYP2-035, plan §12.3): 自动连播开关。
 * app_config `playback.autoNext`（默认开；main 侧每次 EOF 实时读取）。
 */
export default function PlaybackSettings() {
  const addToast = useToastStore((s) => s.addToast);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = (await window.electronAPI.getAutoNextEnabled()) as { ok: boolean; data?: { enabled: boolean } };
        setEnabled(res.ok ? res.data?.enabled ?? true : true);
      } catch {
        setEnabled(true);
      }
    })();
  }, []);

  const toggle = useCallback(async (): Promise<void> => {
    if (enabled === null) return;
    setSaving(true);
    try {
      const next = !enabled;
      const res = (await window.electronAPI.setAutoNextEnabled(next)) as { ok: boolean };
      if (res.ok) {
        setEnabled(next);
      } else {
        addToast('设置保存失败，请重试', 'error');
      }
    } catch {
      addToast('设置保存失败，请重试', 'error');
    } finally {
      setSaving(false);
    }
  }, [enabled]);

  if (enabled === null) return null;

  return (
    <div className="mt-8">
      <h2 className="text-base font-semibold mb-3">播放</h2>
      <label className="flex flex-wrap items-center gap-3 bg-card border border-border rounded-xl p-4 cursor-pointer">
        <input
          type="checkbox"
          checked={enabled}
          onChange={() => void toggle()}
          disabled={saving}
          className="w-4 h-4 accent-primary"
        />
        <span className="text-sm">整集播完后自动播放下一集</span>
        <span className="text-xs text-muted-foreground w-full">仅在完整播放到片尾时触发，倒数 5 秒，可随时取消。</span>
      </label>
    </div>
  );
}
