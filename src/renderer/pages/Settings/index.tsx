import { useEffect, useState, useCallback } from 'react';
import { Plus, Trash2, Pencil, CheckCircle2, XCircle, Server, HardDrive, RefreshCw, X, Loader2 } from 'lucide-react';
import { useToastStore } from '../../stores/toast-store';
import ServerForm, { ServerForm as ServerFormValues } from './ServerForm';
import SourceForm from './SourceForm';
import type { SourceListEntry, ScanProgressEvent } from '../../../shared/types';

interface AuthResult {
  ok: boolean;
  accessToken?: string;
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

const EMPTY_FORM: ServerFormValues = {
  type: 'jellyfin',
  name: '',
  baseUrl: '',
  username: '',
  password: '',
};

export default function Settings() {
  const [servers, setServers] = useState<SavedServer[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editingServer, setEditingServer] = useState<SavedServer | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<ServerFormValues>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [sources, setSources] = useState<SourceListEntry[]>([]);
  const [showSourceForm, setShowSourceForm] = useState(false);
  const [savingSource, setSavingSource] = useState(false);
  const [testingSource, setTestingSource] = useState(false);
  const [sourceFormError, setSourceFormError] = useState<string | null>(null);
  const [scanningIds, setScanningIds] = useState<Set<number>>(new Set());
  const [liveProgress, setLiveProgress] = useState<Record<number, ScanProgressEvent>>({});
  const addToast = useToastStore((s) => s.addToast);

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

  // ---- Local media sources (QYP2-008) ----
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
    async (values: { root: string }): Promise<{ ok: boolean; error?: string } | null> => {
      setTestingSource(true);
      try {
        const res = (await window.electronAPI.testSource({ kind: 'local', root: values.root })) as {
          ok: boolean;
          data?: unknown;
          error?: { message: string };
        };
        return res.ok ? { ok: true } : { ok: false, error: res.error?.message ?? '目录不可用' };
      } catch {
        return { ok: false, error: '测试请求失败' };
      } finally {
        setTestingSource(false);
      }
    },
    []
  );

  const handleSourceSave = useCallback(
    async (values: { root: string; name: string }): Promise<boolean> => {
      if (!values.root) {
        setSourceFormError('请先选择目录');
        return false;
      }
      setSavingSource(true);
      setSourceFormError(null);
      try {
        const res = (await window.electronAPI.saveSource({
          kind: 'local',
          root: values.root,
          name: values.name || undefined,
        })) as { ok: boolean; data?: { sourceId: number }; error?: { message: string } };
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

  const resetForm = useCallback(() => {
    setForm(EMPTY_FORM);
    setFormError(null);
    setEditingServer(null);
  }, []);

  const handleAdd = () => {
    if (showForm) {
      setShowForm(false);
      resetForm();
    } else {
      resetForm();
      setShowForm(true);
    }
  };

  const handleEdit = (server: SavedServer) => {
    setForm({
      type: server.type as 'jellyfin' | 'emby',
      name: server.name,
      baseUrl: server.base_url,
      username: server.username || '',
      password: '',
    });
    setEditingServer(server);
    setFormError(null);
    setShowForm(true);
  };

  const handleTest = async () => {
    if (!form.baseUrl.trim()) {
      setFormError('请输入服务器地址');
      return;
    }
    setTesting(true);
    setFormError(null);
    try {
      const result = (await window.electronAPI.testServer({
        type: form.type,
        baseUrl: form.baseUrl.trim(),
        username: form.username || undefined,
        password: form.password || undefined,
      })) as AuthResult;

      if (result?.ok) {
        if (result.accessToken) {
          addToast('连接成功，登录凭证有效', 'success');
        } else {
          addToast('服务器可达', 'success');
        }
      } else {
        setFormError(result?.error || '连接失败');
      }
    } catch (err) {
      setFormError(`连接错误: ${err instanceof Error ? err.message : '未知错误'}`);
    } finally {
      setTesting(false);
    }
  };

  const authenticate = async (): Promise<AuthResult> => {
    const result = (await window.electronAPI.testServer({
      type: form.type,
      baseUrl: form.baseUrl,
      username: form.username || undefined,
      password: form.password || undefined,
    })) as AuthResult;
    return result;
  };

  const handleSave = async () => {
    if (!form.name || !form.baseUrl) {
      setFormError('请填写名称和服务器地址');
      return;
    }

    setSaving(true);
    setFormError(null);
    try {
      let apiKey: string | undefined;
      let userId: string | undefined;

      if (form.username && form.password) {
        // Re-authenticate to obtain fresh credentials
        const auth = await authenticate();
        if (!auth?.ok) {
          setFormError(auth?.error || '认证失败，请检查用户名和密码');
          setSaving(false);
          return;
        }
        apiKey = auth.accessToken;
        userId = auth.userId;
      } else if (editingServer?.user_id && editingServer?.hasCredential) {
        // Editing without a new password: the main process keeps the stored
        // secret; the token itself never round-trips through the renderer.
        userId = editingServer.user_id;
      } else {
        // Either new server without credentials, or editing a server that
        // has no stored credentials - a password is required to log in
        setFormError('该服务器尚未登录，请填写用户名和密码以完成登录');
        setSaving(false);
        return;
      }

      await window.electronAPI.saveServer({
        id: editingServer?.id,
        type: form.type,
        name: form.name,
        baseUrl: form.baseUrl,
        username: form.username || undefined,
        apiKey,
        userId,
        isActive: true,
      });
      addToast(editingServer ? '服务器已更新' : '服务器已保存', 'success');
      setShowForm(false);
      resetForm();
      loadServers();
    } catch (err) {
      setFormError(`保存失败: ${err instanceof Error ? err.message : '未知错误'}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="p-8 max-w-2xl">
      <h1 className="text-2xl font-bold tracking-tight mb-8">设置</h1>

      {/* Local media sources */}
      <section className="mb-10" aria-label="本地媒体来源">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
            <HardDrive size={14} />
            本地媒体来源
          </h2>
          <button
            onClick={() => setShowSourceForm((v) => !v)}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors text-sm font-medium focus-ring"
          >
            <Plus size={14} />
            {showSourceForm ? '取消' : '添加'}
          </button>
        </div>

        {showSourceForm && (
          <SourceForm
            saving={savingSource}
            testing={testingSource}
            formError={sourceFormError}
            onChange={() => undefined}
            onPick={() => window.electronAPI.pickDirectory()}
            onTest={handleSourceTest}
            onSave={handleSourceSave}
            onCancel={() => {
              setShowSourceForm(false);
              setSourceFormError(null);
            }}
          />
        )}

        <div className="space-y-2">
          {sources.map((source) => {
            // Live push events win over the persisted last run while scanning.
            const live = liveProgress[source.id];
            const progress = live
              ? { status: live.state, processed: live.processed, total: live.total, message: live.message }
              : source.lastRun;
            const scanning =
              scanningIds.has(source.id) ||
              progress?.status === 'queued' ||
              progress?.status === 'discovering' ||
              progress?.status === 'indexing' ||
              progress?.status === 'enriching';
            return (
              <div
                key={source.id}
                className="p-4 bg-card border border-border rounded-xl"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm">{source.name}</span>
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-secondary text-secondary-foreground text-[10px] font-medium">
                        本地
                      </span>
                      {source.readOnly && (
                        <span className="text-[10px] text-muted-foreground">只读</span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5 truncate" title={source.root}>
                      {source.root}
                    </div>
                    {scanning ? (
                      <div className="flex items-center gap-1.5 text-xs text-muted-foreground mt-1" aria-live="polite">
                        <Loader2 size={12} className="animate-spin" />
                        扫描中
                        {progress?.total ? `（${progress.processed ?? 0}/${progress.total}）` : ''}
                      </div>
                    ) : progress ? (
                      <div className="text-[11px] text-muted-foreground mt-1">
                        上次扫描：
                        {progress.status === 'completed'
                          ? `完成，共 ${progress.processed ?? 0} 项`
                          : progress.status === 'failed'
                            ? `失败${progress.message ? `：${progress.message}` : ''}`
                            : progress.status}
                      </div>
                    ) : (
                      <div className="text-[11px] text-muted-foreground mt-1">尚未扫描</div>
                    )}
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <button
                      onClick={() => handleScanToggle(source)}
                      className="p-2 text-muted-foreground hover:text-foreground hover:bg-accent rounded-lg transition-colors focus-ring"
                      aria-label={scanning ? `取消扫描 ${source.name}` : `扫描 ${source.name}`}
                      title={scanning ? '取消扫描' : '扫描'}
                    >
                      {scanning ? <X size={15} /> : <RefreshCw size={15} />}
                    </button>
                    <button
                      onClick={() => handleSourceRemove(source)}
                      className="p-2 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-lg transition-colors focus-ring"
                      aria-label={`移除 ${source.name}（不删除文件）`}
                      title="移除（不删除文件）"
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
          {sources.length === 0 && !showSourceForm && (
            <div className="text-center py-10 text-muted-foreground text-sm">
              暂无本地来源，点击上方「添加」按钮选择目录
            </div>
          )}
        </div>
      </section>

      {/* Servers Section */}
      <section className="mb-10">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
            <Server size={14} />
            媒体服务器
          </h2>
          <button
            onClick={handleAdd}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors text-sm font-medium focus-ring"
          >
            <Plus size={14} />
            {showForm ? '取消' : '添加'}
          </button>
        </div>

        {showForm && (
          <ServerForm
            form={form}
            onChange={setForm}
            onTest={handleTest}
            onSave={handleSave}
            onCancel={() => {
              setShowForm(false);
              resetForm();
            }}
            testing={testing}
            saving={saving}
            formError={formError}
            isEditing={!!editingServer}
          />
        )}

        {/* Server List */}
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
                  onClick={() => handleEdit(server)}
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
          {servers.length === 0 && !showForm && (
            <div className="text-center py-10 text-muted-foreground text-sm">
              暂无服务器，点击上方「添加」按钮
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
