import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, HardDrive } from 'lucide-react';
import { useToastStore } from '../../stores/toast-store';
import SourceForm, { type SourceFormCaps, type SourceFormPayload } from './SourceForm';
import SourceList from './SourceList';
import type { SourceListEntry, ScanProgressEvent } from '../../../shared/types';

/**
 * 媒体库管理页（用户要求：设置页仅保留软件配置，来源管理独立成页）。
 * 本地目录与 WebDAV 来源的添加、连接测试、扫描和移除都在这里。
 */
export default function MediaSources() {
  const navigate = useNavigate();
  const addToast = useToastStore((s) => s.addToast);
  const [sources, setSources] = useState<SourceListEntry[]>([]);
  // Default false: never promise encryption before main confirms it.
  const [persistentSecrets, setPersistentSecrets] = useState(false);
  const [showSourceForm, setShowSourceForm] = useState(false);
  const [savingSource, setSavingSource] = useState(false);
  const [testingSource, setTestingSource] = useState(false);
  const [sourceFormError, setSourceFormError] = useState<string | null>(null);
  const [scanningIds, setScanningIds] = useState<Set<number>>(new Set());
  const [liveProgress, setLiveProgress] = useState<Record<number, ScanProgressEvent>>({});

  useEffect(() => {
    window.electronAPI
      .isSecretsPersistent()
      .then((v: boolean) => setPersistentSecrets(v))
      .catch(() => setPersistentSecrets(false));
  }, []);

  const loadSources = useCallback(async () => {
    try {
      const data = await window.electronAPI.listSources();
      setSources(data as SourceListEntry[]);
    } catch {
      addToast('加载媒体来源失败', 'error');
    }
  }, [addToast]);

  useEffect(() => {
    loadSources();
  }, [loadSources]);

  // Scan progress push: refresh the list on events (<= 4Hz) and turn
  // terminal states into toasts.
  useEffect(() => {
    const unsubscribe = window.electronAPI.onScanProgress((event) => {
      const e = event as ScanProgressEvent;
      setLiveProgress((prev) => ({ ...prev, [e.sourceId]: e }));
      if (e.state === 'completed' || e.state === 'cancelled' || e.state === 'failed' || e.state === 'interrupted') {
        setScanningIds((prev) => {
          const next = new Set(prev);
          next.delete(e.sourceId);
          return next;
        });
        if (e.state === 'completed') addToast('扫描完成', 'success');
        else if (e.state === 'failed') addToast(`扫描失败${e.message ? `：${e.message}` : ''}`, 'error');
        else addToast('扫描已停止', 'info');
        loadSources();
      }
    });
    return unsubscribe;
  }, [addToast, loadSources]);

  const handleSourceTest = useCallback(
    async (
      payload: SourceFormPayload
    ): Promise<{ ok: boolean; capabilities?: SourceFormCaps; error?: string } | null> => {
      setTestingSource(true);
      try {
        const res = (await window.electronAPI.testSource(payload)) as {
          ok: boolean;
          data?: { canSeek: boolean; canDelete: boolean; supportsEtag: boolean; supportsRange: boolean };
          error?: { message: string };
        };
        return res.ok ? { ok: true, capabilities: res.data } : { ok: false, error: res.error?.message ?? '连接不可用' };
      } catch {
        return { ok: false, error: '测试请求失败' };
      } finally {
        setTestingSource(false);
      }
    },
    []
  );

  const handleSourceSave = useCallback(
    async (payload: SourceFormPayload): Promise<boolean> => {
      if (payload.kind === 'local' && !payload.root) {
        setSourceFormError('请先选择目录');
        return false;
      }
      if (payload.kind === 'webdav' && !payload.url.trim()) {
        setSourceFormError('请先填写服务器地址');
        return false;
      }
      setSavingSource(true);
      setSourceFormError(null);
      try {
        const res = (await window.electronAPI.saveSource(payload)) as {
          ok: boolean;
          data?: { sourceId: number };
          error?: { message: string };
        };
        if (res.ok) {
          addToast('来源已添加', 'success');
          await loadSources();
          return true;
        }
        setSourceFormError(res.error?.message ?? '添加失败');
        return false;
      } catch {
        setSourceFormError('添加失败');
        return false;
      } finally {
        setSavingSource(false);
      }
    },
    [addToast, loadSources]
  );

  const handleSourceRemove = useCallback(
    async (source: SourceListEntry) => {
      const confirmed = window.confirm(
        `仅移除「${source.name}」的索引记录，不会删除磁盘上的媒体文件。确定移除？`
      );
      if (!confirmed) return;
      const res = (await window.electronAPI.removeSource(source.id)) as {
        ok: boolean;
        error?: { message: string };
      };
      if (res.ok) {
        addToast('来源已移除（媒体文件未受影响）', 'success');
        await loadSources();
      } else {
        addToast(res.error?.message ?? '移除失败', 'error');
      }
    },
    [addToast, loadSources]
  );

  const handleScanToggle = useCallback(
    async (source: SourceListEntry) => {
      if (scanningIds.has(source.id)) {
        const res = (await window.electronAPI.cancelScan(source.id)) as { ok: boolean; error?: { message: string } };
        if (!res.ok) addToast(res.error?.message ?? '取消失败', 'error');
        return;
      }
      const res = (await window.electronAPI.startScan(source.id)) as { ok: boolean; error?: { message: string } };
      if (res.ok) {
        setScanningIds((prev) => new Set(prev).add(source.id));
        addToast('扫描已开始', 'info');
        loadSources();
      } else {
        addToast(res.error?.message ?? '扫描启动失败', 'error');
      }
    },
    [scanningIds, addToast, loadSources]
  );

  return (
    <div className="p-8 max-w-3xl">
      <button
        onClick={() => navigate(-1)}
        className="text-sm text-muted-foreground hover:text-foreground mb-4 transition-colors focus-ring rounded-md py-1"
      >
        返回
      </button>
      <h1 className="text-2xl font-bold tracking-tight mb-2">媒体库</h1>
      <p className="text-sm text-muted-foreground mb-8">
        管理本地目录与 WebDAV 来源：添加后即可扫描索引，浏览与播放入口在媒体库浏览页。
      </p>

      <section className="mb-10" aria-label="媒体来源">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
            <HardDrive size={14} />
            媒体来源
          </h2>
          <button
            onClick={() => setShowSourceForm((v) => !v)}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors text-sm font-medium focus-ring"
          >
            <Plus size={14} />
            {showSourceForm ? '取消' : '添加来源'}
          </button>
        </div>

        {showSourceForm && (
          <SourceForm
            saving={savingSource}
            testing={testingSource}
            formError={sourceFormError}
            persistentSecrets={persistentSecrets}
            onPick={() => window.electronAPI.pickDirectory()}
            onTest={handleSourceTest}
            onSave={handleSourceSave}
            onCancel={() => {
              setShowSourceForm(false);
              setSourceFormError(null);
            }}
          />
        )}

        <SourceList
          sources={sources}
          scanningIds={scanningIds}
          liveProgress={liveProgress}
          onScanToggle={handleScanToggle}
          onRemove={handleSourceRemove}
        />
        {sources.length === 0 && !showSourceForm && (
          <div className="text-center py-10 text-muted-foreground text-sm">
            暂无来源。点击上方「添加来源」，可选择本地目录，或填写 WebDAV 服务器地址（支持 Nextcloud / Alist 等）。
          </div>
        )}
      </section>
    </div>
  );
}
