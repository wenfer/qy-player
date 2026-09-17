import { useCallback, useEffect, useState } from 'react';
import { MonitorUp, Sliders } from 'lucide-react';
import { useToastStore } from '../../stores/toast-store';
import { EQ_BANDS } from '../../player/web-audio-engine';

/**
 * 音乐播放偏好（QYP3-012）：引擎偏好、ReplayGain、均衡器。
 * EQ 双引擎共用：renderer 引擎直连 BiquadFilter；mpv 引擎由
 * main 侧映射为 lavfi equalizer 链（主进程消费同一 10 段 dB 数组）。
 */

const EQ_FREQ_LABELS = ['60', '170', '350', '1k', '3.5k', '6k', '9k', '12k', '14k', '16k'];
const EQ_PRESETS_UI: Array<{ id: string; label: string; gains: number[] }> = [
  { id: 'flat', label: '平直', gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { id: 'bass', label: '重低音', gains: [7, 6, 4, 2, 0, 0, 0, 0, 1, 2] },
  { id: 'vocal', label: '人声', gains: [-3, -1, 2, 4, 4, 3, 1, 0, -1, -2] },
  { id: 'treble', label: '高亮', gains: [-2, -1, 0, 0, 0, 2, 4, 6, 7, 7] },
  { id: 'electronic', label: '电子', gains: [5, 4, 1, 0, -2, 0, 1, 3, 5, 6] },
  { id: 'classical', label: '古典', gains: [4, 3, 1, 0, 0, 0, 1, 2, 4, 3] },
  { id: 'rock', label: '摇滚', gains: [5, 4, 2, 0, -1, 0, 1, 3, 4, 4] },
];

export default function MusicSettings() {
  const addToast = useToastStore((s) => s.addToast);
  const [engine, setEngine] = useState<string>('spectrum-first');
  const [replaygain, setReplaygain] = useState<string>('off');
  const [eqGains, setEqGains] = useState<number[]>(new Array(10).fill(0));
  // 桌面歌词（QYP3-022）
  const [deskOpen, setDeskOpen] = useState(false);
  const [deskFontSize, setDeskFontSize] = useState(28);
  const [deskLocked, setDeskLocked] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

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
        const q = (await window.electronAPI.getSettings('playback.eqGains')) as {
          data?: unknown;
        };
        if (Array.isArray(q?.data) && q.data.length === 10) {
          setEqGains(q.data.map((v) => Number(v) || 0));
        }
        const f = (await window.electronAPI.getSettings('deskLyrics.fontSize')) as { data?: unknown };
        if (Number.isFinite(Number(f?.data)) && Number(f?.data) > 0) setDeskFontSize(Number(f?.data));
        const l = (await window.electronAPI.getSettings('deskLyrics.locked')) as { data?: unknown };
        setDeskLocked(l?.data !== 'false');
      } catch {
        // 默认值
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  const save = useCallback(
    async (key: string, value: unknown, message: string): Promise<void> => {
      setSaving(true);
      try {
        const res = (await window.electronAPI.setSettings(key, value)) as { ok?: boolean };
        if (res?.ok !== false) addToast(message, 'success');
        else addToast('保存失败，请重试', 'error');
      } catch {
        addToast('保存失败，请重试', 'error');
      } finally {
        setSaving(false);
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

  const applyEq = useCallback(
    async (gains: number[], message: string): Promise<void> => {
      setEqGains(gains);
      await save('playback.eqGains', gains, message);
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

  const adjustBand = useCallback(
    (index: number, value: number): void => {
      setEqGains((prev) => {
        const next = [...prev];
        next[index] = value;
        return next;
      });
    },
    []
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
        </div>

        <div className="bg-card border border-border rounded-xl p-4">
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <span className="text-sm flex items-center gap-1.5">
              <Sliders size={14} className="text-muted-foreground rotate-90" />
              均衡器
            </span>
            <div className="flex flex-wrap gap-1.5 ml-auto">
              {EQ_PRESETS_UI.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => void applyEq(p.gains, `已应用预设：${p.label}`)}
                  disabled={saving}
                  className="px-2 py-1 text-[10px] border border-border rounded-lg hover:bg-accent focus-ring"
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
          <div className="flex flex-wrap gap-3">
            {eqGains.map((gain, i) => (
              <div key={EQ_BANDS[i]} className="flex flex-col items-center gap-1 w-14">
                <span className="text-[9px] text-muted-foreground">{gain > 0 ? `+${gain}` : gain}</span>
                <input
                  type="range"
                  min={-12}
                  max={12}
                  step={1}
                  value={gain}
                  onChange={(e) => adjustBand(i, Number(e.target.value))}
                  onMouseUp={() => void applyEq(eqGains, '均衡器已保存')}
                  onTouchEnd={() => void applyEq(eqGains, '均衡器已保存')}
                  onKeyUp={() => void applyEq(eqGains, '均衡器已保存')}
                  className="w-full accent-primary"
                  aria-label={`均衡器 ${EQ_FREQ_LABELS[i]}Hz`}
                />
                <span className="text-[9px] text-muted-foreground">{EQ_FREQ_LABELS[i]}</span>
              </div>
            ))}
          </div>
          <p className="text-[11px] text-muted-foreground mt-2">
            实时生效于音乐播放；视频播放不受均衡器影响。
          </p>
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
