import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabaseAtPath } from '../../../src/main/modules/storage/db';
import { createSecretStore, type SecretStore, MEDIA_SERVER_NAMESPACE } from '../../../src/main/modules/security/secret-store';
import type { SecretCipher } from '../../../src/main/modules/security/secret-store';
import type { createStorage } from '../../../src/main/modules/storage/db';
import { bindOnlineServer } from '../../../src/main/modules/player-core/playback-resolver';
import type BetterSqlite3 from 'better-sqlite3';

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

let dbDir: string;
let db: BetterSqlite3.Database;
let secretStore: SecretStore;

interface ServerRow {
  id: number;
  type: string;
  name: string;
  base_url: string;
  api_key?: string;
  username?: string;
  user_id?: string;
  is_active: number;
}

let servers: ServerRow[];
function storageOf() {
  return { getServers: () => servers } as unknown as ReturnType<typeof createStorage>;
}

beforeEach(() => {
  dbDir = mkdtempSync(join(tmpdir(), 'qy-routing-'));
  db = openDatabaseAtPath(join(dbDir, 'catalog.db'));
  secretStore = createSecretStore(db, testCipher());
  servers = [];
});

afterEach(() => {
  db.close();
  rmSync(dbDir, { recursive: true, force: true });
});

describe('strict online server routing', () => {
  it('two servers with the same item never share a binding', () => {
    servers = [
      { id: 1, type: 'jellyfin', name: '家', base_url: 'http://home:8096', user_id: 'u1', is_active: 1 },
      { id: 2, type: 'jellyfin', name: '公司', base_url: 'http://work:8096', user_id: 'u2', is_active: 1 },
    ];
    secretStore.setSecret(MEDIA_SERVER_NAMESPACE, '1', 'home-token');
    secretStore.setSecret(MEDIA_SERVER_NAMESPACE, '2', 'work-token');
    const storage = storageOf();
    const home = bindOnlineServer(storage, secretStore, 'jellyfin', 1);
    const work = bindOnlineServer(storage, secretStore, 'jellyfin', 2);
    expect(home).toMatchObject({ baseUrl: 'http://home:8096', apiKey: 'home-token', userId: 'u1' });
    expect(work).toMatchObject({ baseUrl: 'http://work:8096', apiKey: 'work-token', userId: 'u2' });
    expect(home.apiKey).not.toBe(work.apiKey);
  });

  it('routes by id even when one server is inactive', () => {
    servers = [
      { id: 1, type: 'jellyfin', name: 'A', base_url: 'http://a:8096', user_id: 'u1', is_active: 0 },
      { id: 2, type: 'jellyfin', name: 'B', base_url: 'http://b:8096', user_id: 'u2', is_active: 1 },
    ];
    secretStore.setSecret(MEDIA_SERVER_NAMESPACE, '1', 'a-token');
    const storage = storageOf();
    // Explicit id lookup, not "first active" — a saved ref always resolves
    // to its own server record.
    expect(bindOnlineServer(storage, secretStore, 'jellyfin', 1).apiKey).toBe('a-token');
    expect(() => bindOnlineServer(storage, secretStore, 'jellyfin', 99)).toThrowError(
      expect.objectContaining({ code: 'SERVER_NOT_FOUND' })
    );
  });

  it('rejects provider mismatches (jellyfin id used as emby)', () => {
    servers = [{ id: 1, type: 'jellyfin', name: 'A', base_url: 'http://a:8096', user_id: 'u1', is_active: 1 }];
    secretStore.setSecret(MEDIA_SERVER_NAMESPACE, '1', 'a-token');
    expect(() => bindOnlineServer(storageOf(), secretStore, 'emby', 1)).toThrowError(
      expect.objectContaining({ code: 'SERVER_NOT_FOUND' })
    );
  });

  it('requires both a resolvable key and a user id', () => {
    servers = [{ id: 1, type: 'jellyfin', name: 'A', base_url: 'http://a:8096', user_id: 'u1', is_active: 1 }];
    // No secret stored → credential error, never a null-key client.
    expect(() => bindOnlineServer(storageOf(), secretStore, 'jellyfin', 1)).toThrowError(
      expect.objectContaining({ code: 'NO_CREDENTIAL' })
    );
    secretStore.setSecret(MEDIA_SERVER_NAMESPACE, '1', 'a-token');
    servers = [{ id: 1, type: 'jellyfin', name: 'A', base_url: 'http://a:8096', is_active: 1 }];
    expect(() => bindOnlineServer(storageOf(), secretStore, 'jellyfin', 1)).toThrowError(
      expect.objectContaining({ code: 'NO_CREDENTIAL' })
    );
  });

  it('never surfaces credentials in error text', () => {
    servers = [{ id: 1, type: 'jellyfin', name: 'A', base_url: 'http://a:8096', user_id: 'u1', is_active: 1 }];
    try {
      bindOnlineServer(storageOf(), secretStore, 'jellyfin', 1);
      expect.unreachable();
    } catch (err) {
      expect(String((err as Error).message)).not.toContain('a-token');
      expect(String((err as Error).message)).not.toContain('token');
    }
  });
});
