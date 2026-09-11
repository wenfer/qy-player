import {
  PLUGIN_API_VERSION,
  type MetadataProviderPlugin,
  type PluginContext,
  type PluginManifest,
} from '../../../shared/types/plugins';
import type { ManifestProblems, RegisteredPlugin, RegisterResult } from './types';
import { createPluginContext, type PluginContextOptions } from './context';

/**
 * Static plugin registry (QYP2-026, plan §11.1).
 *
 * 二期 only loads built-in plugins that ship with the app and register here
 * at startup — there is no dynamic loading, no remote manifests, no plugin
 * store. Manifests are validated at registration: duplicates, malformed
 * manifests and apiVersion mismatches are rejected loudly.
 *
 * NOT A SECURITY SANDBOX: built-ins run in-process with the same Node
 * capabilities as the host. The narrow PluginContext is a capability
 * contract for plugin authors, not an isolation boundary (plan §11.1).
 */

const ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/;

export function validateManifest(manifest: unknown): ManifestProblems {
  const errors: string[] = [];
  if (typeof manifest !== 'object' || manifest === null) {
    return { errors: ['manifest 必须是对象'] };
  }
  const m = manifest as Partial<PluginManifest>;
  if (typeof m.id !== 'string' || !ID_PATTERN.test(m.id)) {
    errors.push('id 必须是 2–32 位小写字母/数字/连字符');
  }
  if (typeof m.name !== 'string' || m.name.trim().length === 0 || m.name.length > 60) {
    errors.push('name 必须是 1–60 字符');
  }
  if (typeof m.version !== 'string' || !VERSION_PATTERN.test(m.version)) {
    errors.push('version 必须是 semver（如 1.0.0）');
  }
  if (m.apiVersion !== PLUGIN_API_VERSION) {
    errors.push(`apiVersion 必须为 ${PLUGIN_API_VERSION}（收到 ${String(m.apiVersion)}）`);
  }
  if (m.capability !== 'metadata-provider') {
    errors.push("capability 必须为 'metadata-provider'（二期不承载其他能力）");
  }
  return { errors };
}

const registry = new Map<string, RegisteredPlugin>();

/** Register a built-in plugin; rejects duplicates/malformed/incompatible. */
export function registerPlugin(
  plugin: MetadataProviderPlugin,
  contextOptions: PluginContextOptions
): RegisterResult {
  const { errors } = validateManifest(plugin?.manifest);
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  if (typeof plugin.search !== 'function' || typeof plugin.getDetails !== 'function') {
    return { ok: false, errors: ['search 与 getDetails 必须是函数'] };
  }
  if (registry.has(plugin.manifest.id)) {
    return { ok: false, errors: [`插件 ${plugin.manifest.id} 已注册`] };
  }
  const context = createPluginContext(plugin.manifest.id, contextOptions);
  registry.set(plugin.manifest.id, {
    plugin,
    manifest: plugin.manifest,
    context,
  });
  return { ok: true, manifest: plugin.manifest };
}

export function getPlugin(id: string): RegisteredPlugin | undefined {
  return registry.get(id);
}

export function getPluginContext(id: string): PluginContext | undefined {
  return registry.get(id)?.context ?? undefined;
}

export function listPlugins(): RegisteredPlugin[] {
  return [...registry.values()];
}

/** Test-only: drop everything. */
export function clearRegistry(): void {
  registry.clear();
}
