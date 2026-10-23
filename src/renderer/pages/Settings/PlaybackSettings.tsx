import { useCallback, useEffect, useState } from 'react';
import { useToastStore } from '../../stores/toast-store';
import { readSetting } from '../../utils/read-setting';

/**
 * 播放偏好：自动连播（QYP2-035）+ 剧集跳过片头/片尾 + 硬件加速解码（QYP3-070）。
 * 开关实时读取（main 侧每次命中/EOF 重新取值，改完即生效）。
 */
export default function PlaybackSettings() {
  const addToast = useToastStore((s) => s.addToast);
  const [autoNext, setAutoNext] = useState<boolean | null>(null);
  const [skipIntro, setSkipIntro] = useState<boolean | null>(null);
  const [skipOutro, setSkipOutro] = useState<boolean | null>(null);
  const [hwdec, setHwdec] = useState<string>('no');
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
      try {
        const savedHwdec = await readSetting<string>('playback.hwdec');
        setHwdec(typeof savedHwdec === 'string' ? savedHwdec : 'no');
      } catch {
        setHwdec('no');
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

  const updateHwdec = useCallback(async (value: string): Promise<void> => {
    setSaving(true);
    try {
      await window.electronAPI.setSettings('playback.hwdec', value);
      setHwdec(value);
      addToast(value === 'no' ? '已切换为软件解码' : '已开启硬件加速解码', 'success');
    } catch {
      addToast('设置保存失败，请重试', 'error');
    } finally {
      setSaving(false);
    }
  }, []);

  if (autoNext === null && skipIntro === null && skipOutro === null) return null;

  return (
    <div className="mt-8">
      <h2 className="text-base font-semibold mb-3">播放</h2>
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-2 bg-card border border-border rounded-xl p-4">
          <div className="flex items-center justify-between">
            <div>
              <span className="text-sm font-medium">硬件加速解码 (GPU)</span>
              <p className="text-xs text-muted-foreground mt-0.5">
                利用显卡芯片进行硬件解码。默认关闭以兼容老旧 Linux 设备与早期驱动。
              </p>
            </div>
            <select
              value={hwdec}
              onChange={(e) => void updateHwdec(e.target.value)}
              disabled={saving}
              className="bg-secondary text-foreground text-xs rounded-lg px-2.5 py-1.5 border border-border focus-ring cursor-pointer ml-4"
            >
              <option value="no">关闭（纯软件解码，兼容老旧设备）</option>
              <option value="auto-safe">开启（自动选择，推荐现代独立/集成显卡）</option>
              <option value="vaapi">VA-API（Linux Intel/AMD 平台专属）</option>
            </select>
          </div>
          <span className="text-xs text-muted-foreground leading-relaxed">
            若播放 4K 或 H.265 (HEVC) 高码率视频出现卡顿、掉帧或 CPU 负载过高，建议切换为「开启（自动选择）」或「VA-API」。
          </span>
        </div>
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
