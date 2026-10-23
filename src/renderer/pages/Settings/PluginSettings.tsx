import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Loader2, Plug, RefreshCw, XCircle } from 'lucide-react';
import { useToastStore } from '../../stores/toast-store';

/**
 * Plugin management section (QYP2-027): enable/priority/non-sensitive
 * settings, write-only secret entry, health test with retry guidance.
 * Secrets are never echoed — only a "已设置" marker comes back.
 */

interface PluginListEntry {
  id: string;
  name: string;
  version: string;
  apiVersion: number;
  capability: string;
  enabled: boolean;
  priority: number;
  settings: Record<string, string | number | boolean>;
  secrets: Array<{ key: string; set: boolean }>;
}

interface PluginHealth {
  status: 'ready' | 'auth-required' | 'disabled' | 'error';
  retryable: boolean;
  message: string;
  checkedAt: number;
}

const HEALTH_BADGE: Record<PluginHealth['status'], { label: string; dot: string }> = {
  ready: { label: '就绪', dot: 'bg-emerald-400' },
  'auth-required': { label: '需要配置', dot: 'bg-amber-400' },
  disabled: { label: '已停用', dot: 'bg-muted-foreground' },
  error: { label: '探测失败', dot: 'bg-rose-400' },
};

const REQUIRED_SECRET_KEY = 'api-token';

export default function PluginSettings() {
  const addToast = useToastStore((s) => s.addToast);
  const [plugins, setPlugins] = useState<PluginListEntry[]>([]);
  const [health, setHealth] = useState<Record<string, PluginHealth | 'loading'>>({});
  const [secretDrafts, setSecretDrafts] = useState<Record<string, string>>({});
  const [baseUrlDrafts, setBaseUrlDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const applyHealth = useCallback((pluginId: string, promise: Promise<unknown>): void => {
    setHealth((prev) => ({ ...prev, [pluginId]: 'loading' }));
    promise
      .then((envelope) => {
        // Wire envelope: { ok, data: PluginHealth }.
        const res = envelope as { ok: boolean; data?: PluginHealth };
        setHealth((prev) => ({
          ...prev,
          [pluginId]: res.ok && res.data ? res.data : { status: 'error', retryable: true, message: '检查失败，可重试', checkedAt: Date.now() },
        }));
      })
      .catch(() => {
        setHealth((prev) => ({
          ...prev,
          [pluginId]: { status: 'error', retryable: true, message: '检查失败，可重试', checkedAt: Date.now() },
        }));
      });
  }, []);

  const load = useCallback(async () => {
    try {
      // Wire envelope: { ok, data: PluginListEntry[] }.
      const res = (await window.electronAPI.listPlugins()) as {
        ok: boolean;
        data?: PluginListEntry[];
      };
      const rows = res.ok && Array.isArray(res.data) ? res.data : [];
      setPlugins(rows);
      for (const plugin of rows) {
        if (typeof plugin.settings?.apiBaseUrl === 'string') {
          setBaseUrlDrafts((prev) => ({ ...prev, [plugin.id]: plugin.settings.apiBaseUrl as string }));
        }
        applyHealth(plugin.id, window.electronAPI.testPlugin(plugin.id));
      }
    } catch {
      addToast('加载插件列表失败', 'error');
    }
  }, [addToast, applyHealth]);

  useEffect(() => {
    load();
  }, [load]);

  const handleSaveBaseUrl = useCallback(
    async (plugin: PluginListEntry) => {
      const url = baseUrlDrafts[plugin.id] ?? '';
      setBusy(plugin.id);
      try {
        const nextSettings = { ...plugin.settings, apiBaseUrl: url.trim() };
        const result = (await window.electronAPI.setPluginConfig(plugin.id, {
          settings: nextSettings,
        })) as { ok: boolean };
        if (result.ok) {
          setPlugins((rows) =>
            rows.map((p) => (p.id === plugin.id ? { ...p, settings: nextSettings } : p))
          );
          addToast('API 地址已保存', 'success');
          applyHealth(plugin.id, window.electronAPI.testPlugin(plugin.id));
        } else {
          addToast('保存失败', 'error');
        }
      } catch {
        addToast('保存失败', 'error');
      } finally {
        setBusy(null);
      }
    },
    [baseUrlDrafts, addToast, applyHealth]
  );

  const handleToggle = useCallback(
    async (plugin: PluginListEntry, enabled: boolean) => {
      setBusy(plugin.id);
      try {
        const result = (await window.electronAPI.setPluginConfig(plugin.id, { enabled })) as { ok: boolean };
        if (result.ok) {
          setPlugins((rows) => rows.map((p) => (p.id === plugin.id ? { ...p, enabled } : p)));
          applyHealth(plugin.id, window.electronAPI.testPlugin(plugin.id));
        } else {
          addToast('更新失败', 'error');
        }
      } catch {
        addToast('更新失败', 'error');
      } finally {
        setBusy(null);
      }
    },
    [addToast]
  );

  const handlePriority = useCallback(
    async (plugin: PluginListEntry, priority: number) => {
      if (!Number.isInteger(priority)) return;
      setBusy(plugin.id);
      try {
        const result = (await window.electronAPI.setPluginConfig(plugin.id, { priority })) as { ok: boolean };
        if (result.ok) {
          setPlugins((rows) => rows.map((p) => (p.id === plugin.id ? { ...p, priority } : p)));
        } else {
          addToast('更新失败', 'error');
        }
      } catch {
        addToast('更新失败', 'error');
      } finally {
        setBusy(null);
      }
    },
    [addToast]
  );

  const handleSaveSecret = useCallback(
    async (plugin: PluginListEntry) => {
      const value = secretDrafts[plugin.id];
      if (!value) {
        addToast('请先输入密钥', 'warning');
        return;
      }
      setBusy(plugin.id);
      try {
        const result = (await window.electronAPI.setPluginSecret(plugin.id, REQUIRED_SECRET_KEY, value)) as {
          ok: boolean;
          data?: { fingerprint: string };
        };
        if (result.ok) {
          // Write-only: clear the draft, show only the "已设置" state.
          setSecretDrafts((prev) => ({ ...prev, [plugin.id]: '' }));
          setPlugins((rows) =>
            rows.map((p) =>
              p.id === plugin.id
                ? { ...p, secrets: [{ key: REQUIRED_SECRET_KEY, set: true }] }
                : p
            )
          );
          addToast('密钥已保存（仅存于系统密钥存储）', 'success');
          applyHealth(plugin.id, window.electronAPI.testPlugin(plugin.id));
        } else {
          addToast('密钥保存失败', 'error');
        }
      } catch {
        addToast('密钥保存失败', 'error');
      } finally {
        setBusy(null);
      }
    },
    [secretDrafts, addToast]
  );

  const handleTest = useCallback(
    (plugin: PluginListEntry) => {
      applyHealth(plugin.id, window.electronAPI.testPlugin(plugin.id));
    },
    [applyHealth]
  );

  return (
    <section className="mb-10" aria-label="插件">
      <div className="flex items-center gap-3 mb-5">
        <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-primary/10 text-primary">
          <Plug size={17} />
        </div>
        <h2 className="text-sm font-semibold">插件</h2>
        <span className="px-1.5 py-0.5 rounded-md bg-secondary text-secondary-foreground text-[10px] font-medium">
          {plugins.length}
        </span>
      </div>

      <div className="space-y-2">
        {plugins.map((plugin) => {
          const healthState = health[plugin.id];
          const badge =
            healthState === 'loading'
              ? { label: '检查中…', dot: 'bg-muted-foreground' }
              : healthState
                ? HEALTH_BADGE[healthState.status]
                : { label: '未检查', dot: 'bg-muted-foreground' };
          const hasSecret = plugin.secrets.some((s) => s.set);
          return (
            <div key={plugin.id} className="p-4 bg-card border border-border rounded-xl">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-sm">{plugin.name}</span>
                    <span className="px-1.5 py-0.5 rounded-md bg-secondary text-secondary-foreground text-[10px] font-medium">
                      v{plugin.version}
                    </span>
                    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-secondary border border-border text-foreground text-[10px] font-medium">
                      {healthState === 'loading' ? (
                        <Loader2 size={10} className="animate-spin text-muted-foreground" />
                      ) : (
                        <span className={`w-1.5 h-1.5 rounded-full ${badge.dot}`} />
                      )}
                      {badge.label}
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    {plugin.id} · 数据刮削提供方
                    {hasSecret && ' · 密钥已设置'}
                  </div>
                  {healthState && healthState !== 'loading' && (
                    <p className="text-[11px] text-muted-foreground mt-1" role="status">
                      {healthState.message}
                      {healthState.retryable && '（可重试）'}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-3 flex-shrink-0">
                  <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    优先级
                    <input
                      type="number"
                      min={0}
                      max={1000}
                      value={plugin.priority}
                      onChange={(e) => {
                        const value = Number(e.target.value);
                        if (Number.isInteger(value)) handlePriority(plugin, value);
                      }}
                      disabled={busy === plugin.id}
                      className="w-16 px-2 py-1 bg-secondary border border-border rounded-md text-xs focus-ring"
                      aria-label={`${plugin.name} 优先级`}
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => handleToggle(plugin, !plugin.enabled)}
                    disabled={busy === plugin.id}
                    aria-pressed={plugin.enabled}
                    aria-label={`${plugin.enabled ? '停用' : '启用'} ${plugin.name}`}
                    className={`relative w-10 h-5 rounded-full transition-colors focus-ring ${plugin.enabled ? 'bg-primary' : 'bg-secondary'}`}
                  >
                    <span
                      className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${plugin.enabled ? 'translate-x-5' : 'translate-x-0.5'}`}
                    />
                  </button>
                </div>
              </div>

              <div className="mt-3 flex items-center gap-2 flex-wrap">
                <input
                  type="password"
                  value={secretDrafts[plugin.id] ?? ''}
                  onChange={(e) => setSecretDrafts((prev) => ({ ...prev, [plugin.id]: e.target.value }))}
                  placeholder={hasSecret ? '已设置（输入可更换）' : 'API Token（支持 v3 32位 API Key 或 v4 JWT Token）'}
                  autoComplete="new-password"
                  aria-label={`${plugin.name} API Token`}
                  className="flex-1 min-w-[200px] px-3 py-1.5 bg-secondary border border-border rounded-md text-xs focus-ring"
                />
                <button
                  type="button"
                  onClick={() => handleSaveSecret(plugin)}
                  disabled={busy === plugin.id || !secretDrafts[plugin.id]}
                  className="px-2.5 py-1.5 text-xs border border-border rounded-md hover:bg-accent focus-ring text-muted-foreground hover:text-foreground disabled:opacity-40"
                >
                  保存密钥
                </button>
                <button
                  type="button"
                  onClick={() => handleTest(plugin)}
                  disabled={busy === plugin.id || healthState === 'loading'}
                  className="flex items-center gap-1 px-2.5 py-1.5 text-xs border border-border rounded-md hover:bg-accent focus-ring text-muted-foreground hover:text-foreground disabled:opacity-40"
                >
                  <RefreshCw size={11} />
                  测试连接
                </button>
                {hasSecret && (
                  <span className="inline-flex items-center gap-1 text-[11px] text-emerald-400 font-medium">
                    <CheckCircle2 size={12} />
                    已设置
                  </span>
                )}
                {!hasSecret && healthState && healthState !== 'loading' && healthState.status === 'auth-required' && (
                  <span className="inline-flex items-center gap-1 text-[11px] text-amber-400 font-medium">
                    <XCircle size={12} />
                    未配置密钥
                  </span>
                )}
              </div>

              {plugin.id === 'tmdb' && (
                <div className="mt-3 pt-3 border-t border-border/50">
                  <label className="block text-[11px] text-muted-foreground mb-1">
                    API 镜像 / 反代加速地址（可选，国内直连超时时建议配置）
                  </label>
                  <div className="flex items-center gap-2 flex-wrap">
                    <input
                      type="text"
                      value={baseUrlDrafts[plugin.id] ?? ((plugin.settings.apiBaseUrl as string) ?? '')}
                      onChange={(e) => setBaseUrlDrafts((prev) => ({ ...prev, [plugin.id]: e.target.value }))}
                      placeholder="默认: https://api.themoviedb.org/3"
                      className="flex-1 min-w-[240px] px-3 py-1.5 bg-secondary border border-border rounded-md text-xs focus-ring"
                      aria-label="TMDB API 镜像地址"
                    />
                    <button
                      type="button"
                      onClick={() => handleSaveBaseUrl(plugin)}
                      disabled={busy === plugin.id}
                      className="px-2.5 py-1.5 text-xs border border-border rounded-md hover:bg-accent focus-ring text-muted-foreground hover:text-foreground disabled:opacity-40"
                    >
                      保存地址
                    </button>
                  </div>
                  <p className="text-[10px] text-muted-foreground mt-1.5">
                    说明：支持 TMDB 申请的 32 位 API Key 或 v4 Read Access Token；支持系统/环境变量代理（HTTP_PROXY/HTTPS_PROXY）。
                  </p>
                </div>
              )}
            </div>
          );
        })}
        {plugins.length === 0 && (
          <div className="text-center py-10 text-muted-foreground text-sm">
            暂无已注册插件
          </div>
        )}
      </div>
    </section>
  );
}
