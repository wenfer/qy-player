import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The store only touches electron's safeStorage through the injectable
// cipher, but the module imports it; stub the module for plain Node.
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (plain: string) => Buffer.from(plain),
    decryptString: (blob: Buffer) => blob.toString('utf-8'),
  },
  app: { getPath: (name: string) => join(tmpdir(), 'qy-secret-test', name) },
}));

import { openDatabaseAtPath, createStorage } from '../../../src/main/modules/storage/db';
import type { SecretCipher } from '../../../src/main/modules/security/secret-store';
import {
  MEDIA_SERVER_NAMESPACE,
  assertNotSecretConfigKey,
  createSecretStore,
  formatSecretRef,
  migrateServerTokensToSecretStore,
  parseSecretRef,
  resolveServerApiKey,
  sanitizeServerForRenderer,
} from '../../../src/main/modules/security/secret-store';

const tmpRoots: string[] = [];
afterAll(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
});

function makeDb(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), 'qy-secret-'));
  tmpRoots.push(dir);
  return openDatabaseAtPath(join(dir, 'test.db'));
}

/** Reversible toy cipher (XOR 0x5a) standing in for safeStorage. */
function xorCipher(): SecretCipher {
  const xor = (b: Buffer): Buffer => {
    const out = Buffer.from(b);
    for (let i = 0; i < out.length; i++) out[i] ^= 0x5a;
    return out;
  };
  return {
    isEncryptionAvailable: () => true,
    encrypt: (plain) => xor(Buffer.from(plain, 'utf-8')),
    decrypt: (payload) => xor(Buffer.from(payload)).toString('utf-8'),
  };
}

function corruptCipher(): SecretCipher {
  return {
    isEncryptionAvailable: () => true,
    encrypt: (plain) => Buffer.from(plain, 'utf-8'),
    // "Decrypts" to something that never matches the plaintext.
    decrypt: () => 'garbage',
  };
}

describe('SecretStore', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });

  describe('encrypted persistence', () => {
    it('round-trips a secret through app_config without storing plaintext', () => {
      const store = createSecretStore(db, xorCipher());
      store.setSecret('webdav', 'source-1', 'S3cret-Pass!');
      expect(store.getSecret('webdav', 'source-1')).toBe('S3cret-Pass!');
      expect(store.hasSecret('webdav', 'source-1')).toBe(true);

      // Raw row must exist but must not contain the plaintext anywhere.
      const raw = db
        .prepare("SELECT value FROM app_config WHERE key LIKE 'secret:%'")
        .get() as { value: string };
      expect(raw).toBeDefined();
      expect(raw.value).not.toContain('S3cret-Pass!');
    });

    it('isolates namespaces', () => {
      const store = createSecretStore(db, xorCipher());
      store.setSecret('webdav', 'source-1', 'dav-password');
      store.setSecret('plugin-tmdb', 'api-key', 'tmdb-key-123');
      expect(store.getSecret('webdav', 'source-1')).toBe('dav-password');
      expect(store.getSecret('plugin-tmdb', 'api-key')).toBe('tmdb-key-123');
      store.deleteSecret('webdav', 'source-1');
      expect(store.hasSecret('webdav', 'source-1')).toBe(false);
      expect(store.hasSecret('plugin-tmdb', 'api-key')).toBe(true);
    });

    it('round-trips through secret refs', () => {
      const store = createSecretStore(db, xorCipher());
      const ref = formatSecretRef('plugin-douban', 'cookie');
      expect(parseSecretRef(ref)).toEqual({ namespace: 'plugin-douban', key: 'cookie' });
      store.setSecretByRef(ref, 'douban-value');
      expect(store.getSecretByRef(ref)).toBe('douban-value');
      expect(store.hasSecretByRef(formatSecretRef('plugin-douban', 'other'))).toBe(false);
      store.deleteSecretByRef(ref);
      expect(store.hasSecretByRef(ref)).toBe(false);
      expect(parseSecretRef('bogus')).toBeNull();
    });

    it('rejects malformed namespaces and keys', () => {
      const store = createSecretStore(db, xorCipher());
      expect(() => store.setSecret('Bad_NS', 'k', 'v')).toThrow();
      expect(() => store.setSecret('webdav', '../escape', 'v')).toThrow();
      expect(() => store.setSecret('webdav', '', 'v')).toThrow();
      expect(store.hasSecret('webdav', 'k')).toBe(false);
    });

    it('deletes secrets', () => {
      const store = createSecretStore(db, xorCipher());
      store.setSecret('webdav', 'source-1', 'pw');
      store.deleteSecret('webdav', 'source-1');
      expect(store.getSecret('webdav', 'source-1')).toBeNull();
    });
  });

  describe('session-only fallback (encryption unavailable)', () => {
    it('keeps secrets in memory and never persists them', () => {
      const unavailable: SecretCipher = { ...xorCipher(), isEncryptionAvailable: () => false };
      const store = createSecretStore(db, unavailable);
      store.setSecret('webdav', 'source-1', 'session-only');
      expect(store.getSecret('webdav', 'source-1')).toBe('session-only');

      // Nothing may land in app_config.
      const rows = db.prepare("SELECT COUNT(*) AS n FROM app_config WHERE key LIKE 'secret:%'").get() as { n: number };
      expect(rows.n).toBe(0);

      // A new store instance (fresh session) must NOT see it.
      const fresh = createSecretStore(db, unavailable);
      expect(fresh.hasSecret('webdav', 'source-1')).toBe(false);
    });
  });

  describe('readback verification', () => {
    it('throws and removes the record when decryption does not round-trip', () => {
      const store = createSecretStore(db, corruptCipher());
      expect(() => store.setSecret('webdav', 'source-1', 'pw')).toThrow(/readback/i);
      const rows = db.prepare("SELECT COUNT(*) AS n FROM app_config WHERE key LIKE 'secret:%'").get() as { n: number };
      expect(rows.n).toBe(0);
    });
  });
});

describe('server token migration (plan §8.3)', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });

  it('moves plaintext tokens into the store, then clears the column', () => {
    const storage = createStorage(db);
    const id = storage.saveServer({
      type: 'jellyfin',
      name: 'Home',
      baseUrl: 'http://192.168.1.10:8096',
      username: 'qiuyuan',
      userId: 'u-123',
      isActive: true,
    });
    // Simulate a phase-1 database where the token was stored in plaintext
    // (new code never writes plaintext to this column).
    db.prepare('UPDATE servers SET api_key = ? WHERE id = ?').run('legacy-plain-token', id);
    const store = createSecretStore(db, xorCipher());

    const migrated = migrateServerTokensToSecretStore(db, storage.getServers(), store);
    expect(migrated).toBe(1);
    expect(store.getSecret(MEDIA_SERVER_NAMESPACE, String(id))).toBe('legacy-plain-token');

    // Plaintext cleared only after successful readback.
    const row = db.prepare('SELECT api_key FROM servers WHERE id = ?').get(id) as { api_key: string | null };
    expect(row.api_key).toBeNull();

    // Re-run is a no-op.
    expect(migrateServerTokensToSecretStore(db, storage.getServers(), store)).toBe(0);
  });

  it('keeps plaintext when readback verification fails', () => {
    const storage = createStorage(db);
    storage.saveServer({
      type: 'emby',
      name: 'Old',
      baseUrl: 'http://192.168.1.20:8096',
      isActive: true,
    });
    db.prepare('UPDATE servers SET api_key = ?').run('must-survive');
    const store = createSecretStore(db, corruptCipher());

    expect(() => migrateServerTokensToSecretStore(db, storage.getServers(), store)).toThrow();
    const row = db.prepare('SELECT api_key FROM servers').get() as { api_key: string | null };
    expect(row.api_key).toBe('must-survive');
  });
});

describe('renderer-facing sanitization', () => {
  it('projects hasCredential and never leaks api_key', () => {
    const localDb = makeDb();
    const store = createSecretStore(localDb, xorCipher());
    store.setSecret(MEDIA_SERVER_NAMESPACE, '7', 'token-xyz');

    const sanitized = sanitizeServerForRenderer(
      { id: 7, type: 'jellyfin', name: 'N', base_url: 'http://x', username: 'u', user_id: 'uid', is_active: 1, api_key: undefined },
      store
    );
    expect(sanitized.hasCredential).toBe(true);
    expect(JSON.stringify(sanitized)).not.toContain('token-xyz');
    expect('api_key' in sanitized).toBe(false);
  });

  it('falls back to the legacy column when the store is empty', () => {
    const localDb = makeDb();
    const store = createSecretStore(localDb, xorCipher());
    const sanitized = sanitizeServerForRenderer(
      { id: 8, type: 'emby', name: 'N', base_url: 'http://y', is_active: 1, api_key: 'legacy' },
      store
    );
    expect(sanitized.hasCredential).toBe(true);
  });

  it('resolveServerApiKey prefers the store over the legacy column', () => {
    const localDb = makeDb();
    const store = createSecretStore(localDb, xorCipher());
    store.setSecret(MEDIA_SERVER_NAMESPACE, '9', 'from-store');
    expect(resolveServerApiKey({ id: 9, api_key: 'legacy' }, store)).toBe('from-store');
    expect(resolveServerApiKey({ id: 10, api_key: 'legacy' }, store)).toBe('legacy');
    expect(resolveServerApiKey({ id: 11 }, store)).toBeNull();
  });
});

describe('settings channel guard', () => {
  it('blocks secret config keys', () => {
    expect(() => assertNotSecretConfigKey('secret:media-server:1')).toThrow();
    expect(() => assertNotSecretConfigKey('shortcuts')).not.toThrow();
  });
});
