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
  status: 'ready' | 'auth-required' | 'disabled';
  retryable: boolean;
  message: string;
  checkedAt: number;
}

const HEALTH_BADGE: Record<PluginHealth['status'], { label: string; cls: string }> = {
  ready: { label: '就绪', cls: 'bg-emerald-500/10 text-emerald-500' },
  'auth-required': { label: '需要配置', cls: 'bg-amber-500/10 text-amber-500' },
  disabled: { label: '已停用', cls: 'bg-muted text-muted-foreground' },
};

const REQUIRED_SECRET_KEY = 'api-token';

export default function PluginSettings() {
  const addToast = useToastStore((s) => s.addToast);
  const [plugins, setPlugins] = useState<PluginListEntry[]>([]);
  const [health, setHealth] = useState<Record<string, PluginHealth | 'loading'>>({});
  const [secretDrafts, setSecretDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = (await window.electronAPI.listPlugins()) as PluginListEntry[];
      setPlugins(result ?? []);
      for (const plugin of result ?? []) {
        setHealth((prev) => ({ ...prev, [plugin.id]: 'loading' }));
        window.electronAPI
          .testPlugin(plugin.id)
          .then((h) => setHealth((prev) => ({ ...prev, [plugin.id]: h as PluginHealth })))
          .catch(() => setHealth((prev) => ({ ...prev, [plugin.id]: 'loading' })));
      }
    } catch {
      addToast('加载插件列表失败', 'error');
    }
  }, [addToast]);

  useEffect(() => {
    load();
  }, [load]);

  const handleToggle = useCallback(
    async (plugin: PluginListEntry, enabled: boolean) => {
      setBusy(plugin.id);
      try {
        const result = (await window.electronAPI.setPluginConfig(plugin.id, { enabled })) as { ok: boolean };
        if (result.ok) {
          setPlugins((rows) => rows.map((p) => (p.id === plugin.id ? { ...p, enabled } : p)));
          window.electronAPI.testPlugin(plugin.id).then((h) => setHealth((prev) => ({ ...prev, [plugin.id]: h as PluginHealth })));
        } else {
          addToast('更新失败', 'error');
        }
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
          window.electronAPI.testPlugin(plugin.id).then((h) => setHealth((prev) => ({ ...prev, [plugin.id]: h as PluginHealth })));
        } else {
          addToast('密钥保存失败', 'error');
        }
      } finally {
        setBusy(null);
      }
    },
    [secretDrafts, addToast]
  );

  const handleTest = useCallback(async (plugin: PluginListEntry) => {
    setHealth((prev) => ({ ...prev, [plugin.id]: 'loading' }));
    try {
      const h = (await window.electronAPI.testPlugin(plugin.id)) as PluginHealth;
      setHealth((prev) => ({ ...prev, [plugin.id]: h }));
    } catch {
      setHealth((prev) => ({
        ...prev,
        [plugin.id]: { status: 'auth-required', retryable: true, message: '测试失败，可重试', checkedAt: Date.now() },
      }));
    }
  }, []);

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
              ? { label: '检查中…', cls: 'bg-muted text-muted-foreground' }
              : healthState
                ? HEALTH_BADGE[healthState.status]
                : { label: '未检查', cls: 'bg-muted text-muted-foreground' };
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
                    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-medium ${badge.cls}`}>
                      {healthState === 'loading' && <Loader2 size={10} className="animate-spin" />}
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
                      className="w-16 px-2 py-1 bg-secondary border border-border rounded-md text-xs focus:outline-none focus:border-primary/50"
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
                  placeholder={hasSecret ? '已设置（输入可更换）' : 'API Token'}
                  autoComplete="new-password"
                  aria-label={`${plugin.name} API Token`}
                  className="flex-1 min-w-[200px] px-3 py-1.5 bg-secondary border border-border rounded-md text-xs focus:outline-none focus:border-primary/50"
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
                  <span className="inline-flex items-center gap-1 text-[10px] text-emerald-500">
                    <CheckCircle2 size={10} />
                    已设置
                  </span>
                )}
                {!hasSecret && healthState && healthState !== 'loading' && healthState.status === 'auth-required' && (
                  <span className="inline-flex items-center gap-1 text-[10px] text-amber-500">
                    <XCircle size={10} />
                    未配置密钥
                  </span>
                )}
              </div>
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
