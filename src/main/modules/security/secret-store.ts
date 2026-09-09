import type Database from 'better-sqlite3';
import { safeStorage } from 'electron';

/**
 * Phase-2 secret storage (plan §8.3).
 *
 * - One abstraction for WebDAV passwords, plugin keys and media-server tokens,
 *   isolated by namespace.
 * - When the OS-level encryption (Electron safeStorage) is available, secrets
 *   are persisted encrypted into app_config under `secret:` keys.
 * - When it is NOT available, secrets live only for the session and the UI
 *   must prompt re-entry after a restart. Plaintext persistence requires an
 *   explicit, separately-approved decision and is NOT implemented here.
 * - Plaintext never leaves this module: IPC outputs expose hasCredential.
 */

export interface SecretCipher {
  isEncryptionAvailable(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(payload: Buffer): string;
}

/** Real cipher backed by Electron safeStorage. */
export function createSafeStorageCipher(): SecretCipher {
  return {
    isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plain) => safeStorage.encryptString(plain),
    decrypt: (payload) => safeStorage.decryptString(payload),
  };
}

export const MEDIA_SERVER_NAMESPACE = 'media-server';
export const SECRET_CONFIG_PREFIX = 'secret:';
const SCHEME = 'safeStorage-v1';

const NAMESPACE_RE = /^[a-z][a-z0-9-]{0,31}$/;
// ':' is excluded from both namespaces and keys so `sec:<ns>:<key>` refs
// stay unambiguous.
const KEY_RE = /^[A-Za-z0-9_.-]{1,128}$/;

export interface ParsedSecretRef {
  namespace: string;
  key: string;
}

/** Ref format: `sec:<namespace>:<key>` (stored in *_secret_ref columns). */
export function formatSecretRef(namespace: string, key: string): string {
  validateNamespace(namespace);
  validateKey(key);
  return `sec:${namespace}:${key}`;
}

export function parseSecretRef(ref: string): ParsedSecretRef | null {
  if (!ref.startsWith('sec:')) return null;
  const rest = ref.slice('sec:'.length);
  const sep = rest.indexOf(':');
  if (sep <= 0) return null;
  const namespace = rest.slice(0, sep);
  const key = rest.slice(sep + 1);
  if (!NAMESPACE_RE.test(namespace) || !KEY_RE.test(key)) return null;
  return { namespace, key };
}

function validateNamespace(namespace: string): void {
  if (!NAMESPACE_RE.test(namespace)) {
    throw new Error(`Invalid secret namespace: ${namespace}`);
  }
}

function validateKey(key: string): void {
  if (!KEY_RE.test(key)) {
    throw new Error(`Invalid secret key: ${key}`);
  }
}

/** Renderer-facing servers must never contain credentials, only the flag. */
export interface SanitizedServer {
  id: number;
  type: string;
  name: string;
  base_url: string;
  username?: string;
  user_id?: string;
  is_active: number;
  hasCredential: boolean;
}

export interface SecretStore {
  /** True when secrets survive a restart; false means session-only mode. */
  isPersistent(): boolean;
  /** Persists (encrypted) or holds session-only; throws if readback fails. */
  setSecret(namespace: string, key: string, value: string): void;
  getSecret(namespace: string, key: string): string | null;
  hasSecret(namespace: string, key: string): boolean;
  deleteSecret(namespace: string, key: string): void;
  setSecretByRef(ref: string, value: string): void;
  getSecretByRef(ref: string): string | null;
  hasSecretByRef(ref: string): boolean;
  deleteSecretByRef(ref: string): void;
}

interface StoredRecord {
  v: 1;
  scheme: typeof SCHEME;
  data: string;
}

export function createSecretStore(
  db: Database.Database,
  cipher: SecretCipher = createSafeStorageCipher()
): SecretStore {
  // Session-only fallback secrets: never written to disk (plan §8.3).
  const sessionSecrets = new Map<string, string>();

  const storageKey = (namespace: string, key: string): string =>
    `${SECRET_CONFIG_PREFIX}${namespace}:${key}`;

  const upsertConfig = (storageKey: string, value: string): void => {
    db.prepare(
      `INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, unixepoch())
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()`
    ).run(storageKey, value);
  };

  const readConfig = (storageKey: string): string | undefined => {
    const row = db.prepare('SELECT value FROM app_config WHERE key = ?').get(storageKey) as
      | { value: string }
      | undefined;
    return row?.value;
  };

  const deleteConfig = (storageKey: string): void => {
    db.prepare('DELETE FROM app_config WHERE key = ?').run(storageKey);
  };

  const readRecord = (namespace: string, key: string): { value: string; persisted: boolean } | null => {
    const skey = storageKey(namespace, key);
    const raw = readConfig(skey);
    if (raw) {
      try {
        const record = JSON.parse(raw) as StoredRecord;
        if (record?.scheme !== SCHEME) return null;
        const value = cipher.decrypt(Buffer.from(record.data, 'base64'));
        return { value, persisted: true };
      } catch {
        // Unreadable blob (e.g. keyring lost): treat as absent; the next
        // setSecret overwrites it.
        return null;
      }
    }
    const session = sessionSecrets.get(skey);
    return session !== undefined ? { value: session, persisted: false } : null;
  };

  const store: SecretStore = {
    isPersistent: () => cipher.isEncryptionAvailable(),

    setSecret(namespace, key, value) {
      validateNamespace(namespace);
      validateKey(key);
      const skey = storageKey(namespace, key);
      if (cipher.isEncryptionAvailable()) {
        const record: StoredRecord = {
          v: 1,
          scheme: SCHEME,
          data: cipher.encrypt(value).toString('base64'),
        };
        upsertConfig(skey, JSON.stringify(record));
        // Readback verification is mandatory: callers may only clear legacy
        // plaintext after this has succeeded (plan §8.3).
        const verified = readRecord(namespace, key);
        if (verified?.value !== value) {
          deleteConfig(skey);
          throw new Error(`Secret readback verification failed for ${namespace}`);
        }
      } else {
        // Session-only: survives until the process exits, never persisted.
        sessionSecrets.set(skey, value);
        deleteConfig(skey); // drop any stale encrypted blob from a previous run
      }
    },

    getSecret(namespace, key) {
      validateNamespace(namespace);
      validateKey(key);
      return readRecord(namespace, key)?.value ?? null;
    },

    hasSecret(namespace, key) {
      return store.getSecret(namespace, key) !== null;
    },

    deleteSecret(namespace, key) {
      validateNamespace(namespace);
      validateKey(key);
      sessionSecrets.delete(storageKey(namespace, key));
      deleteConfig(storageKey(namespace, key));
    },

    setSecretByRef(ref, value) {
      const parsed = parseSecretRef(ref);
      if (!parsed) throw new Error(`Invalid secret ref: ${ref}`);
      store.setSecret(parsed.namespace, parsed.key, value);
    },

    getSecretByRef(ref) {
      const parsed = parseSecretRef(ref);
      return parsed ? store.getSecret(parsed.namespace, parsed.key) : null;
    },

    hasSecretByRef(ref) {
      const parsed = parseSecretRef(ref);
      return parsed ? store.hasSecret(parsed.namespace, parsed.key) : false;
    },

    deleteSecretByRef(ref) {
      const parsed = parseSecretRef(ref);
      if (!parsed) throw new Error(`Invalid secret ref: ${ref}`);
      store.deleteSecret(parsed.namespace, parsed.key);
    },
  };

  return store;
}

/** Renderer-facing server projection: no credentials, only hasCredential. */
export function sanitizeServerForRenderer(
  server: {
    id: number;
    type: string;
    name: string;
    base_url: string;
    username?: string;
    user_id?: string;
    is_active: number;
    api_key?: string;
  },
  store: SecretStore
): SanitizedServer {
  // Same resolution order as resolveServerApiKey so the UI flag can never
  // claim a login that the API-key resolution cannot back up.
  const resolvable = resolveServerApiKey(server, store) !== null;
  return {
    id: server.id,
    type: server.type,
    name: server.name,
    base_url: server.base_url,
    username: server.username,
    user_id: server.user_id,
    is_active: server.is_active,
    hasCredential: resolvable,
  };
}

/**
 * Resolve the working API key for a server: SecretStore first, then the
 * legacy plaintext column (pre-migration edge). Never log the result.
 */
export function resolveServerApiKey(
  server: { id: number; api_key?: string },
  store: SecretStore
): string | null {
  return store.getSecret(MEDIA_SERVER_NAMESPACE, String(server.id)) ?? server.api_key ?? null;
}

/**
 * One-time migration of phase-1 plaintext server tokens (plan §8.3): write to
 * the store, verify readback, and only then clear the legacy column. Never
 * deletes rows; re-runs are no-ops.
 */
export function migrateServerTokensToSecretStore(
  db: Database.Database,
  servers: Array<{ id: number; api_key?: string }>,
  store: SecretStore
): number {
  // Session-only mode: moving the token out of the legacy column would lose
  // it on restart. Keep plaintext until a persistent store is available.
  if (!store.isPersistent()) return 0;
  let migrated = 0;
  for (const server of servers) {
    if (!server.api_key) continue;
    // Throws on readback failure -> legacy plaintext stays untouched.
    store.setSecret(MEDIA_SERVER_NAMESPACE, String(server.id), server.api_key);
    db.prepare('UPDATE servers SET api_key = NULL WHERE id = ?').run(server.id);
    migrated += 1;
  }
  return migrated;
}

/**
 * Bounded cache for stream request headers (e.g. X-Emby-Token) so tokens
 * never cross the IPC boundary: the renderer receives only an opaque session
 * id and the main process attaches the real headers when loading the file.
 */
export interface StreamHeaderCache {
  stash(sessionId: string, headers: string): void;
  take(sessionId: string): string | undefined;
}

export function createStreamHeaderCache(maxEntries = 16): StreamHeaderCache {
  const entries = new Map<string, { headers: string; createdAt: number }>();
  return {
    stash(sessionId, headers) {
      if (entries.size >= maxEntries) {
        // FIFO: drop the oldest stashed session.
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
      entries.set(sessionId, { headers, createdAt: Date.now() });
    },
    take(sessionId) {
      const entry = entries.get(sessionId);
      if (!entry) return undefined;
      entries.delete(sessionId); // single-use: headers live as long as needed
      return entry.headers;
    },
  };
}

/** app_config keys under this prefix must never cross the IPC boundary. */
export function assertNotSecretConfigKey(key: string): void {
  if (typeof key === 'string' && key.startsWith(SECRET_CONFIG_PREFIX)) {
    throw new Error('Refusing to read/write a secret config key through the settings channel');
  }
}
