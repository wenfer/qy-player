import { useEffect, useState, useCallback } from 'react';
import { Plus, Trash2, Pencil, CheckCircle2, XCircle, Server } from 'lucide-react';
import { useToastStore } from '../../stores/toast-store';
import ServerForm, { ServerForm as ServerFormValues } from './ServerForm';

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
        addToast(form.username ? '连接成功，登录凭证有效' : '服务器可达', 'success');
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
      // QYP2-015: the password (never a token) goes to saveServer; the
      // main process authenticates and keeps the token in the SecretStore.
      if (form.username && form.password) {
        // Verify first so a typo surfaces here instead of a stored dud.
        const auth = await authenticate();
        if (!auth?.ok) {
          setFormError(auth?.error || '认证失败，请检查用户名和密码');
          setSaving(false);
          return;
        }
      } else if (!(editingServer?.user_id && editingServer?.hasCredential)) {
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
        password: form.password || undefined,
        userId: editingServer?.user_id,
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
      <h1 className="text-2xl font-bold tracking-tight mb-2">设置</h1>
      <p className="text-sm text-muted-foreground mb-8">
        软件配置。媒体来源（本地目录 / WebDAV）在「媒体库」页面管理。
      </p>

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
