import { useEffect, useState, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Plus, Server as ServerIcon, Trash2, Pencil,
  CheckCircle2, XCircle, Library, ChevronLeft, FolderOpen, Globe,
} from 'lucide-react';
import { useToastStore } from '../../stores/toast-store';
import ServerForm from './ServerForm';
import { useServers } from './use-servers';
import SourceForm, { type SourceFormCaps, type SourceFormPayload } from './SourceForm';
import SourceList from './SourceList';
import type { SourceListEntry, ScanProgressEvent, SourcePurpose } from '../../../shared/types';

/** Shared section header: icon chip + title + count + primary action. */
function SectionHeader({
  icon, title, count, actionLabel, actionOpen, onAction,
}: {
  icon: React.ReactNode;
  title: string;
  count: number;
  actionLabel: string;
  actionOpen: boolean;
  onAction: () => void;
}) {
  return (
    <div className="flex items-center justify-between mb-5">
      <div className="flex items-center gap-3">
        <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-primary/10 text-primary">
          {icon}
        </div>
        <div>
          <h2 className="text-sm font-semibold flex items-center gap-2">
            {title}
            <span className="px-1.5 py-0.5 rounded-md bg-secondary text-secondary-foreground text-[10px] font-medium">
              {count}
            </span>
          </h2>
        </div>
      </div>
      <button
        onClick={onAction}
        className="flex items-center gap-1.5 px-3 py-1.5 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 active:scale-[0.98] transition-all text-sm font-medium focus-ring"
      >
        <Plus size={14} />
        {actionOpen ? '取消' : actionLabel}
      </button>
    </div>
  );
}

/** 媒体库管理页：Jellyfin/Emby 服务器 + 本地/WebDAV 来源（U-002；QYP3-040 按模式拆分）。 */
export default function MediaSourcesPage({ mode }: { mode: 'video' | 'music' }) {
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

  // ---- Media servers (Jellyfin / Emby) — 状态与行为在 useServers ----
  const {
    servers,
    editing: editingServer,
    form: serverForm,
    formError: serverFormError,
    showForm: showServerForm,
    saving: savingServer,
    testing: testingServer,
    setForm: setServerForm,
    edit: handleServerEdit,
    remove: handleServerRemove,
    save: handleServerSave,
    test: handleServerTest,
    toggleForm: handleServerToggleForm,
    closeForm: handleServerCloseForm,
  } = useServers(addToast);

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

  // QYP3-041：来源按域严格分离——一个来源只属于一个模式，不做交叉显示。
  const ownPurpose: SourcePurpose = mode === 'video' ? 'video' : 'music';
  const visibleSources = useMemo(
    () => sources.filter((s) => s.purpose === ownPurpose),
    [ownPurpose, sources]
  );
  // QYP3-055：转域入口——不属于本域的目录/WebDAV 来源列在下方，可一键转过来。
  // 动机是拆域（QYP3-041）的存量遗留：拆域前扫出的音轨挂在被归一成影视的
  // 来源上，音乐列表按域过滤后它们从此不可见，用户需要一个恢复入口。
  const foreignSources = useMemo(
    () =>
      sources.filter(
        (s) => s.purpose !== ownPurpose && (s.kind === 'local' || s.kind === 'webdav')
      ),
    [ownPurpose, sources]
  );
  const [convertingId, setConvertingId] = useState<number | null>(null);

  const handleConvertPurpose = useCallback(
    async (source: SourceListEntry) => {
      const target: SourcePurpose = ownPurpose;
      const targetLabel = target === 'music' ? '音乐来源' : '影视来源';
      const confirmed = window.confirm(
        `把「${source.name}」改为${targetLabel}？已扫描的索引不会重扫，` +
          `转换后它会从${target === 'music' ? '影视' : '音乐'}模式的媒体库里消失。`
      );
      if (!confirmed) return;
      setConvertingId(source.id);
      try {
        const res = (await window.electronAPI.setSourcePurpose(source.id, target)) as {
          ok: boolean;
          error?: { message: string };
        };
        if (res.ok) {
          addToast(`「${source.name}」已改为${targetLabel}`, 'success');
          await loadSources();
        } else {
          addToast(res.error?.message ?? '转换失败', 'error');
        }
      } catch {
        addToast('转换失败', 'error');
      } finally {
        setConvertingId(null);
      }
    },
    [ownPurpose, addToast, loadSources]
  );

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

  /** Shared empty state: icon circle + text + CTA (a11y: role=status). */
  const EmptyState = ({ icon, text }: { icon: React.ReactNode; text: string }) => (
    <div role="status" className="text-center py-12">
      <div className="w-12 h-12 mx-auto mb-3 flex items-center justify-center rounded-full bg-secondary text-muted-foreground">
        {icon}
      </div>
      <p className="text-sm text-muted-foreground max-w-sm mx-auto leading-relaxed">{text}</p>
    </div>
  );

  return (
    <div className="p-8 max-w-3xl">
      <button
        onClick={() => navigate(-1)}
        className="inline-flex items-center gap-1 px-2 py-1 -ml-2 text-sm text-muted-foreground hover:text-foreground rounded-md transition-colors focus-ring"
      >
        <ChevronLeft size={16} />
        返回
      </button>

      {/* Page header */}
      <header className="flex items-center gap-4 mb-8 mt-2">
        <div className="flex items-center justify-center w-12 h-12 rounded-xl bg-primary/10 text-primary">
          <Library size={22} />
        </div>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            {mode === 'video' ? '媒体库' : '音乐媒体库'}
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {mode === 'video'
              ? '管理媒体服务器（Jellyfin / Emby）与影视来源（本地目录 / WebDAV）；浏览与播放请到「本地」或「首页」。'
              : '管理音乐来源（本地目录 / WebDAV）；浏览与播放请到「音乐」。音乐与影视不共用一个目录——影视来源请到影视模式的「媒体库」添加。'}
          </p>
        </div>
      </header>

      {/* Media servers (Jellyfin / Emby) — 只在影视模式管理（QYP3-041）：
          同一个服务器同时提供影视与音乐，配置入口保留一份即可。 */}
      {mode === 'video' ? (
        <section className="mb-12" aria-label="媒体服务器">
        <SectionHeader
          icon={<ServerIcon size={17} />}
          title="媒体服务器"
          count={servers.length}
          actionLabel="添加"
          actionOpen={showServerForm}
          onAction={handleServerToggleForm}
        />

        {showServerForm && (
          <ServerForm
            form={serverForm}
            onChange={setServerForm}
            onTest={handleServerTest}
            onSave={handleServerSave}
            onCancel={handleServerCloseForm}
            testing={testingServer}
            saving={savingServer}
            formError={serverFormError}
            isEditing={!!editingServer}
            hasCredential={editingServer?.hasCredential}
          />
        )}

        <div className="space-y-2">
          {servers.map((server) => (
            <div
              key={server.id}
              className={`flex items-center gap-3 p-4 bg-card border rounded-xl transition-colors ${
                editingServer?.id === server.id
                  ? 'border-primary/50'
                  : 'border-border hover:border-primary/30'
              }`}
            >
              <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-primary/10 text-primary text-xs font-bold flex-shrink-0">
                {server.type.slice(0, 2).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-sm">{server.name}</span>
                  {server.hasCredential ? (
                    <span
                      className="flex items-center gap-0.5 text-[10px] text-emerald-500"
                      title="已登录"
                    >
                      <CheckCircle2 size={12} />
                      已登录
                    </span>
                  ) : (
                    <span
                      className="flex items-center gap-0.5 text-[10px] text-muted-foreground"
                      title="未登录，点击编辑以配置账号"
                    >
                      <XCircle size={12} />
                      未登录
                    </span>
                  )}
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-secondary text-secondary-foreground text-[10px] font-medium mr-2">
                    {server.type.toUpperCase()}
                  </span>
                  {server.base_url}
                  {server.username && ` · ${server.username}`}
                </div>
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                <button
                  onClick={() => handleServerEdit(server)}
                  className="p-2 text-muted-foreground hover:text-foreground hover:bg-accent rounded-lg transition-colors focus-ring"
                  aria-label={`编辑 ${server.name}`}
                >
                  <Pencil size={15} />
                </button>
                <button
                  onClick={() => void handleServerRemove(server)}
                  className="p-2 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-lg transition-colors focus-ring"
                  aria-label={`删除 ${server.name}`}
                >
                  <Trash2 size={15} />
                </button>
              </div>
            </div>
          ))}
          {servers.length === 0 && !showServerForm && (
            <EmptyState
              icon={<ServerIcon size={20} />}
              text="暂无服务器，点击上方「添加」按钮连接 Jellyfin / Emby"
            />
          )}
        </div>
      </section>
      ) : (
        <p className="mb-10 -mt-2 text-xs text-muted-foreground">
          媒体服务器（Jellyfin / Emby）在影视模式的「媒体库」里管理，这里只管音乐来源。
        </p>
      )}

      {/* Media sources (local + WebDAV) */}
      <section className="mb-12" aria-label="媒体来源">
        <SectionHeader
          icon={<FolderOpen size={17} />}
          title={mode === 'video' ? '媒体来源' : '音乐来源'}
          count={visibleSources.length}
          actionLabel="添加来源"
          actionOpen={showSourceForm}
          onAction={() => setShowSourceForm((v) => !v)}
        />

        {showSourceForm && (
          <SourceForm
            key={mode}
            purpose={ownPurpose}
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
          sources={visibleSources}
          scanningIds={scanningIds}
          liveProgress={liveProgress}
          onScanToggle={handleScanToggle}
          onRemove={handleSourceRemove}
        />
        {visibleSources.length === 0 && !showSourceForm && (
          <EmptyState
            icon={<Globe size={20} />}
            text={
              mode === 'video'
                ? '暂无来源。点击上方「添加来源」，可选择本地目录，或填写 WebDAV 服务器地址（支持 Nextcloud / Alist 等）。'
                : '暂无音乐来源。点击上方「添加来源」，把只放音乐的目录或 WebDAV 目录加进来（不要与影视混放）。'
            }
          />
        )}
      </section>

      {/* 转域入口（QYP3-055）：不属于本域的目录/WebDAV 来源，可一键改过来 */}
      {foreignSources.length > 0 && (
        <section aria-label="其它来源">
          <h2 className="text-sm font-semibold text-muted-foreground mb-1">
            {ownPurpose === 'music' ? '影视来源' : '音乐来源'}
            <span className="ml-2 text-xs font-normal">
              以下来源属于{ownPurpose === 'music' ? '影视' : '音乐'}域，不出现在
              {ownPurpose === 'music' ? '音乐' : '影视'}列表里
            </span>
          </h2>
          <p className="text-xs text-muted-foreground mb-3 leading-relaxed max-w-2xl">
            {ownPurpose === 'music'
              ? '如果某个来源其实只放音乐，可以把它改为音乐来源：已扫描的音轨会立即回到音乐列表（无需重扫），来源也会挪到这里管理。'
              : '如果某个来源其实以影视为主，可以把它改为影视来源：已扫描的视频索引会回到影视模式（无需重扫）。'}
          </p>
          <div className="space-y-2">
            {foreignSources.map((source) => (
              <div
                key={source.id}
                className="flex items-center gap-3 p-4 bg-card/60 border border-dashed border-border rounded-xl"
              >
                <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-secondary text-muted-foreground flex-shrink-0">
                  {source.kind === 'webdav' ? <Globe size={16} /> : <FolderOpen size={16} />}
                </div>
                <div className="min-w-0 flex-1">
                  <span className="font-medium text-sm">{source.name}</span>
                  <div className="text-xs text-muted-foreground mt-0.5 truncate">{source.root}</div>
                </div>
                <button
                  type="button"
                  onClick={() => void handleConvertPurpose(source)}
                  disabled={convertingId === source.id}
                  className="flex-shrink-0 px-3 py-1.5 text-sm font-medium rounded-lg border border-border hover:bg-accent hover:text-foreground transition-colors focus-ring disabled:opacity-50"
                >
                  {convertingId === source.id
                    ? '转换中…'
                    : ownPurpose === 'music'
                      ? '改为音乐来源'
                      : '改为影视来源'}
                </button>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
