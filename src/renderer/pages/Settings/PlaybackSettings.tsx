import { useCallback, useEffect, useState } from 'react';
import { useToastStore } from '../../stores/toast-store';

/**
 * 播放偏好：自动连播（QYP2-035）+ 剧集跳过片头/片尾。
 * 开关实时读取（main 侧每次命中/EOF 重新取值，改完即生效）。
 */
export default function PlaybackSettings() {
  const addToast = useToastStore((s) => s.addToast);
  const [autoNext, setAutoNext] = useState<boolean | null>(null);
  const [skipIntro, setSkipIntro] = useState<boolean | null>(null);
  const [skipOutro, setSkipOutro] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = (await window.electronAPI.getAutoNextEnabled()) as { ok: boolean; data?: { enabled: boolean } };
        setAutoNext(res.ok ? res.data?.enabled ?? true : true);
      } catch {
        setAutoNext(true);
      }
      try {
        const res = (await window.electronAPI.getSkipSettings()) as {
          ok: boolean;
          data?: { skipIntro: boolean; skipOutro: boolean };
        };
        setSkipIntro(res.ok ? res.data?.skipIntro ?? true : true);
        setSkipOutro(res.ok ? res.data?.skipOutro ?? false : false);
      } catch {
        setSkipIntro(true);
        setSkipOutro(false);
      }
    })();
  }, []);

  const toggleAutoNext = useCallback(async (): Promise<void> => {
    if (autoNext === null) return;
    setSaving(true);
    try {
      const next = !autoNext;
      const res = (await window.electronAPI.setAutoNextEnabled(next)) as { ok: boolean };
      if (res.ok) {
        setAutoNext(next);
      } else {
        addToast('设置保存失败，请重试', 'error');
      }
    } catch {
      addToast('设置保存失败，请重试', 'error');
    } finally {
      setSaving(false);
    }
  }, [autoNext]);

  const toggleSkip = useCallback(async (key: 'skipIntro' | 'skipOutro'): Promise<void> => {
    setSaving(true);
    try {
      const current = key === 'skipIntro' ? skipIntro : skipOutro;
      if (current === null) return;
      const next = !current;
      const res = (await window.electronAPI.setSkipSetting(key, next)) as { ok: boolean };
      if (res.ok) {
        (key === 'skipIntro' ? setSkipIntro : setSkipOutro)(next);
        addToast(next ? '已开启' : '已关闭', 'success');
      } else {
        addToast('设置保存失败，请重试', 'error');
      }
    } catch {
      addToast('设置保存失败，请重试', 'error');
    } finally {
      setSaving(false);
    }
  }, [skipIntro, skipOutro]);

  if (autoNext === null && skipIntro === null && skipOutro === null) return null;

  return (
    <div className="mt-8">
      <h2 className="text-base font-semibold mb-3">播放</h2>
      <div className="flex flex-col gap-3">
        <label className="flex flex-wrap items-center gap-3 bg-card border border-border rounded-xl p-4 cursor-pointer">
          <input
            type="checkbox"
            checked={autoNext ?? true}
            onChange={() => void toggleAutoNext()}
            disabled={saving}
            className="w-4 h-4 accent-primary"
          />
          <span className="text-sm">整集播完后自动播放下一集</span>
          <span className="text-xs text-muted-foreground w-full">仅在完整播放到片尾时触发，倒数 5 秒，可随时取消。</span>
        </label>
        <label className="flex flex-wrap items-center gap-3 bg-card border border-border rounded-xl p-4 cursor-pointer">
          <input
            type="checkbox"
            checked={skipIntro ?? true}
            onChange={() => void toggleSkip('skipIntro')}
            disabled={saving}
            className="w-4 h-4 accent-primary"
          />
          <span className="text-sm">自动跳过片头（剧集）</span>
          <span className="text-xs text-muted-foreground w-full">
            播进片头段时自动跳过；由服务器识别片头（Jellyfin 10.9+），未识别的剧集不受影响。
          </span>
        </label>
        <label className="flex flex-wrap items-center gap-3 bg-card border border-border rounded-xl p-4 cursor-pointer">
          <input
            type="checkbox"
            checked={skipOutro ?? false}
            onChange={() => void toggleSkip('skipOutro')}
            disabled={saving}
            className="w-4 h-4 accent-primary"
          />
          <span className="text-sm">自动跳过片尾（剧集）</span>
          <span className="text-xs text-muted-foreground w-full">
            跳到片尾段结束时将触发自动连播倒数（若已开启）。
          </span>
        </label>
      </div>
    </div>
  );
}
