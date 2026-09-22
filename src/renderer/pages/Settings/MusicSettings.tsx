import { useCallback, useEffect, useState } from 'react';
import { MonitorUp, Sliders } from 'lucide-react';
import { useToastStore } from '../../stores/toast-store';
import { useSleepTimerStore, formatRemaining } from '../../stores/sleep-timer-store';
import { useResourceStore } from '../../stores/resource-store';
import AudioFxPanel from '../../components/AudioFxPanel';

/**
 * 音乐播放偏好（QYP3-012）：引擎偏好、ReplayGain、睡眠定时。
 *
 * 均衡器与音效**不在本页编辑**（QYP3-068v）：参量 EQ 需要频率/增益/Q 三个
 * 维度，塞进设置页既拥挤又要和面板抢同一个配置键。这里只留入口，编辑唯一
 * 发生在 `components/AudioFxPanel`。
 */

/** 睡眠定时档位（分钟）；0 = 关闭。跨页共享的当前档位来自 store。 */
const SLEEP_OPTIONS: Array<{ minutes: number; label: string }> = [
  { minutes: 0, label: '关闭' },
  { minutes: 15, label: '15 分钟' },
  { minutes: 30, label: '30 分钟' },
  { minutes: 45, label: '45 分钟' },
  { minutes: 60, label: '1 小时' },
  { minutes: 90, label: '1.5 小时' },
  { minutes: 120, label: '2 小时' },
];

const tabButtonClass = (active: boolean): string =>
  `px-2 py-1 rounded-lg text-xs border transition-colors focus-ring ${
    active ? 'bg-secondary border-border text-foreground' : 'border-border text-muted-foreground hover:bg-accent'
  }`;

export default function MusicSettings() {
  const addToast = useToastStore((s) => s.addToast);
  const [engine, setEngine] = useState<string>('spectrum-first');
  const [replaygain, setReplaygain] = useState<string>('off');
  // ReplayGain 高级项（P2）：dB / dB / 削波保护
  const [rgPreamp, setRgPreamp] = useState<number>(0);
  const [rgFallback, setRgFallback] = useState<number>(0);
  const [rgClip, setRgClip] = useState<boolean>(false);
  // 音效编辑唯一入口是面板（QYP3-068v）：设置页只放一个入口按钮，
  // 免得两处 UI 各写各的键互相覆盖
  const [showFx, setShowFx] = useState(false);
  // 桌面歌词（QYP3-022）
  const [deskOpen, setDeskOpen] = useState(false);
  const [deskFontSize, setDeskFontSize] = useState(28);
  const [deskLocked, setDeskLocked] = useState(true);
  // 拾音器（QYP3-023）
  const [visualizer, setVisualizer] = useState<string>('auto');
  // mpv 音源的离线频谱（QYP3-050）：需要机器上有 ffmpeg，没有就自动不生效
  const [offlineSpectrum, setOfflineSpectrum] = useState(true);
  // 精简模式（QYP3-035）：播放音频时自动缩成浮窗
  const [autoCompact, setAutoCompact] = useState(false);
  // 性能保护（QYP3-036）：状态在 store（主进程压力档 + 持久化开关）
  const powerSave = useResourceStore((s) => s.powerSave);
  // 睡眠定时（P2）：状态在 store（跨页共享，主进程为权威）
  const sleep = useSleepTimerStore();
  const setSleepMinutes = useCallback(
    async (minutes: number): Promise<void> => {
      await useSleepTimerStore.getState().setMinutes(minutes);
      addToast(minutes > 0 ? `已设置 ${minutes} 分钟后暂停播放` : '已取消睡眠定时', 'success');
    },
    [addToast]
  );
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const e = (await window.electronAPI.getSettings('playback.musicEngine')) as {
          data?: unknown;
        };
        setEngine(typeof e?.data === 'string' ? e.data : 'spectrum-first');
        const r = (await window.electronAPI.getSettings('playback.replaygain')) as {
          data?: unknown;
        };
        setReplaygain(typeof r?.data === 'string' ? r.data : 'off');
        const p = (await window.electronAPI.getSettings('playback.replaygainPreamp')) as {
          data?: unknown;
        };
        if (Number.isFinite(Number(p?.data))) setRgPreamp(Number(p?.data));
        const fb = (await window.electronAPI.getSettings('playback.replaygainFallback')) as {
          data?: unknown;
        };
        if (Number.isFinite(Number(fb?.data))) setRgFallback(Number(fb?.data));
        const c = (await window.electronAPI.getSettings('playback.replaygainClip')) as {
          data?: unknown;
        };
        setRgClip(c?.data === true || c?.data === 'true');
        const f = (await window.electronAPI.getSettings('deskLyrics.fontSize')) as { data?: unknown };
        if (Number.isFinite(Number(f?.data)) && Number(f?.data) > 0) setDeskFontSize(Number(f?.data));
        const l = (await window.electronAPI.getSettings('deskLyrics.locked')) as { data?: unknown };
        setDeskLocked(l?.data !== false && l?.data !== 'false');
        const v = (await window.electronAPI.getSettings('playback.visualizer')) as { data?: unknown };
        if (typeof v?.data === 'string') setVisualizer(v.data);
        const os = (await window.electronAPI.getSettings('playback.offlineSpectrum')) as {
          data?: unknown;
        };
        setOfflineSpectrum(os?.data !== false && os?.data !== 'false');
        const ac = (await window.electronAPI.getSettings('playback.autoCompact')) as { data?: unknown };
        setAutoCompact(ac?.data === true || ac?.data === 'true');
      } catch {
        // 默认值
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  const save = useCallback(
    async (key: string, value: unknown, message: string): Promise<void> => {
      try {
        const res = (await window.electronAPI.setSettings(key, value)) as { ok?: boolean };
        if (res?.ok !== false) addToast(message, 'success');
        else addToast('保存失败，请重试', 'error');
      } catch {
        addToast('保存失败，请重试', 'error');
      }
    },
    [addToast]
  );

  const changeEngine = useCallback(
    async (value: string): Promise<void> => {
      setEngine(value);
      await save(
        'playback.musicEngine',
        value,
        value === 'compat-first' ? '已切换为兼容性优先（全部 mpv 解码）' : '已切换为拾音器优先'
      );
    },
    [save]
  );

  const changeReplaygain = useCallback(
    async (value: string): Promise<void> => {
      setReplaygain(value);
      await save('playback.replaygain', value, 'ReplayGain 设置已保存');
    },
    [save]
  );

  /** ReplayGain 高级项（P2）：预增益 / 兜底增益 / 削波保护。 */
  const changeReplaygainAdvanced = useCallback(
    async (key: 'Preamp' | 'Fallback' | 'Clip', value: number | boolean): Promise<void> => {
      if (key === 'Preamp') setRgPreamp(value as number);
      else if (key === 'Fallback') setRgFallback(value as number);
      else setRgClip(value as boolean);
      await save(`playback.replaygain${key}`, value, 'ReplayGain 设置已保存');
    },
    [save]
  );

  const toggleDeskLyrics = useCallback(async (): Promise<void> => {
    const next = !deskOpen;
    const res = (await (next
      ? window.electronAPI.showDeskLyrics()
      : window.electronAPI.hideDeskLyrics())) as { ok?: boolean; error?: { message: string } };
    if (res?.ok === false) {
      addToast(res.error?.message ?? '桌面歌词不可用', 'error');
      return;
    }
    setDeskOpen(next);
    addToast(next ? '桌面歌词已开启' : '桌面歌词已关闭', 'success');
  }, [deskOpen, addToast]);

  const changeDeskFontSize = useCallback(
    async (value: number): Promise<void> => {
      setDeskFontSize(value);
      await window.electronAPI.setDeskLyricsStyle({ fontSize: value });
    },
    []
  );

  const toggleDeskLocked = useCallback(async (): Promise<void> => {
    const next = !deskLocked;
    setDeskLocked(next);
    await window.electronAPI.setDeskLyricsStyle({ locked: next });
    addToast(next ? '桌面歌词已锁定（鼠标穿透）' : '已解锁：可拖动窗口调整位置', 'success');
  }, [deskLocked, addToast]);

  const changeVisualizer = useCallback(
    async (value: string): Promise<void> => {
      setVisualizer(value);
      await save('playback.visualizer', value, '拾音器设置已保存');
    },
    [save]
  );

  const changeOfflineSpectrum = useCallback(
    async (value: boolean): Promise<void> => {
      setOfflineSpectrum(value);
      await save(
        'playback.offlineSpectrum',
        value,
        value ? '将以 ffmpeg 为 mpv 音源生成频谱' : '已关闭 mpv 音源频谱生成'
      );
    },
    [save]
  );

  const changeAutoCompact = useCallback(
    async (value: boolean): Promise<void> => {
      setAutoCompact(value);
      await save(
        'playback.autoCompact',
        value,
        value ? '播放音频时将自动进入精简模式' : '已关闭自动精简模式'
      );
    },
    [save]
  );

  const changePowerSave = useCallback(
    async (value: boolean): Promise<void> => {
      await useResourceStore.getState().setPowerSave(value);
      addToast(value ? '性能保护已开启' : '性能保护已关闭', 'success');
    },
    [addToast]
  );

  if (!loaded) return null;

  return (
    <div className="mt-8">
      <h2 className="text-base font-semibold mb-3">音乐</h2>
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3 bg-card border border-border rounded-xl p-4">
          <Sliders size={15} className="text-muted-foreground" />
          <span className="text-sm">解码引擎</span>
          <select
            value={engine}
            onChange={(e) => void changeEngine(e.target.value)}
            className="ml-auto bg-input border border-border rounded-lg px-2 py-1.5 text-xs focus-ring"
          >
            <option value="spectrum-first">拾音器优先（常见格式走内置引擎）</option>
            <option value="compat-first">兼容性优先（全部用 mpv 解码）</option>
          </select>
          <span className="text-xs text-muted-foreground w-full">
            冷门格式（APE/WMA/DSF 等）始终用 mpv 引擎；实时频谱仅在引擎优先模式下可用。
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-3 bg-card border border-border rounded-xl p-4">
          <span className="text-sm">ReplayGain 音量均衡</span>
          <select
            value={replaygain}
            onChange={(e) => void changeReplaygain(e.target.value)}
            className="ml-auto bg-input border border-border rounded-lg px-2 py-1.5 text-xs focus-ring"
          >
            <option value="off">关闭</option>
            <option value="track">单曲增益</option>
            <option value="album">专辑增益</option>
          </select>
          <span className="text-xs text-muted-foreground w-full">
            依标签里的增益信息拉平音量差异；无标签的曲目不受影响。
          </span>

          {/* 高级项（P2）：仅在启用 ReplayGain 时才有意义 */}
          {replaygain !== 'off' && (
            <div className="w-full flex flex-col gap-3 pt-3 border-t border-border">
              <label className="flex flex-wrap items-center gap-3">
                <span className="text-xs text-muted-foreground">整体预增益</span>
                <input
                  type="range"
                  min={-15}
                  max={15}
                  step={0.5}
                  value={rgPreamp}
                  onChange={(e) => setRgPreamp(Number(e.target.value))}
                  onBlur={() => void changeReplaygainAdvanced('Preamp', rgPreamp)}
                  className="flex-1 min-w-[160px] accent-[var(--primary)]"
                  aria-label="ReplayGain 预增益"
                />
                <span className="text-xs w-14 text-right">{rgPreamp.toFixed(1)} dB</span>
              </label>
              <label className="flex flex-wrap items-center gap-3">
                <span className="text-xs text-muted-foreground">无标签曲目增益</span>
                <input
                  type="range"
                  min={-15}
                  max={15}
                  step={0.5}
                  value={rgFallback}
                  onChange={(e) => setRgFallback(Number(e.target.value))}
                  onBlur={() => void changeReplaygainAdvanced('Fallback', rgFallback)}
                  className="flex-1 min-w-[160px] accent-[var(--primary)]"
                  aria-label="ReplayGain 兜底增益"
                />
                <span className="text-xs w-14 text-right">{rgFallback.toFixed(1)} dB</span>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={rgClip}
                  onChange={(e) => void changeReplaygainAdvanced('Clip', e.target.checked)}
                  className="accent-[var(--primary)]"
                  aria-label="ReplayGain 削波保护"
                />
                <span className="text-xs text-muted-foreground">削波保护（增益过大时限制峰值）</span>
              </label>
              <span className="text-[11px] text-muted-foreground">
                这些参数只在 mpv 引擎（服务器曲目 / 冷门格式）生效。
              </span>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3 bg-card border border-border rounded-xl p-4">
          <span className="text-sm">拾音器</span>
          <select
            value={visualizer}
            onChange={(e) => void changeVisualizer(e.target.value)}
            className="ml-auto bg-input border border-border rounded-lg px-2 py-1.5 text-xs focus-ring"
          >
            <option value="auto">自动（有实时频谱就用频谱）</option>
            <option value="spectrum">实时频谱</option>
            <option value="waveform">播放波形</option>
            <option value="off">关闭</option>
          </select>
          <span className="text-xs text-muted-foreground w-full">
            显示在底部音乐控制条上，最高 30 帧/秒。内置引擎解码的音轨是实时频谱；
            冷门格式走 mpv 引擎时用下面那份离线频谱。
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-3 bg-card border border-border rounded-xl p-4">
          <span className="text-sm">mpv 音源频谱</span>
          <label className="ml-auto flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={offlineSpectrum}
              onChange={(e) => void changeOfflineSpectrum(e.target.checked)}
              className="accent-[var(--primary)]"
              aria-label="为 mpv 音源生成离线频谱"
            />
            <span className="text-xs text-muted-foreground">后台生成（需要 ffmpeg）</span>
          </label>
          <span className="text-xs text-muted-foreground w-full">
            mpv 解码的音源（APE/WMA/CUE 等冷门格式、服务器转码）没有实时频谱接口，
            开着时会在后台用 ffmpeg 解一遍并算出频谱备用（一首几分钟的歌大约占 100KB
            缓存）。机器上没有 ffmpeg 就自动不生效，不影响播放。CPU 紧张的旧机器可以关掉。
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-3 bg-card border border-border rounded-xl p-4">
          <span className="text-sm">精简模式</span>
          <label className="ml-auto flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={autoCompact}
              onChange={(e) => void changeAutoCompact(e.target.checked)}
              className="accent-[var(--primary)]"
              aria-label="播放音频时自动进入精简模式"
            />
            <span className="text-xs text-muted-foreground">播放音频时自动进入</span>
          </label>
          <span className="text-xs text-muted-foreground w-full">
            精简模式把窗口缩成屏幕右上角的小浮窗（频谱图 + 进度 + 上一曲/暂停/下一曲 +
            循环 + 音量），随时可点浮窗上的「还原」按钮恢复。播放中也可在底部音乐控制条
            点「精简」手动进入。
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-3 bg-card border border-border rounded-xl p-4">
          <span className="text-sm">性能保护</span>
          <label className="ml-auto flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={powerSave}
              onChange={(e) => void changePowerSave(e.target.checked)}
              className="accent-[var(--primary)]"
              aria-label="性能保护"
            />
            <span className="text-xs text-muted-foreground">系统繁忙时降低频谱刷新</span>
          </label>
          <span className="text-xs text-muted-foreground w-full">
            系统 CPU 紧张时自动降低频谱图的刷新帧率（音乐页与精简浮窗），把 CPU 让给
            音频解码，减少播放卡顿；压力回落后自动恢复。只影响画面刷新，不影响播放本身。
            精简浮窗右侧的仪表按钮可随手开关。
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-3 bg-card border border-border rounded-xl p-4">
          <span className="text-sm">睡眠定时</span>
          <span className="text-xs text-muted-foreground">
            到点暂停播放，音乐与视频通用（仅本次运行有效）
          </span>
          <div className="flex flex-wrap gap-1.5 ml-auto">
            {SLEEP_OPTIONS.map((opt) => (
              <button
                key={opt.minutes}
                type="button"
                onClick={() => void setSleepMinutes(opt.minutes)}
                aria-pressed={opt.minutes === 0 ? !sleep.active : sleep.active && sleep.minutes === opt.minutes}
                className={tabButtonClass(
                  opt.minutes === 0 ? !sleep.active : sleep.active && sleep.minutes === opt.minutes
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
          {sleep.active && (
            <div className="w-full flex items-center gap-2 pt-2 border-t border-border">
              <span className="text-xs">剩余 {formatRemaining(sleep.remainingMs)}</span>
              <button
                type="button"
                onClick={() => void setSleepMinutes(0)}
                className="ml-auto px-2 py-1 rounded-lg text-xs border border-border hover:bg-accent focus-ring"
              >
                取消定时
              </button>
            </div>
          )}
        </div>

        <div className="bg-card border border-border rounded-xl p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm flex items-center gap-1.5">
              <Sliders size={14} className="text-muted-foreground rotate-90" />
              均衡器与音效
            </span>
            <button
              type="button"
              onClick={() => setShowFx(true)}
              className="ml-auto px-3 py-1.5 text-xs rounded-lg border border-border hover:bg-accent focus-ring"
            >
              打开音效面板
            </button>
          </div>
          <p className="text-[11px] text-muted-foreground mt-2">
            参量均衡器（频率 / 增益 / Q）、前置增益、削波保护与声场调节都在
            音效面板里，也可从顶部工具条的音效按钮进入。视频播放不受影响。
          </p>
          {showFx ? <AudioFxPanel onClose={() => setShowFx(false)} /> : null}
        </div>

        <div className="bg-card border border-border rounded-xl p-4">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm flex items-center gap-1.5">
              <MonitorUp size={14} className="text-muted-foreground" />
              桌面歌词
            </span>
            <button
              type="button"
              onClick={() => void toggleDeskLyrics()}
              className={`ml-auto px-3 py-1.5 text-xs rounded-lg border focus-ring ${
                deskOpen
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'border-border hover:bg-accent'
              }`}
            >
              {deskOpen ? '已开启' : '已关闭'}
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-3 mt-3">
            <span className="text-xs text-muted-foreground">字号</span>
            <input
              type="range"
              min={18}
              max={48}
              step={1}
              value={deskFontSize}
              onChange={(e) => void changeDeskFontSize(Number(e.target.value))}
              className="w-40 accent-primary"
              aria-label="桌面歌词字号"
            />
            <span className="text-xs text-muted-foreground w-8">{deskFontSize}</span>
            <button
              type="button"
              onClick={() => void toggleDeskLocked()}
              className="px-3 py-1.5 text-xs rounded-lg border border-border hover:bg-accent focus-ring"
            >
              {deskLocked ? '锁定位置（鼠标穿透）' : '解锁：可拖动'}
            </button>
          </div>
          <p className="text-[11px] text-muted-foreground mt-2">
            置顶浮窗显示当前歌词；无歌词或暂停时自动隐藏。解锁后可拖动窗口，位置会被记住。
          </p>
        </div>
      </div>
    </div>
  );
}
