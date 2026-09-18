import { useCallback, useEffect, useState } from 'react';
import type { ServerForm as ServerFormValues } from './ServerForm';

/**
 * 媒体服务器（Jellyfin / Emby）区块的状态与行为（QYP3-042：从
 * MediaSourcesPage 抽出来，页面只留编排）。
 *
 * 保存前先认证：密码只在测试连接/保存时离开表单，token 由主进程的
 * SecretStore 保管，渲染层从不持有（U-002）。
 */

export const EMPTY_SERVER_FORM: ServerFormValues = {
  type: 'jellyfin',
  name: '',
  baseUrl: '',
  username: '',
  password: '',
};

export interface SavedServer {
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

interface AuthResult {
  ok: boolean;
  userId?: string;
  error?: string;
}

type AddToast = (message: string, type?: 'success' | 'error' | 'info') => void;

export function useServers(addToast: AddToast) {
  const [servers, setServers] = useState<SavedServer[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<SavedServer | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<ServerFormValues>(EMPTY_SERVER_FORM);
  const [formError, setFormError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await window.electronAPI.getServers();
      setServers(data as SavedServer[]);
    } catch {
      addToast('加载服务器列表失败', 'error');
    }
  }, [addToast]);

  useEffect(() => {
    void load();
  }, [load]);

  const reset = useCallback(() => {
    setForm(EMPTY_SERVER_FORM);
    setFormError(null);
    setEditing(null);
  }, []);

  const toggleForm = useCallback(() => {
    reset();
    setShowForm((v) => !v);
  }, [reset]);

  const edit = useCallback((server: SavedServer) => {
    setForm({
      type: server.type as 'jellyfin' | 'emby',
      name: server.name,
      baseUrl: server.base_url,
      username: server.username || '',
      password: '',
    });
    setEditing(server);
    setFormError(null);
    setShowForm(true);
  }, []);

  const test = useCallback(async () => {
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
  }, [addToast, form]);

  const save = useCallback(async () => {
    if (!form.name || !form.baseUrl) {
      setFormError('请填写名称和服务器地址');
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      if (form.username && form.password) {
        // Verify first so a typo surfaces here instead of a stored dud.
        const auth = (await window.electronAPI.testServer({
          type: form.type,
          baseUrl: form.baseUrl,
          username: form.username || undefined,
          password: form.password || undefined,
        })) as AuthResult;
        if (!auth?.ok) {
          setFormError(auth?.error || '认证失败，请检查用户名和密码');
          setSaving(false);
          return;
        }
      } else if (!(editing?.user_id && editing?.hasCredential)) {
        // Either new server without credentials, or editing a server that
        // has no stored credentials - a password is required to log in
        setFormError('该服务器尚未登录，请填写用户名和密码以完成登录');
        setSaving(false);
        return;
      }

      await window.electronAPI.saveServer({
        id: editing?.id,
        type: form.type,
        name: form.name,
        baseUrl: form.baseUrl,
        username: form.username || undefined,
        password: form.password || undefined,
        userId: editing?.user_id,
        isActive: true,
      });
      addToast(editing ? '服务器已更新' : '服务器已保存', 'success');
      setShowForm(false);
      reset();
      void load();
    } catch (err) {
      setFormError(`保存失败: ${err instanceof Error ? err.message : '未知错误'}`);
    } finally {
      setSaving(false);
    }
  }, [addToast, editing, form, load, reset]);

  /** 删除 = 置为未激活（saveServer 的既有语义）。 */
  const remove = useCallback(
    async (server: SavedServer) => {
      try {
        await window.electronAPI.saveServer({ ...server, isActive: false });
        void load();
        addToast('服务器已删除', 'success');
      } catch {
        addToast('删除失败', 'error');
      }
    },
    [addToast, load]
  );

  return {
    servers,
    editing,
    form,
    formError,
    showForm,
    saving,
    testing,
    setForm,
    load,
    edit,
    remove,
    save,
    test,
    toggleForm,
    closeForm: useCallback(() => {
      setShowForm(false);
      reset();
    }, [reset]),
  };
}
