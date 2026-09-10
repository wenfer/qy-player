import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, HardDrive, Server as ServerIcon, Trash2, Pencil, CheckCircle2, XCircle } from 'lucide-react';
import { useToastStore } from '../../stores/toast-store';
import ServerForm, { ServerForm as ServerFormValues } from './ServerForm';
import SourceForm, { type SourceFormCaps, type SourceFormPayload } from './SourceForm';
import SourceList from './SourceList';
import type { SourceListEntry, ScanProgressEvent } from '../../../shared/types';

interface AuthResult {
  ok: boolean;
  userId?: string;
  error?: string;
}

interface SavedServer {
  id: number;
  type: string;
  name: string;
  base_url: string;
  /** True when a usable credential exists in the main-process SecretStore. */
  hasCredential?: boolean;
  username?: string;
  user_id?: string;
  is_active: number;
}

const EMPTY_SERVER_FORM: ServerFormValues = {
  type: 'jellyfin',
  name: '',
  baseUrl: '',
  username: '',
  password: '',
};

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

  // ---- Media servers (Jellyfin / Emby) — migrated from Settings (U-002) ----
  const [servers, setServers] = useState<SavedServer[]>([]);
  const [showServerForm, setShowServerForm] = useState(false);
  const [editingServer, setEditingServer] = useState<SavedServer | null>(null);
  const [testingServer, setTestingServer] = useState(false);
  const [savingServer, setSavingServer] = useState(false);
  const [serverForm, setServerForm] = useState<ServerFormValues>(EMPTY_SERVER_FORM);
  const [serverFormError, setServerFormError] = useState<string | null>(null);

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

  const loadServers = useCallback(async () => {
    try {
      const data = await window.electronAPI.getServers();
      setServers(data as SavedServer[]);
    } catch {
      addToast('加载服务器列表失败', 'error');
    }
  }, [addToast]);

  useEffect(() => {
    loadServers();
  }, [loadServers]);

  const resetServerForm = useCallback(() => {
    setServerForm(EMPTY_SERVER_FORM);
    setServerFormError(null);
    setEditingServer(null);
  }, []);

  const handleServerAdd = () => {
    if (showServerForm) {
      setShowServerForm(false);
      resetServerForm();
    } else {
      resetServerForm();
      setShowServerForm(true);
    }
  };

  const handleServerEdit = (server: SavedServer) => {
    setServerForm({
      type: server.type as 'jellyfin' | 'emby',
      name: server.name,
      baseUrl: server.base_url,
      username: server.username || '',
      password: '',
    });
    setEditingServer(server);
    setServerFormError(null);
    setShowServerForm(true);
  };

  const handleServerTest = async () => {
    if (!serverForm.baseUrl.trim()) {
      setServerFormError('请输入服务器地址');
      return;
    }
    setTestingServer(true);
    setServerFormError(null);
    try {
      const result = (await window.electronAPI.testServer({
        type: serverForm.type,
        baseUrl: serverForm.baseUrl.trim(),
        username: serverForm.username || undefined,
        password: serverForm.password || undefined,
      })) as AuthResult;

      if (result?.ok) {
        addToast(serverForm.username ? '连接成功，登录凭证有效' : '服务器可达', 'success');
      } else {
        setServerFormError(result?.error || '连接失败');
      }
    } catch (err) {
      setServerFormError(`连接错误: ${err instanceof Error ? err.message : '未知错误'}`);
    } finally {
      setTestingServer(false);
    }
  };

  const authenticateServer = async (): Promise<AuthResult> => {
    const result = (await window.electronAPI.testServer({
      type: serverForm.type,
      baseUrl: serverForm.baseUrl,
      username: serverForm.username || undefined,
      password: serverForm.password || undefined,
    })) as AuthResult;
    return result;
  };

  const handleServerSave = async () => {
    if (!serverForm.name || !serverForm.baseUrl) {
      setServerFormError('请填写名称和服务器地址');
      return;
    }

    setSavingServer(true);
    setServerFormError(null);
    try {
      // QYP2-015: the password (never a token) goes to saveServer; the
      // main process authenticates and keeps the token in the SecretStore.
      if (serverForm.username && serverForm.password) {
        // Verify first so a typo surfaces here instead of a stored dud.
        const auth = await authenticateServer();
        if (!auth?.ok) {
          setServerFormError(auth?.error || '认证失败，请检查用户名和密码');
          setSavingServer(false);
          return;
        }
      } else if (!(editingServer?.user_id && editingServer?.hasCredential)) {
        // Either new server without credentials, or editing a server that
        // has no stored credentials - a password is required to log in
        setServerFormError('该服务器尚未登录，请填写用户名和密码以完成登录');
        setSavingServer(false);
        return;
      }

      await window.electronAPI.saveServer({
        id: editingServer?.id,
        type: serverForm.type,
        name: serverForm.name,
        baseUrl: serverForm.baseUrl,
        username: serverForm.username || undefined,
        password: serverForm.password || undefined,
        userId: editingServer?.user_id,
        isActive: true,
      });
      addToast(editingServer ? '服务器已更新' : '服务器已保存', 'success');
      setShowServerForm(false);
      resetServerForm();
      loadServers();
    } catch (err) {
      setServerFormError(`保存失败: ${err instanceof Error ? err.message : '未知错误'}`);
    } finally {
      setSavingServer(false);
    }
  };

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
        管理媒体服务器（Jellyfin / Emby）与媒体来源（本地目录 / WebDAV）；浏览与播放请到侧边栏「本地」或「首页」。
      </p>

      {/* Media servers (Jellyfin / Emby) */}
      <section className="mb-10" aria-label="媒体服务器">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
            <ServerIcon size={14} />
            媒体服务器
          </h2>
          <button
            onClick={handleServerAdd}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors text-sm font-medium focus-ring"
          >
            <Plus size={14} />
            {showServerForm ? '取消' : '添加'}
          </button>
        </div>

        {showServerForm && (
          <ServerForm
            form={serverForm}
            onChange={setServerForm}
            onTest={handleServerTest}
            onSave={handleServerSave}
            onCancel={() => {
              setShowServerForm(false);
              resetServerForm();
            }}
            testing={testingServer}
            saving={savingServer}
            formError={serverFormError}
            isEditing={!!editingServer}
          />
        )}

        <div className="space-y-2">
          {servers.map((server) => (
            <div
              key={server.id}
              className={`flex items-center justify-between p-4 bg-card border rounded-xl transition-colors ${
                editingServer?.id === server.id ? 'border-primary/50' : 'border-border'
              }`}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
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
                  onClick={async () => {
                    try {
                      await window.electronAPI.saveServer({ ...server, isActive: false });
                      loadServers();
                      addToast('服务器已删除', 'success');
                    } catch {
                      addToast('删除失败', 'error');
                    }
                  }}
                  className="p-2 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-lg transition-colors focus-ring"
                  aria-label={`删除 ${server.name}`}
                >
                  <Trash2 size={15} />
                </button>
              </div>
            </div>
          ))}
          {servers.length === 0 && !showServerForm && (
            <div className="text-center py-10 text-muted-foreground text-sm">
              暂无服务器，点击上方「添加」按钮连接 Jellyfin / Emby
            </div>
          )}
        </div>
      </section>

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
