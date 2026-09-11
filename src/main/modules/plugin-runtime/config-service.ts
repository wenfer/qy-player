import { createHash } from 'crypto';
import {
  encodePluginSecretKey,
} from './context';
import type { SecretStore } from '../security/secret-store';

/**
 * Plugin configuration service (QYP2-027, plan §11.1/§11.3).
 *
 * Per-plugin persisted state: enabled, priority, non-sensitive settings,
 * plus a write-only secret channel into the SecretStore. Secrets NEVER
 * round-trip: the list view only reports whether one is set.
 *
 * Storage: app_config key `plugin.config.<id>` (JSON, no secrets) +
 * SecretStore namespace 'plugin' with the same reversible key encoding
 * the PluginContext reader uses (base64url('<id>:<key>')).
 */

export interface PluginConfig {
  enabled: boolean;
  /** Lower = earlier in the scrape order (§11.2). */
  priority: number;
  /** Non-sensitive settings only (e.g. locale override). */
  settings: Record<string, string | number | boolean>;
}

export interface PluginHealth {
  /** 'ready' = configured+enabled; 'auth-required' = no secret; 'disabled'. */
  status: 'ready' | 'auth-required' | 'disabled';
  /** Retryability guidance for the UI (plan §11.1 unified codes). */
  retryable: boolean;
  message: string;
  checkedAt: number;
}

export interface PluginConfigDeps {
  store: SecretStore;
  /** app_config KV (JSON strings), e.g. Storage.getConfig/setConfig. */
  getConfig(key: string): string | undefined;
  setConfig(key: string, value: string): void;
  /** Optional probe a real plugin registers (e.g. TMDB /configuration).
   * Receives a bound secret value; plugins without one report from state. */
  probe?: (pluginId: string, secret: string | null) => Promise<{ ok: boolean; retryable: boolean; message: string }>;
  now?: () => number;
}

const DEFAULT_CONFIG: PluginConfig = { enabled: false, priority: 100, settings: {} };
const REQUIRED_SECRET_KEYS = new Set(['api-token', 'api-key', 'token']);

function configKey(pluginId: string): string {
  // The id is registry-validated ([a-z0-9-]) - safe as a key suffix.
  return `plugin.config.${pluginId}`;
}

/** Secret keys are encoded exactly like the PluginContext reads them. */
export function secretStorageKey(pluginId: string, key: string): string {
  return encodePluginSecretKey(pluginId, key);
}

/** Deterministic fingerprint for has-secret reporting (never the secret). */
export function secretFingerprint(secret: string): string {
  return createHash('sha256').update(secret).digest('hex').slice(0, 8);
}

export class PluginConfigService {
  private readonly deps: PluginConfigDeps;
  private readonly healthCache = new Map<string, PluginHealth>();

  constructor(deps: PluginConfigDeps) {
    this.deps = deps;
  }

  getConfig(pluginId: string): PluginConfig {
    const raw = this.deps.getConfig(configKey(pluginId));
    if (!raw) return { ...DEFAULT_CONFIG, settings: {} };
    try {
      const parsed = JSON.parse(raw) as Partial<PluginConfig>;
      return {
        enabled: parsed.enabled === true,
        priority: typeof parsed.priority === 'number' ? parsed.priority : 100,
        settings: parsed.settings && typeof parsed.settings === 'object' ? parsed.settings : {},
      };
    } catch {
      return { ...DEFAULT_CONFIG, settings: {} };
    }
  }

  setConfig(pluginId: string, patch: Partial<Omit<PluginConfig, 'settings'>> & { settings?: Record<string, string | number | boolean> }): PluginConfig {
    const current = this.getConfig(pluginId);
    const next: PluginConfig = {
      enabled: typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled,
      priority: typeof patch.priority === 'number' && Number.isInteger(patch.priority) && patch.priority >= 0 && patch.priority <= 1000
        ? patch.priority
        : current.priority,
      settings: patch.settings ?? current.settings,
    };
    // Defense in depth: non-sensitive settings must never smuggle secrets.
    for (const key of Object.keys(next.settings)) {
      if (REQUIRED_SECRET_KEYS.has(key.toLowerCase())) {
        throw new Error('敏感键必须通过 secret 通道设置');
      }
    }
    this.deps.setConfig(configKey(pluginId), JSON.stringify(next));
    this.healthCache.delete(pluginId);
    return next;
  }

  hasSecret(pluginId: string, key: string): boolean {
    return this.deps.store.hasSecret('plugin', secretStorageKey(pluginId, key));
  }

  /** Write-only from the renderer's perspective: only a fingerprint returns. */
  setSecret(pluginId: string, key: string, value: string): { fingerprint: string } {
    if (!key || key.length > 64 || !/^[a-zA-Z0-9-]+$/.test(key)) {
      throw new Error('secret 键名无效');
    }
    if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
      throw new Error('secret 值无效');
    }
    this.deps.store.setSecret('plugin', secretStorageKey(pluginId, key), value);
    this.healthCache.delete(pluginId);
    return { fingerprint: secretFingerprint(value) };
  }

  deleteSecret(pluginId: string, key: string): void {
    this.deps.store.deleteSecret('plugin', secretStorageKey(pluginId, key));
    this.healthCache.delete(pluginId);
  }

  /**
   * Read the secret for plugin/host use only (never crosses IPC as a value).
   * Uses the same encoding the PluginContext reader applies, so a key set
   * here is exactly what search/getDetails see.
   */
  readSecret(pluginId: string, key: string): string | null {
    return this.deps.store.getSecret('plugin', secretStorageKey(pluginId, key));
  }

  /**
   * Health: explicit probe when the plugin provides one, otherwise derived
   * from state (enabled + required secret present). Results are cached
   * until config changes.
   */
  async checkHealth(pluginId: string, requiredSecretKey = 'api-token'): Promise<PluginHealth> {
    const cached = this.healthCache.get(pluginId);
    if (cached) return cached;
    const config = this.getConfig(pluginId);
    let health: PluginHealth;
    if (!config.enabled) {
      health = { status: 'disabled', retryable: false, message: '插件已停用', checkedAt: this.deps.now?.() ?? Date.now() };
    } else if (!this.hasSecret(pluginId, requiredSecretKey) && REQUIRED_SECRET_KEYS.has(requiredSecretKey)) {
      // §11.3: installed but unconfigured → AUTH_REQUIRED semantics.
      health = {
        status: 'auth-required',
        retryable: false,
        message: '未配置密钥（配置后即可用）',
        checkedAt: this.deps.now?.() ?? Date.now(),
      };
    } else if (this.deps.probe) {
      const secret = this.readSecret(pluginId, requiredSecretKey);
      try {
        const probe = await this.deps.probe(pluginId, secret);
        health = {
          status: probe.ok ? 'ready' : 'auth-required',
          retryable: probe.retryable,
          message: probe.message,
          checkedAt: this.deps.now?.() ?? Date.now(),
        };
      } catch (err) {
        health = {
          status: 'auth-required',
          retryable: true,
          message: err instanceof Error ? err.message : '探测失败，可重试',
          checkedAt: this.deps.now?.() ?? Date.now(),
        };
      }
    } else {
      health = {
        status: 'ready',
        retryable: false,
        message: '已配置',
        checkedAt: this.deps.now?.() ?? Date.now(),
      };
    }
    this.healthCache.set(pluginId, health);
    return health;
  }
}
