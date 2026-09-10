import type { MediaLocator, ReadableResource, SourceAdapter, SourceEntry, SourceStat } from './types';
import { createWebDavClient, type WebDavClient, type WebDavClientOptions } from './webdav-client';
import { parseWebDavBaseUrl } from './url-guard';
import type { SecretStore } from '../security/secret-store';

/**
 * WebDAV SourceAdapter (plan §8, QYP2-012).
 *
 * All network work goes through the bounded client; hrefs are decoded and
 * containment-checked by url-guard before use. Credentials come only from
 * the SecretStore (namespace `webdav`, key = source id) and never leave the
 * main process.
 */

export const WEBDAV_SECRET_NAMESPACE = 'webdav';

export interface WebDavSecret {
  username: string;
  password: string;
}

export function loadWebDavSecret(
  secretStore: SecretStore | null,
  sourceId: number
): WebDavSecret | null {
  if (!secretStore) return null;
  const raw = secretStore.getSecret(WEBDAV_SECRET_NAMESPACE, String(sourceId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<WebDavSecret>;
    if (typeof parsed.username === 'string' && typeof parsed.password === 'string') {
      return { username: parsed.username, password: parsed.password };
    }
  } catch {
    // Corrupt secret: treated as no credential (auth-required surfacing).
  }
  return null;
}

export function saveWebDavSecret(
  secretStore: SecretStore,
  sourceId: number,
  secret: WebDavSecret
): void {
  secretStore.setSecret(WEBDAV_SECRET_NAMESPACE, String(sourceId), JSON.stringify(secret));
}

export function deleteWebDavSecret(secretStore: SecretStore, sourceId: number): void {
  secretStore.deleteSecret(WEBDAV_SECRET_NAMESPACE, String(sourceId));
}

export class WebDavSourceAdapter implements SourceAdapter {
  readonly kind = 'webdav' as const;
  private readonly client: WebDavClient;
  private readonly rootUrl: string;
  private readonly rootBasePath: string;

  constructor(
    readonly sourceId: number,
    baseUrl: string,
    auth: WebDavClientOptions['auth'],
    options: Pick<WebDavClientOptions, 'signal' | 'timeoutMs' | 'maxBytes' | 'maxRetries'> = {}
  ) {
    // Fail fast on contract-violating base URLs; the parsed shape is cached
    // for href root-stripping during list().
    const parsed = parseWebDavBaseUrl(baseUrl);
    this.rootUrl = parsed.url;
    this.rootBasePath = parsed.basePath;
    this.client = createWebDavClient({ baseUrl: this.rootUrl, auth, ...options });
  }

  static fromSource(
    sourceId: number,
    root: string,
    secret: WebDavSecret | null,
    options: Pick<WebDavClientOptions, 'signal' | 'timeoutMs' | 'maxBytes' | 'maxRetries'> = {}
  ): WebDavSourceAdapter {
    const auth = secret
      ? ({ type: 'basic', username: secret.username, password: secret.password } as const)
      : ({ type: 'none' } as const);
    return new WebDavSourceAdapter(sourceId, root, auth, options);
  }

  async testConnection(signal: AbortSignal): Promise<{
    canSeek: boolean;
    canDelete: boolean;
    supportsEtag: boolean;
    supportsRange: boolean;
  }> {
    // PROPFIND Depth 0 on the root: reachable + authenticated. A 401/403
    // surfaces as WebDavError with status — the health layer maps it to
    // 'auth-required' vs 'offline' (plan §6.1).
    await this.client.stat('', signal);
    // ETag support is declared per-entry by the server; the root tells us
    // the general shape. Range probing happens per-file before playback.
    return { canSeek: true, canDelete: false, supportsEtag: true, supportsRange: true };
  }

  /** One PROPFIND Depth 1 → relativePath entries (no leading slash). */
  async *list(relativePath: string, signal: AbortSignal): AsyncGenerator<SourceEntry> {
    if (signal.aborted) return;
    const entries = await this.client.list(relativePath, signal);
    const prefix = relativePath === '' ? '' : `${relativePath.replace(/\/+$/, '')}/`;
    const basePath = this.rootBasePath;
    for (const entry of entries) {
      if (signal.aborted) return;
      // Skip the collection itself.
      const rel = entry.path.replace(/^\/+/, '');
      const baseRel = basePath.replace(/^\/+/, '');
      const withoutRoot = rel.startsWith(baseRel) ? rel.slice(baseRel.length) : rel;
      const stripped = withoutRoot.replace(/^\/+/, '');
      if (stripped === '' || stripped === relativePath) continue;
      yield {
        relativePath: `${prefix}${stripped}`,
        isDirectory: entry.isDirectory,
        ...(entry.size !== undefined ? { size: entry.size } : {}),
        ...(entry.mtime !== undefined ? { mtime: entry.mtime } : {}),
        ...(entry.etag !== undefined ? { etag: entry.etag } : {}),
      };
    }
  }

  async stat(locator: MediaLocator, signal: AbortSignal): Promise<SourceStat> {
    const entry = await this.client.stat(locator.relativePath, signal);
    return {
      ...(entry.size !== undefined ? { size: entry.size } : {}),
      ...(entry.mtime !== undefined ? { mtime: entry.mtime } : {}),
      ...(entry.etag !== undefined ? { etag: entry.etag } : {}),
      supportsRange: true, // confirmed per-file at play time (plan §8.1)
    };
  }

  async open(locator: MediaLocator, signal: AbortSignal, rangeHeader?: string): Promise<ReadableResource> {
    const res = await this.client.get(locator.relativePath, {
      ...(rangeHeader ? { rangeHeader } : {}),
      signal,
    });
    return {
      stream: res.stream,
      ...(res.size !== undefined ? { size: res.size } : {}),
      // A 200 is NOT proof of Range support — only a 206 is (plan §8.1:
      // seek capability is probed per-file before playback, and a false
      // positive here would hide unreliable seeking from the UI).
      supportsRange: res.supportsRange,
    };
  }
}
