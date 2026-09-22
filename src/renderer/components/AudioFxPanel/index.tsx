import { useCallback, useEffect, useRef, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { useMusicPlaybackStore, AUDIO_FX_KEY } from '../../stores/music-playback-store';
import { useToastStore } from '../../stores/toast-store';
import { readSetting } from '../../utils/read-setting';
import {
  AUDIO_FX_PRESETS_KEY,
  BUILTIN_FX_PRESETS,
  parseFxPresets,
  type AudioFxPreset,
} from '../../utils/audio-fx-presets';
import {
  AUDIO_FX_DEFAULT,
  AUDIO_FX_MAX_BANDS,
  EQ_DEFAULT_Q,
  EQ_Q_MAX,
  EQ_Q_MIN,
  sanitizeAudioFx,
  type AudioFxSettings,
  type EqBand,
  type EqFilterType,
} from '../../../main/modules/playback-engine/audio-fx';

/**
 * 音效面板（QYP3-068v）：参量 EQ + 前置增益 + 削波保护 + 声场三项。
 *
 * 外壳抄 `components/LyricsPanel`（fixed + 卡片 + 头部 + 可滚动内容区，
 * `bottom-40` 让开停靠的播放条），Esc 与焦点陷阱抄
 * `pages/Detail/DeleteMediaDialog`。
 *
 * **改参数 = 立即喂引擎，松手才落盘**（沿用 MusicSettings 的既有模式）：
 * 内置引擎改 AudioParam 是真实时；mpv 改 af 会重建滤镜链，主进程做了防抖，
 * 实际是"松手生效"，面板底部据此给一句提示。
 */

// z-index 高于歌词面板（同为 z-50）与停靠播放条（z-40），低于 Toast（z-100）：
// 两者同时打开时不该互相压住
const PANEL =
  'fixed left-3 right-3 top-10 bottom-40 z-[55] bg-card/95 backdrop-blur border border-border rounded-xl shadow-lg flex flex-col';
const ICON_BTN = 'p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent focus-ring';
const ROW = 'flex items-center gap-1.5';
const LABEL = 'text-[11px] text-muted-foreground shrink-0';
const SLIDER = 'accent-primary flex-1 min-w-[80px]';

function freqLabel(freq: number): string {
  return freq >= 1000 ? `${(freq / 1000).toFixed(freq >= 10000 ? 0 : 1)}k` : `${freq}`;
}

function balanceLabel(v: number): string {
  if (Math.abs(v) < 0.02) return '居中';
  return v < 0 ? `左 ${Math.round(-v * 100)}%` : `右 ${Math.round(v * 100)}%`;
}

interface Props {
  onClose: () => void;
}

export default function AudioFxPanel({ onClose }: Props) {
  const applyAudioFx = useMusicPlaybackStore((s) => s.applyAudioFx);
  const syncAudioFx = useMusicPlaybackStore((s) => s.syncAudioFx);
  const engine = useMusicPlaybackStore((s) => s.engine);
  // 初值取一次快照即可（面板自己就是编辑入口，不需要订阅 store 跟着跳）。
  // 订阅反而会让拖动滑块的每一步都多一次无谓重渲染。
  const [fx, setFx] = useState<AudioFxSettings>(() =>
    sanitizeAudioFx(useMusicPlaybackStore.getState().audioFx)
  );
  const [saved, setSaved] = useState(false);
  const [presets, setPresets] = useState<AudioFxPreset[]>([]);
  const [presetName, setPresetName] = useState('');
  const addToast = useToastStore((s) => s.addToast);
  const dialogRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  /** 未落盘的改动（关闭面板时补写一次）。 */
  const dirtyRef = useRef(false);
  /**
   * fx 的同步镜像。**副作用不能写在 `setFx(prev => …)` 的 updater 里**：
   * ① StrictMode 会把 updater 跑两遍（重复 IPC 写盘）；② updater 在渲染阶段
   * 执行，往里塞 `applyAudioFx`/`commit` 属于渲染期副作用；③ 每次事件都从闭包
   * 里读 `fx` 又会在同一 tick 内连发多个事件时丢中间态。用 ref 做权威值，
   * 三条一起解决：读写都同步，`setFx` 只负责让 UI 跟上。
   */
  const fxRef = useRef<AudioFxSettings>(fx);

  const setFxBoth = useCallback((next: AudioFxSettings): void => {
    fxRef.current = next;
    setFx(next);
  }, []);

  // 打开时以配置为准（store 里可能是起播快照/从未写入过）。
  // 两个依赖都是稳定引用（store action / 空依赖 useCallback），不会重跑。
  useEffect(() => {
    void syncAudioFx().then(() => {
      setFxBoth(sanitizeAudioFx(useMusicPlaybackStore.getState().audioFx));
    });
    void readSetting(AUDIO_FX_PRESETS_KEY)
      .then((raw) => setPresets(parseFxPresets(raw)))
      .catch(() => setPresets([]));
  }, [syncAudioFx, setFxBoth]);

  /** 落盘（松手/关闭时）；拖动中只喂引擎不写盘。 */
  const commit = useCallback(
    async (next: AudioFxSettings): Promise<void> => {
      dirtyRef.current = false;
      setSaved(true);
      try {
        await window.electronAPI.setSettings(AUDIO_FX_KEY, next);
      } catch {
        // 写盘失败要吭声：以前是 `.catch(() => {})`，界面照样显示"已保存"
        setSaved(false);
        addToast('音效设置保存失败', 'error');
      }
    },
    [addToast]
  );

  const persistPresets = useCallback(
    async (next: AudioFxPreset[], message: string): Promise<void> => {
      const prev = presets;
      setPresets(next);
      // SETTINGS.SET 不返回 {ok} —— 失败只会体现在 reject / 抛错上
      // （原来读 `res.ok === false` 恒为 false，整个回滚分支是死的）
      try {
        await window.electronAPI.setSettings(AUDIO_FX_PRESETS_KEY, next);
      } catch {
        setPresets(prev); // 持久化失败必须回滚
        addToast('预设保存失败', 'error');
        return;
      }
      addToast(message, 'success');
    },
    [presets, addToast]
  );

  const applyPreset = useCallback(
    (preset: AudioFxPreset): void => {
      const clean = sanitizeAudioFx(preset.fx);
      setFxBoth(clean);
      applyAudioFx(clean);
      void commit(clean);
    },
    [applyAudioFx, commit, setFxBoth]
  );

  const savePreset = useCallback((): void => {
    const label = presetName.trim();
    if (!label) {
      addToast('请先填写预设名称', 'error');
      return;
    }
    if ([...BUILTIN_FX_PRESETS, ...presets].some((p) => p.label === label)) {
      addToast('已有同名预设', 'error');
      return;
    }
    const next = [...presets, { id: `custom-${Date.now()}`, label, fx: fxRef.current }];
    void persistPresets(next, `已保存预设：${label}`);
    setPresetName('');
  }, [presetName, presets, persistPresets, addToast]);

  useEffect(() => {
    returnFocusRef.current = document.activeElement as HTMLElement | null;
    requestAnimationFrame(() => {
      dialogRef.current?.querySelector<HTMLElement>('input, button')?.focus();
    });
    return () => returnFocusRef.current?.focus();
  }, []);


  const update = useCallback(
    (patch: Partial<AudioFxSettings>, commitNow = false): void => {
      const next = sanitizeAudioFx({ ...fxRef.current, ...patch });
      setFxBoth(next);
      applyAudioFx(next); // 立即喂引擎（内置引擎真实时）
      if (commitNow) void commit(next);
      else dirtyRef.current = true;
    },
    [applyAudioFx, commit, setFxBoth]
  );

  const updateBand = useCallback(
    (index: number, patch: Partial<EqBand>, commitNow = false): void => {
      const prev = fxRef.current;
      const bands = prev.eq.bands.map((b, i) => (i === index ? { ...b, ...patch } : b));
      const next = sanitizeAudioFx({ ...prev, eq: { ...prev.eq, bands } });
      setFxBoth(next);
      applyAudioFx(next);
      if (commitNow) void commit(next);
      else dirtyRef.current = true;
    },
    [applyAudioFx, commit, setFxBoth]
  );

  const addBand = useCallback((): void => {
    const prev = fxRef.current;
    if (prev.eq.bands.length >= AUDIO_FX_MAX_BANDS) return;
    const bands = [
      ...prev.eq.bands,
      { freq: 1000, gain: 0, q: EQ_DEFAULT_Q, type: 'peaking' as EqFilterType },
    ];
    const next = sanitizeAudioFx({ ...prev, eq: { ...prev.eq, bands } });
    setFxBoth(next);
    applyAudioFx(next);
    void commit(next);
  }, [applyAudioFx, commit, setFxBoth]);

  const removeBand = useCallback(
    (index: number): void => {
      const prev = fxRef.current;
      const bands = prev.eq.bands.filter((_, i) => i !== index);
      const next = sanitizeAudioFx({ ...prev, eq: { ...prev.eq, bands } });
      setFxBoth(next);
      applyAudioFx(next);
      void commit(next);
    },
    [applyAudioFx, commit, setFxBoth]
  );

  const requestClose = useCallback(() => {
    if (dirtyRef.current) void commit(fxRef.current);
    onClose();
  }, [commit, onClose]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        requestClose();
        return;
      }
      if (e.key === 'Tab' && dialogRef.current) {
        const focusables = dialogRef.current.querySelectorAll<HTMLElement>(
          'input:not(:disabled), button:not(:disabled), select:not(:disabled)'
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

  return (
    <div
      ref={dialogRef}
      className={PANEL}
      role="dialog"
      aria-modal="true"
      aria-label="音效调节"
      tabIndex={-1}
      onKeyDown={handleKeyDown}
    >
      <div className="flex items-center justify-between px-4 py-2 border-b border-border flex-shrink-0">
        <h2 className="text-sm font-semibold">音效</h2>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-muted-foreground">{saved ? '已保存' : ''}</span>
          <button type="button" className={ICON_BTN} onClick={requestClose} aria-label="关闭音效面板" title="关闭">
            <X size={14} />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
        {/* 总开关 */}
        <label className={`${ROW} cursor-pointer`}>
          <input
            type="checkbox"
            checked={fx.enabled}
            onChange={(e) => update({ enabled: e.target.checked }, true)}
            className="w-4 h-4 accent-primary"
          />
          <span className="text-xs">启用音效处理</span>
        </label>

        {/* ---- 均衡器 ---- */}
        <section className={fx.enabled ? '' : 'opacity-50'}>
          <div className="flex items-center justify-between mb-1.5">
            <label className={`${ROW} cursor-pointer`}>
              <input
                type="checkbox"
                checked={fx.eq.enabled}
                disabled={!fx.enabled}
                onChange={(e) => update({ eq: { ...fx.eq, enabled: e.target.checked } }, true)}
                className="w-4 h-4 accent-primary"
              />
              <span className="text-xs font-medium">均衡器</span>
            </label>
            <button
              type="button"
              onClick={addBand}
              disabled={!fx.enabled || fx.eq.bands.length >= AUDIO_FX_MAX_BANDS}
              className={`${ICON_BTN} flex items-center gap-1 text-xs disabled:opacity-40`}
              aria-label="添加频段"
              title={`最多 ${AUDIO_FX_MAX_BANDS} 段`}
            >
              <Plus size={13} /> 添加频段
            </button>
          </div>

          <div className={ROW}>
            <span className={LABEL}>前置增益</span>
            <input
              type="range"
              min={-12}
              max={12}
              step={0.5}
              value={fx.eq.preamp}
              disabled={!fx.enabled || !fx.eq.enabled}
              onChange={(e) => update({ eq: { ...fx.eq, preamp: Number(e.target.value) } })}
              onMouseUp={() => void commit(fxRef.current)}
              onTouchEnd={() => void commit(fxRef.current)}
              onKeyUp={() => void commit(fxRef.current)}
              className={SLIDER}
              aria-label="前置增益"
            />
            <span className="w-14 text-right text-[11px] tabular-nums">
              {fx.eq.preamp > 0 ? '+' : ''}
              {fx.eq.preamp.toFixed(1)} dB
            </span>
          </div>

          <div className="mt-1.5 space-y-1.5">
            {fx.eq.bands.map((band, i) => (
              // 窄屏（音乐模式只有 380px）必须一行放得下：频率用数字输入
              // （对数滑杆要占掉大半行），增益留滑杆（最常调的就是它）。
              <div key={i} className={ROW}>
                <input
                  type="number"
                  min={20}
                  max={20000}
                  step={10}
                  value={band.freq}
                  disabled={!fx.enabled || !fx.eq.enabled}
                  onChange={(e) => {
                    // 输入中途（如想打 1000 时的 "1"）不提交，否则会被夹到下限
                    const v = Number(e.target.value);
                    if (Number.isFinite(v) && v >= 20 && v <= 20000) updateBand(i, { freq: v });
                  }}
                  onBlur={() => void commit(fxRef.current)}
                  className="w-16 bg-input border border-border rounded px-1 py-0.5 text-[11px] tabular-nums focus-ring"
                  aria-label={`第 ${i + 1} 段频率 Hz`}
                  title={`${band.freq} Hz（${freqLabel(band.freq)}）`}
                />
                <input
                  type="range"
                  min={-12}
                  max={12}
                  step={0.5}
                  value={band.gain}
                  disabled={!fx.enabled || !fx.eq.enabled}
                  onChange={(e) => updateBand(i, { gain: Number(e.target.value) })}
                  onMouseUp={() => void commit(fxRef.current)}
                  onTouchEnd={() => void commit(fxRef.current)}
                  onKeyUp={() => void commit(fxRef.current)}
                  className={SLIDER}
                  aria-label={`第 ${i + 1} 段增益`}
                />
                <span className="w-9 text-right text-[11px] tabular-nums">
                  {band.gain > 0 ? '+' : ''}
                  {band.gain.toFixed(1)}
                </span>
                <input
                  type="range"
                  min={EQ_Q_MIN}
                  max={EQ_Q_MAX}
                  step={0.1}
                  value={band.q}
                  disabled={!fx.enabled || !fx.eq.enabled}
                  onChange={(e) => updateBand(i, { q: Number(e.target.value) })}
                  onMouseUp={() => void commit(fxRef.current)}
                  onTouchEnd={() => void commit(fxRef.current)}
                  onKeyUp={() => void commit(fxRef.current)}
                  className="w-10 accent-primary shrink-0"
                  aria-label={`第 ${i + 1} 段 Q 值`}
                  title={`Q ${band.q.toFixed(1)}`}
                />
                <button
                  type="button"
                  onClick={() => removeBand(i)}
                  disabled={!fx.enabled}
                  className={ICON_BTN}
                  aria-label={`删除第 ${i + 1} 段`}
                  title="删除该段"
                >
                  <X size={12} />
                </button>
              </div>
            ))}
            {fx.eq.bands.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">没有频段，点「添加频段」开始。</p>
            ) : null}
          </div>
        </section>

        {/* ---- 削波保护 ---- */}
        <section className={fx.enabled ? '' : 'opacity-50'}>
          <label className={`${ROW} cursor-pointer mb-1`}>
            <input
              type="checkbox"
              checked={fx.limiter.enabled}
              disabled={!fx.enabled}
              onChange={(e) => update({ limiter: { ...fx.limiter, enabled: e.target.checked } }, true)}
              className="w-4 h-4 accent-primary"
            />
            <span className="text-xs font-medium">削波保护</span>
            <span className="text-[10px] text-muted-foreground">抬起增益后压住爆音</span>
          </label>
          <div className={ROW}>
            <span className={LABEL}>天花板</span>
            <input
              type="range"
              min={-6}
              max={0}
              step={0.5}
              value={fx.limiter.ceiling}
              disabled={!fx.enabled || !fx.limiter.enabled}
              onChange={(e) => update({ limiter: { ...fx.limiter, ceiling: Number(e.target.value) } })}
              onMouseUp={() => void commit(fxRef.current)}
              onTouchEnd={() => void commit(fxRef.current)}
              onKeyUp={() => void commit(fxRef.current)}
              className={SLIDER}
              aria-label="削波保护天花板"
            />
            <span className="w-14 text-right text-[11px] tabular-nums">{fx.limiter.ceiling.toFixed(1)} dB</span>
          </div>
        </section>

        {/* ---- 声场 ---- */}
        <section className={fx.enabled ? '' : 'opacity-50'}>
          <p className="text-xs font-medium mb-1">声场</p>
          <div className={ROW}>
            <span className={LABEL}>宽度</span>
            <input
              type="range"
              min={0}
              max={2}
              step={0.05}
              value={fx.width}
              disabled={!fx.enabled}
              onChange={(e) => update({ width: Number(e.target.value) })}
              onMouseUp={() => void commit(fxRef.current)}
              onTouchEnd={() => void commit(fxRef.current)}
              onKeyUp={() => void commit(fxRef.current)}
              className={SLIDER}
              aria-label="立体声宽度"
            />
            <span className="w-14 text-right text-[11px] tabular-nums">{fx.width.toFixed(2)}</span>
          </div>
          <div className={ROW}>
            <span className={LABEL}>平衡</span>
            <input
              type="range"
              min={-1}
              max={1}
              step={0.05}
              value={fx.balance}
              disabled={!fx.enabled}
              onChange={(e) => update({ balance: Number(e.target.value) })}
              onMouseUp={() => void commit(fxRef.current)}
              onTouchEnd={() => void commit(fxRef.current)}
              onKeyUp={() => void commit(fxRef.current)}
              className={SLIDER}
              aria-label="声道平衡"
            />
            <span className="w-14 text-right text-[11px] tabular-nums">{balanceLabel(fx.balance)}</span>
          </div>
          <div className={ROW}>
            <span className={LABEL}>交叉馈送</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={fx.crossfeed}
              disabled={!fx.enabled}
              onChange={(e) => update({ crossfeed: Number(e.target.value) })}
              onMouseUp={() => void commit(fxRef.current)}
              onTouchEnd={() => void commit(fxRef.current)}
              onKeyUp={() => void commit(fxRef.current)}
              className={SLIDER}
              aria-label="耳机交叉馈送"
            />
            <span className="w-14 text-right text-[11px] tabular-nums">{Math.round(fx.crossfeed * 100)}%</span>
          </div>
        </section>

        {/* ---- 预设 ---- */}
        <section>
          <p className="text-xs font-medium mb-1">预设</p>
          <div className="flex flex-wrap gap-1.5">
            {[...BUILTIN_FX_PRESETS, ...presets].map((p) => (
              <span key={p.id} className="inline-flex items-center">
                <button
                  type="button"
                  onClick={() => applyPreset(p)}
                  className="px-2 py-1 text-[10px] border border-border rounded-l-lg hover:bg-accent focus-ring"
                >
                  {p.label}
                </button>
                {p.id.startsWith('custom-') ? (
                  <button
                    type="button"
                    onClick={() => void persistPresets(presets.filter((x) => x.id !== p.id), '预设已删除')}
                    aria-label={`删除预设 ${p.label}`}
                    className="px-1.5 py-1 text-[10px] border border-l-0 border-border rounded-r-lg text-muted-foreground hover:text-foreground hover:bg-accent focus-ring"
                  >
                    ×
                  </button>
                ) : null}
              </span>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2 mt-2">
            <input
              value={presetName}
              onChange={(e) => setPresetName(e.target.value)}
              placeholder="预设名称"
              aria-label="自定义预设名称"
              className="bg-input border border-border rounded-lg px-2 py-1 text-xs focus-ring w-32"
            />
            <button
              type="button"
              onClick={savePreset}
              className="px-3 py-1 text-xs rounded-lg border border-border hover:bg-accent focus-ring"
            >
              保存当前为预设
            </button>
          </div>
        </section>

        <button
          type="button"
          onClick={() => update(sanitizeAudioFx(AUDIO_FX_DEFAULT), true)}
          disabled={!fx.enabled}
          className="w-full px-3 py-1.5 text-xs border border-border rounded-lg hover:bg-accent focus-ring disabled:opacity-40"
        >
          全部复位
        </button>

        <p className="text-[10px] text-muted-foreground leading-relaxed">
          {engine === 'mpv'
            ? '当前是 mpv 音源：改 af 会重建音频滤镜链，为避免连续爆音，实际在松手后生效。'
            : '内置引擎改参数即时生效（直接改音频节点）。'}
          交叉馈送在 mpv 音源下是完整实现，内置引擎为简化近似。
        </p>
      </div>
    </div>
  );
}
