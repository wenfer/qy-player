import { useState, useCallback, useEffect, useRef } from 'react';
import { Keyboard, RotateCcw, Pencil, Check, X, Monitor, Play, Lock } from 'lucide-react';
import { useToastStore } from '../../stores/toast-store';
import {
  GLOBAL_SHORTCUTS,
  MPV_BINDINGS,
  MPV_FIXED_SHORTCUTS,
  type ShortcutDef,
  type MpvBindingDef,
} from '../../../shared/shortcut-defs';

type Overrides = Record<string, string>;

/** Map a DOM KeyboardEvent to an Electron accelerator / mpv key string. */
function normalizeKey(e: KeyboardEvent): string | null {
  const k = e.key;
  if (['Control', 'Shift', 'Alt', 'Meta', 'Hyper', 'Super'].includes(k)) return null; // pure modifier
  if (k === ' ') return 'Space';
  const map: Record<string, string> = {
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    Escape: 'Esc', PageUp: 'PageUp', PageDown: 'PageDown',
  };
  if (map[k]) return map[k];
  if (k.length === 1) return k.toUpperCase();
  return k; // F1..F24, Enter, Tab, media keys pass through as-is
}

function eventToAccelerator(e: KeyboardEvent): string | null {
  const key = normalizeKey(e);
  if (!key) return null;
  const mods: string[] = [];
  if (e.ctrlKey || e.metaKey) mods.push('CommandOrControl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  return [...mods, key].join('+');
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex items-center px-1.5 py-0.5 bg-muted border border-border rounded text-[11px] font-medium text-foreground">
      {children}
    </kbd>
  );
}

type Recording = { scope: 'global' | 'mpv'; id: string } | null;

export default function ShortcutsPage() {
  const addToast = useToastStore((s) => s.addToast);
  const [globalOverrides, setGlobalOverrides] = useState<Overrides>({});
  const [mpvOverrides, setMpvOverrides] = useState<Overrides>({});
  const [loading, setLoading] = useState(true);
  const [recording, setRecording] = useState<Recording>(null);
  const [captured, setCaptured] = useState<string | null>(null);
  const globalRef = useRef<Overrides>({});
  const mpvRef = useRef<Overrides>({});
  globalRef.current = globalOverrides;
  mpvRef.current = mpvOverrides;

  useEffect(() => {
    (async () => {
      try {
        const [g, m] = await Promise.all([
          window.electronAPI.getSettings('shortcuts'),
          window.electronAPI.getSettings('mpv-shortcuts'),
        ]);
        if (g) setGlobalOverrides(JSON.parse(g));
        if (m) setMpvOverrides(JSON.parse(m));
      } catch {
        // Fall back to defaults
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Capture keydown while recording
  useEffect(() => {
    if (!recording) return;
    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        setRecording(null);
        setCaptured(null);
        return;
      }
      const acc = eventToAccelerator(e);
      if (acc) setCaptured(acc);
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [recording]);

  const labelsOf = useCallback(
    (scope: 'global' | 'mpv', ids: string[]) =>
      ids
        .map((id) =>
          scope === 'global'
            ? GLOBAL_SHORTCUTS.find((d) => d.id === id)?.label || id
            : MPV_BINDINGS.find((d) => d.id === id)?.label || id
        )
        .join('、'),
    []
  );

  /** Apply + persist global bindings. Returns false on conflict (reverted). */
  const applyGlobal = useCallback(
    async (next: Overrides) => {
      const res = (await window.electronAPI.applyShortcuts(next)) as { failed?: string[] };
      if (res?.failed?.length) {
        await window.electronAPI.applyShortcuts(globalRef.current);
        addToast(`快捷键被其他应用占用或重复：${labelsOf('global', res.failed)}`, 'error');
        return false;
      }
      setGlobalOverrides(next);
      await window.electronAPI.setSettings('shortcuts', next);
      return true;
    },
    [addToast, labelsOf]
  );

  /** Apply + persist MPV bindings. Returns false on conflict (reverted). */
  const applyMpv = useCallback(
    async (next: Overrides) => {
      const res = (await window.electronAPI.applyMpvShortcuts(next)) as {
        ok: boolean;
        conflicts?: string[];
        hotReloaded?: boolean;
      };
      if (!res?.ok) {
        addToast(`按键重复：${labelsOf('mpv', res?.conflicts || [])}`, 'error');
        return false;
      }
      setMpvOverrides(next);
      await window.electronAPI.setSettings('mpv-shortcuts', next);
      addToast(res.hotReloaded ? 'MPV 按键已实时生效' : '已保存，下次启动播放器后生效', 'success');
      return true;
    },
    [addToast, labelsOf]
  );

  const confirmGlobal = useCallback(
    async (def: ShortcutDef) => {
      if (!captured) return;
      if (await applyGlobal({ ...globalRef.current, [def.id]: captured })) {
        addToast(`已更新「${def.label}」为 ${captured}`, 'success');
      }
      setRecording(null);
      setCaptured(null);
    },
    [captured, applyGlobal, addToast]
  );

  const confirmMpv = useCallback(
    async (def: MpvBindingDef) => {
      if (!captured) return;
      if (await applyMpv({ ...mpvRef.current, [def.id]: captured })) {
        // success toast already shown by applyMpv
      }
      setRecording(null);
      setCaptured(null);
    },
    [captured, applyMpv]
  );

  const handleResetAll = useCallback(async () => {
    const g: Overrides = {};
    for (const def of GLOBAL_SHORTCUTS) g[def.id] = def.defaultAccelerator;
    const m: Overrides = {};
    for (const def of MPV_BINDINGS) m[def.id] = def.defaultKeys;
    const okG = await applyGlobal(g);
    const okM = await applyMpv(m);
    if (okG && okM) addToast('已恢复全部默认快捷键', 'success');
  }, [applyGlobal, applyMpv, addToast]);

  const isRecording = (scope: 'global' | 'mpv', id: string) =>
    recording?.scope === scope && recording.id === id;

  const renderRecordingControls = (scope: 'global' | 'mpv', id: string) => (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted-foreground">
        {captured ? '按确认保存' : '请按下新的按键…'}
      </span>
      {captured && <Kbd>{captured}</Kbd>}
      <span className="text-[10px] text-muted-foreground">Esc 取消</span>
      <button
        onClick={() => (scope === 'global'
          ? confirmGlobal(GLOBAL_SHORTCUTS.find((d) => d.id === id)!)
          : confirmMpv(MPV_BINDINGS.find((d) => d.id === id)!))}
        disabled={!captured}
        className="p-1.5 rounded-lg bg-primary text-primary-foreground disabled:opacity-40 focus-ring"
        aria-label="确认"
      >
        <Check size={14} />
      </button>
      <button
        onClick={() => { setRecording(null); setCaptured(null); }}
        className="p-1.5 rounded-lg hover:bg-accent focus-ring"
        aria-label="取消"
      >
        <X size={14} />
      </button>
    </div>
  );

  return (
    <div className="p-8 max-w-3xl">
      <header className="mb-8 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Keyboard size={22} className="text-muted-foreground" />
          <div>
            <h1 className="text-2xl font-bold tracking-tight">快捷键</h1>
            <p className="text-sm text-muted-foreground mt-0.5">查看与自定义播放控制快捷键</p>
          </div>
        </div>
        <button
          onClick={handleResetAll}
          disabled={loading}
          className="flex items-center gap-1.5 px-3 py-2 text-sm border border-border rounded-lg hover:bg-accent transition-colors focus-ring disabled:opacity-50"
        >
          <RotateCcw size={14} />
          恢复默认
        </button>
      </header>

      {/* Global shortcuts - editable */}
      <section className="mb-10" aria-label="全局快捷键">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-4">
          <Monitor size={14} />
          全局快捷键（系统级，应用在后台也生效）
        </h2>
        <div className="space-y-2">
          {GLOBAL_SHORTCUTS.map((def) => (
            <div
              key={def.id}
              className="flex items-center gap-4 p-3 bg-card border border-border rounded-xl"
            >
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium">{def.label}</div>
                <p className="text-xs text-muted-foreground mt-0.5">{def.description}</p>
              </div>
              {isRecording('global', def.id) ? (
                renderRecordingControls('global', def.id)
              ) : (
                <div className="flex items-center gap-2">
                  <Kbd>{globalOverrides[def.id] || def.defaultAccelerator}</Kbd>
                  {!def.fixed && (
                    <button
                      onClick={() => { setRecording({ scope: 'global', id: def.id }); setCaptured(null); }}
                      className="p-1.5 rounded-lg hover:bg-accent text-muted-foreground hover:text-foreground focus-ring"
                      aria-label={`修改 ${def.label}`}
                      title="修改"
                    >
                      <Pencil size={13} />
                    </button>
                  )}
                  {globalOverrides[def.id] && globalOverrides[def.id] !== def.defaultAccelerator && (
                    <button
                      onClick={() => applyGlobal({ ...globalRef.current, [def.id]: def.defaultAccelerator })}
                      className="p-1.5 rounded-lg hover:bg-accent text-muted-foreground hover:text-foreground focus-ring"
                      aria-label={`恢复默认 ${def.label}`}
                      title="恢复默认"
                    >
                      <RotateCcw size={13} />
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
        <p className="text-[11px] text-muted-foreground mt-2 leading-relaxed">
          提示：多媒体键（播放/暂停、快进、后退）无法在应用内录制，保持系统默认即可；若提示被占用，说明组合键已被其他应用注册。
        </p>
      </section>

      {/* MPV window bindings - editable */}
      <section className="mb-6" aria-label="播放窗口快捷键">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-4">
          <Play size={14} />
          播放窗口快捷键（MPV 窗口内，修改后实时生效）
        </h2>
        <div className="space-y-2">
          {MPV_BINDINGS.map((def) => (
            <div
              key={def.id}
              className="flex items-center gap-4 p-3 bg-card border border-border rounded-xl"
            >
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium">{def.label}</div>
              </div>
              {isRecording('mpv', def.id) ? (
                renderRecordingControls('mpv', def.id)
              ) : (
                <div className="flex items-center gap-2">
                  <Kbd>{mpvOverrides[def.id] || def.defaultKeys}</Kbd>
                  <button
                    onClick={() => { setRecording({ scope: 'mpv', id: def.id }); setCaptured(null); }}
                    className="p-1.5 rounded-lg hover:bg-accent text-muted-foreground hover:text-foreground focus-ring"
                    aria-label={`修改 ${def.label}`}
                    title="修改"
                  >
                    <Pencil size={13} />
                  </button>
                  {mpvOverrides[def.id] && mpvOverrides[def.id] !== def.defaultKeys && (
                    <button
                      onClick={() => applyMpv({ ...mpvRef.current, [def.id]: def.defaultKeys })}
                      className="p-1.5 rounded-lg hover:bg-accent text-muted-foreground hover:text-foreground focus-ring"
                      aria-label={`恢复默认 ${def.label}`}
                      title="恢复默认"
                    >
                      <RotateCcw size={13} />
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* Fixed MPV bindings - display only */}
      <section aria-label="固定按键">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-4">
          <Lock size={14} />
          固定按键（不可修改）
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {MPV_FIXED_SHORTCUTS.map((s) => (
            <div
              key={s.keys}
              className="flex items-center justify-between gap-3 px-3 py-2 bg-card border border-border rounded-lg"
            >
              <span className="text-xs text-muted-foreground">{s.label}</span>
              <div className="flex items-center gap-1 flex-shrink-0">
                {s.keys.split(' ').map((part, i) =>
                  part === '/' || part === '+' || part === '~' ? (
                    <span key={i} className="text-muted-foreground text-xs">{part}</span>
                  ) : (
                    <Kbd key={i}>{part}</Kbd>
                  )
                )}
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
