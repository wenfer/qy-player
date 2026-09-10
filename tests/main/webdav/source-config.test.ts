import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabaseAtPath } from '../../../src/main/modules/storage/db';
import { createCatalogRepository } from '../../../src/main/modules/catalog/repository';
import {
  createWebDavSource,
  getAdapterForSource,
  removeSource,
  testWebDavConnection,
} from '../../../src/main/modules/catalog/source-service';
import { createSecretStore, type SecretCipher } from '../../../src/main/modules/security/secret-store';
import type { SecretStore } from '../../../src/main/modules/security/secret-store';
import type BetterSqlite3 from 'better-sqlite3';

let dbDir: string;
let db: BetterSqlite3.Database;
let secretStore: SecretStore;

/** XOR cipher so the test runs without Electron's safeStorage. */
function testCipher(): SecretCipher {
  const xor = (b: Buffer): Buffer => {
    const out = Buffer.from(b);
    for (let i = 0; i < out.length; i += 1) out[i] ^= 0x5a;
    return out;
  };
  return {
    isEncryptionAvailable: () => true,
    encrypt: (plain) => xor(Buffer.from(plain, 'utf-8')),
    decrypt: (payload) => xor(Buffer.from(payload)).toString('utf-8'),
  };
}

beforeEach(() => {
  dbDir = mkdtempSync(join(tmpdir(), 'qy-webdav-cfg-'));
  db = openDatabaseAtPath(join(dbDir, 'catalog.db'));
  secretStore = createSecretStore(db, testCipher());
});

afterEach(() => {
  db.close();
  rmSync(dbDir, { recursive: true, force: true });
});

const HTTPS_INPUT = {
  kind: 'webdav' as const,
  url: 'https://example.com:5005/dav',
  name: '家庭云盘',
  username: 'alice',
  password: 'secret-password',
};

describe('createWebDavSource', () => {
  it('normalizes the URL and stores credentials only in the SecretStore', () => {
    const created = createWebDavSource(db, secretStore, HTTPS_INPUT);
    expect(created.sourceId).toBeGreaterThan(0);
    expect(created.root).toBe('https://example.com:5005/dav');
    const repo = createCatalogRepository(db);
    const row = repo.getSource(created.sourceId)!;
    expect(row.kind).toBe('webdav');
    // The password never lands in the source row or any config column.
    expect(row.root).not.toContain('secret-password');
    expect(row.secret_ref).toBe(`webdav:${created.sourceId}`);
    expect(secretStore.hasSecret('webdav', String(created.sourceId))).toBe(true);
    const raw = db
      .prepare("SELECT value FROM app_config WHERE key LIKE 'secret:%'")
      .all() as Array<{ value: string }>;
    for (const r of raw) expect(r.value).not.toContain('secret-password');
  });

  it('refuses http:// without explicit plaintext consent', () => {
    expect(() =>
      createWebDavSource(db, secretStore, { ...HTTPS_INPUT, url: 'http://example.com/dav' })
    ).toThrow(/明文/);
  });

  it('saves http:// after explicit consent', () => {
    const created = createWebDavSource(db, secretStore, {
      ...HTTPS_INPUT,
      url: 'http://example.com/dav',
      confirmHttpPlaintext: true,
    });
    expect(created.root).toBe('http://example.com/dav');
  });

  it('rejects contract-violating URLs (userinfo / query / fragment / scheme)', () => {
    for (const url of [
      'http://user:pass@example.com/dav',
      'https://example.com/dav?token=x',
      'https://example.com/dav#frag',
      'ftp://example.com/dav',
      'not a url',
    ]) {
      expect(() => createWebDavSource(db, secretStore, { ...HTTPS_INPUT, url })).toThrow();
    }
  });

  it('creates credential-less sources without touching the SecretStore', () => {
    const created = createWebDavSource(db, secretStore, {
      kind: 'webdav',
      url: 'https://open.example.com/dav',
    });
    expect(secretStore.hasSecret('webdav', String(created.sourceId))).toBe(false);
    const repo = createCatalogRepository(db);
    expect(repo.getSource(created.sourceId)!.secret_ref).toBeNull();
  });

  it('removes the stored secret together with the source', () => {
    const created = createWebDavSource(db, secretStore, HTTPS_INPUT);
    expect(secretStore.hasSecret('webdav', String(created.sourceId))).toBe(true);
    removeSource(db, created.sourceId, secretStore);
    expect(secretStore.hasSecret('webdav', String(created.sourceId))).toBe(false);
    expect(createCatalogRepository(db).getSource(created.sourceId)).toBeUndefined();
  });
});

describe('getAdapterForSource (webdav branch)', () => {
  it('builds a WebDAV adapter carrying saved credentials', () => {
    const created = createWebDavSource(db, secretStore, HTTPS_INPUT);
    const { adapter, root } = getAdapterForSource(db, created.sourceId, secretStore);
    expect(adapter.kind).toBe('webdav');
    expect(root).toBe('https://example.com:5005/dav');
  });

  it('builds an unauthenticated adapter when no secret exists', () => {
    const created = createWebDavSource(db, secretStore, {
      kind: 'webdav',
      url: 'https://open.example.com/dav',
    });
    const { adapter } = getAdapterForSource(db, created.sourceId, secretStore);
    expect(adapter.kind).toBe('webdav');
  });
});

describe('testWebDavConnection (pre-save)', () => {
  it('refuses http without consent before any network I/O', async () => {
    await expect(
      testWebDavConnection({ ...HTTPS_INPUT, url: 'http://example.com/dav' })
    ).rejects.toThrow(/明文/);
  });

  it('reports an unreachable server as UNAVAILABLE-style error', async () => {
    // Port 1 on localhost: nothing listens there; must fail fast, not hang.
    await expect(
      testWebDavConnection({
        kind: 'webdav',
        url: 'http://127.0.0.1:1/dav',
        confirmHttpPlaintext: true,
      })
    ).rejects.toThrow();
  });
});
