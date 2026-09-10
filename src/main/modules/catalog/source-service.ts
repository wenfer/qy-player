import { basename } from 'node:path';
import type Database from 'better-sqlite3';
import { createCatalogRepository } from '../catalog/repository';
import { LocalSourceAdapter } from '../library-sources/local-source';
import {
  WebDavSourceAdapter,
  deleteWebDavSecret,
  loadWebDavSecret,
  saveWebDavSecret,
  WEBDAV_SECRET_NAMESPACE,
} from '../library-sources/webdav-source';
import { parseWebDavBaseUrl, WebDavUrlError } from '../library-sources/url-guard';
import type { SourceAdapter } from '../library-sources/types';
import type { SecretStore } from '../security/secret-store';
import { formatSecretRef } from '../security/secret-store';
import type { CreateWebDavSourceInput } from '../../../shared/types';

/**
 * Source lifecycle service (plan §7, QYP2-007).
 *
 * The renderer may only hand over a path obtained from the Electron
 * directory picker. Everything else (canonicalization, validation,
 * containment) happens here, in the main process.
 */

export interface CreatedSource {
  sourceId: number;
  /** Canonical root actually stored (may differ from the picked path). */
  root: string;
  name: string;
}

/** Create a local source from a picker-provided directory. */
export function createLocalSourceFromSelection(
  db: Database.Database,
  selectedPath: string,
  options: { name?: string } = {}
): CreatedSource {
  const root = LocalSourceAdapter.canonicalizeRoot(selectedPath);
  const repo = createCatalogRepository(db);
  const sourceId = repo.createSource({
    kind: 'local',
    name: options.name?.trim() || basename(root),
    root,
    readOnly: true, // plan §14.2: deletion stays disabled by default
  });
  return { sourceId, root, name: options.name?.trim() || basename(root) };
}

/**
 * Create a WebDAV source from renderer input (plan §8.1/8.2).
 *
 * - The base URL is validated again here (userinfo/query/fragment/scheme) —
 *   the DB CHECK (`root` without '@') is the last line of defense.
 * - http:// requires an explicit `confirmHttpPlaintext` consent flag; the
 *   renderer must have shown the plaintext-transport warning first.
 * - Credentials go straight into the SecretStore (encrypted or session-
 *   only per isPersistent); they are never written to the source row.
 */
export function createWebDavSource(
  db: Database.Database,
  secretStore: SecretStore | null,
  input: CreateWebDavSourceInput
): CreatedSource {
  const parsed = parseWebDavBaseUrl(input.url);
  if (!parsed.isHttps && input.confirmHttpPlaintext !== true) {
    throw new WebDavUrlError('http 明文传输需用户确认后才能保存');
  }
  const repo = createCatalogRepository(db);
  const name = input.name?.trim() || parsed.basePath.replace(/^\/+/, '') || new URL(parsed.url).hostname;
  const sourceId = repo.createSource({
    kind: 'webdav',
    name,
    root: parsed.url,
    readOnly: true, // plan §14.2: deletion stays disabled by default
  });
  // Empty strings are not credentials; only real pairs reach the store.
  if (input.username && input.password && secretStore) {
    saveWebDavSecret(secretStore, sourceId, {
      username: input.username,
      password: input.password,
    });
    repo.setSourceSecret(sourceId, formatSecretRef(WEBDAV_SECRET_NAMESPACE, String(sourceId)));
  }
  return { sourceId, root: parsed.url, name };
}

/** Test a WebDAV base URL + optional credentials BEFORE saving. */
export async function testWebDavConnection(
  input: CreateWebDavSourceInput
): Promise<{ canSeek: boolean; canDelete: boolean; supportsEtag: boolean; supportsRange: boolean }> {
  const parsed = parseWebDavBaseUrl(input.url);
  if (!parsed.isHttps && input.confirmHttpPlaintext !== true) {
    throw new WebDavUrlError('http 明文传输需用户确认后才能测试');
  }
  const secret =
    input.username !== undefined && input.password !== undefined
      ? { username: input.username, password: input.password }
      : null;
  const adapter = WebDavSourceAdapter.fromSource(0, parsed.url, secret, { timeoutMs: 8000 });
  return adapter.testConnection(new AbortController().signal);
}

/**
 * Remove a source and its index. The underlying media is NEVER touched:
 * catalog rows go away through FK cascades, files stay on disk / server.
 * WebDAV credentials are removed from the SecretStore as well.
 */
export function removeSource(
  db: Database.Database,
  sourceId: number,
  secretStore: SecretStore | null = null
): void {
  const repo = createCatalogRepository(db);
  const source = repo.getSource(sourceId);
  if (!source) throw new Error('来源不存在');
  if (source.kind === 'webdav' && secretStore) deleteWebDavSecret(secretStore, sourceId);
  repo.deleteSource(sourceId);
}

/** Build the adapter for a stored source; throws if the kind is unknown. */
export function getAdapterForSource(
  db: Database.Database,
  sourceId: number,
  secretStore: SecretStore | null = null
): { adapter: SourceAdapter; root: string } {
  const repo = createCatalogRepository(db);
  const source = repo.getSource(sourceId);
  if (!source) throw new Error('来源不存在');
  if (source.kind === 'local') {
    return { adapter: LocalSourceAdapter.fromSource(sourceId, source.root), root: source.root };
  }
  if (source.kind === 'webdav') {
    const secret = loadWebDavSecret(secretStore, sourceId);
    return {
      adapter: WebDavSourceAdapter.fromSource(sourceId, source.root, secret),
      root: source.root,
    };
  }
  throw new Error(`暂不支持该来源类型: ${source.kind}`);
}

/** Cheap health probe used by the settings UI and home health summary. */
export async function checkSourceHealth(
  db: Database.Database,
  sourceId: number,
  signal: AbortSignal = new AbortController().signal
): Promise<'ok' | 'degraded' | 'offline' | 'auth-required' | 'unscanned'> {
  let adapter: SourceAdapter;
  try {
    ({ adapter } = getAdapterForSource(db, sourceId));
  } catch (err) {
    console.error('[SOURCE-HEALTH] 来源不存在或类型不支持:', err instanceof Error ? err.message : err);
    return 'offline';
  }
  try {
    await adapter.testConnection(signal);
    return 'ok';
  } catch (err) {
    // Distinguish access-class failures (offline) from unexpected ones
    // (degraded) so the UI can suggest the right remediation.
    const code = (err as { code?: string })?.code;
    console.error(
      `[SOURCE-HEALTH] 来源 ${sourceId} 健康检查失败:`,
      err instanceof Error ? err.message : String(err)
    );
    return code === 'ENOENT' || code === 'EACCES' || code === 'EPERM' ? 'offline' : 'degraded';
  }
}

// Deferred to QYP2-012: WebDAV adapter factory joins getAdapterForSource.
