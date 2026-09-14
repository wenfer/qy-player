import { useCallback, useEffect, useState } from 'react';
import { Timer, RotateCcw } from 'lucide-react';
import { useToastStore } from '../../stores/toast-store';

/**
 * 剧集自定义片头/片尾（整剧生效）：服务器识别不可用（Emby/旧版
 * Jellyfin/未开启片头检测）时的人工设定。存 SQLite skip_overrides
 * （migration 006，scope=series，按 serverId 精确隔离）。
 * 输入为秒数；片头/片尾各自独立保存，留空 = 清除该类型。
 */
interface RangeInput {
  start: string;
  end: string;
}

const EMPTY = { start: '', end: '' };

export default function SkipOverrideEditor({
  serverType,
  serverId,
  itemId,
  seriesName,
}: {
  serverType: string;
  serverId: number;
  itemId: string;
  seriesName: string;
}) {
  const addToast = useToastStore((s) => s.addToast);
  const [intro, setIntro] = useState<RangeInput>(EMPTY);
  const [outro, setOutro] = useState<RangeInput>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setLoaded(false);
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
        const o = res.ok ? res.data?.override : null;
        setIntro(o?.intro ? { start: String(Math.floor(o.intro.start)), end: String(Math.floor(o.intro.end)) } : EMPTY);
        setOutro(o?.outro ? { start: String(Math.floor(o.outro.start)), end: String(Math.floor(o.outro.end)) } : EMPTY);
      } catch {
        // 读取失败按空处理，可重新设定
      } finally {
        setLoaded(true);
      }
    })();
  }, [serverType, serverId, itemId, seriesName]);

  const parseRange = useCallback((r: RangeInput): { start: number; end: number } | null | 'invalid' => {
    const start = Number(r.start);
    const end = Number(r.end);
    if (r.start === '' && r.end === '') return null; // 留空 = 清除
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) return 'invalid'; // 半填/非法
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

  if (!loaded) return null;

  const field = (
    label: string,
    state: RangeInput,
    setState: (v: RangeInput) => void,
    valid: boolean
  ) => (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-muted-foreground w-10">{label}</span>
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

  return (
    <div className="mt-8">
      <h3 className="text-sm font-semibold mb-3 flex items-center gap-1.5">
        <Timer size={14} className="text-muted-foreground" />
        片头/片尾设定
      </h3>
      <div className="bg-card border border-border rounded-xl p-4 flex flex-col gap-3 max-w-xl">
        {field('片头', intro, setIntro, validIntro)}
        {field('片尾', outro, setOutro, validOutro)}
        <p className="text-[10px] text-muted-foreground leading-relaxed">
          以秒为单位填写；留空即清除该设定。整部剧生效，下次播放时在片头/片尾段内自动跳过。
        </p>
        <div className="flex gap-2">
          <button
            onClick={() => void save()}
            disabled={saving}
            className="px-3 py-1.5 text-xs bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 focus-ring disabled:opacity-50"
          >
            保存设定
          </button>
          <button
            onClick={() => void reset()}
            disabled={saving}
            className="px-3 py-1.5 text-xs border border-border rounded-lg hover:bg-accent focus-ring flex items-center gap-1 disabled:opacity-50"
          >
            <RotateCcw size={12} /> 恢复默认
          </button>
        </div>
      </div>
    </div>
  );
}
