import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { EventEmitter } from 'events';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openDatabaseAtPath, createStorage } from '../../../src/main/modules/storage/db';
import { createCatalogRepository } from '../../../src/main/modules/catalog/repository';
import { createSecretStore, createStreamHeaderCache, type SecretStore, type StreamHeaderCache } from '../../../src/main/modules/security/secret-store';
import type { SecretCipher } from '../../../src/main/modules/security/secret-store';
import { loadWebDavSecret, WebDavSourceAdapter } from '../../../src/main/modules/library-sources/webdav-source';
import { getAdapterForSource } from '../../../src/main/modules/catalog/source-service';
import { resolvePlayback } from '../../../src/main/modules/player-core/playback-resolver';
import { PlaybackStateManager } from '../../../src/main/modules/playback-state';
import type { PlayerCore } from '../../../src/main/modules/player-core';
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

// ---------------------------------------------------------------------------
// Mock WebDAV host: PROPFIND tree + Range-aware GET
// ---------------------------------------------------------------------------

let server: Server;
let port = 0;
let lastAuth: string | null = null;
/** 'range' | 'no-range' | 'auth-fail' */
let hostMode: 'range' | 'no-range' | 'auth-fail' = 'range';

const MOVIE_BODY = '0123456789'.repeat(100); // 1000 bytes

function multistatus(entries: Array<{ href: string; dir?: boolean; size?: number; mtime?: string; etag?: string }>): string {
  const blocks = entries
    .map(
      (e) => `<D:response><D:href>${e.href}</D:href><D:propstat><D:prop>` +
        (e.dir ? '<D:resourcetype><D:collection/></D:resourcetype>' : '<D:resourcetype/>') +
        (e.size !== undefined ? `<D:getcontentlength>${e.size}</D:getcontentlength>` : '') +
        (e.mtime ? `<D:getlastmodified>${e.mtime}</D:getlastmodified>` : '') +
        (e.etag ? `<D:getetag>&quot;${e.etag}&quot;</D:getetag>` : '') +
        '</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>'
    )
    .join('');
  return `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">${blocks}</D:multistatus>`;
}

function handle(req: IncomingMessage, res: ServerResponse, body: string): void {
  lastAuth = (req.headers.authorization as string) ?? null;
  if (hostMode === 'auth-fail') {
    res.writeHead(401);
    res.end();
    return;
  }
  if (req.method === 'PROPFIND') {
    const depth = req.headers.depth;
    if (depth === '0') {
      res.writeHead(207, { 'Content-Type': 'application/xml' });
      res.end(
        multistatus([{ href: req.url ?? '/wd/', dir: true, etag: 'root-etag' }])
      );
      return;
    }
    res.writeHead(207, { 'Content-Type': 'application/xml' });
    res.end(
      multistatus([
        { href: '/wd/', dir: true },
        { href: '/wd/Movies/', dir: true },
        { href: '/wd/Movies/%E7%94%B5%E5%BD%B1.mkv', size: MOVIE_BODY.length, mtime: 'Wed, 12 Feb 2020 10:00:00 GMT', etag: 'm-etag' },
      ])
    );
    void body;
    return;
  }
  if (req.method === 'GET' && (req.url ?? '').startsWith('/wd/Movies/')) {
    const range = req.headers.range;
    if (hostMode === 'range' && typeof range === 'string') {
      const match = range.match(/bytes=(\d+)-(\d*)/);
      const start = match ? Number(match[1]) : 0;
      const end = match?.[2] ? Math.min(Number(match[2]), MOVIE_BODY.length - 1) : Math.min(start, MOVIE_BODY.length - 1);
      const slice = MOVIE_BODY.slice(start, end + 1);
      res.writeHead(206, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': Buffer.byteLength(slice),
        'Content-Range': `bytes ${start}-${end}/${MOVIE_BODY.length}`,
      });
      res.end(slice);
      return;
    }
    // No-Range host (or no Range header): full 200, silently ignoring ranges.
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': MOVIE_BODY.length });
    res.end(MOVIE_BODY);
    return;
  }
  res.writeHead(404);
  res.end();
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => handle(req, res, Buffer.concat(chunks).toString('utf8')));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const baseUrl = (): string => `http://127.0.0.1:${port}/wd`;

let dbDir: string;
let db: BetterSqlite3.Database;
let secretStore: SecretStore;
let streamHeaders: StreamHeaderCache;

beforeEach(() => {
  dbDir = mkdtempSync(join(tmpdir(), 'qy-wdplay-'));
  db = openDatabaseAtPath(join(dbDir, 'catalog.db'));
  secretStore = createSecretStore(db, testCipher());
  streamHeaders = createStreamHeaderCache();
  hostMode = 'range';
  lastAuth = null;
});

afterEach(() => {
  db.close();
  rmSync(dbDir, { recursive: true, force: true });
});

function seedWebdavSource(withSecret: boolean): { sourceId: number; itemId: number } {
  const repo = createCatalogRepository(db);
  const sourceId = repo.createSource({ kind: 'webdav', name: '云盘', root: baseUrl() });
  if (withSecret) {
    secretStore.setSecret('webdav', String(sourceId), JSON.stringify({ username: 'u', password: 's3cret' }));
    repo.setSourceSecret(sourceId, `sec:webdav:${sourceId}`);
  }
  const itemId = repo.upsertItem({ sourceId, sourceKey: 'movie:m', kind: 'movie', title: '云电影' });
  repo.upsertFile({ sourceId, itemId, relativePath: 'Movies/电影.mkv', size: MOVIE_BODY.length, mtime: 1 });
  return { sourceId, itemId };
}

async function resolve(sourceId: number, itemId: number, resume = 0) {
  return resolvePlayback(
    {
      db,
      storage: createStorage(db),
      secretStore,
      streamHeaders,
      getResumePosition: () => resume,
      createOnlineClient: (() => {
        throw new Error('unused in webdav tests');
      }) as never,
      newSessionId: (() => {
        let n = 0;
        return () => `sess-${(n += 1)}`;
      })(),
    },
    { ref: { provider: 'catalog', sourceId, itemId: String(itemId) } }
  );
}

describe('webdav playback', () => {
  it('probes Range (206) and streams with the auth session', async () => {
    const { sourceId, itemId } = seedWebdavSource(true);
    const resolution = await resolve(sourceId, itemId);
    expect(resolution.kind).toBe('webdav-stream');
    expect(resolution.seekable).toBe(true);
    expect(resolution.url).toBe(`${baseUrl()}/Movies/%E7%94%B5%E5%BD%B1.mkv`);
    expect(resolution.streamSessionId).toBeDefined();
    const header = streamHeaders.take(resolution.streamSessionId!);
    expect(header).toBe(`Authorization: Basic ${Buffer.from('u:s3cret').toString('base64')}`);
    expect(lastAuth).toBe(`Basic ${Buffer.from('u:s3cret').toString('base64')}`);
    expect(JSON.stringify(resolution)).not.toContain('s3cret');
  });

  it('degrades explicitly when the host ignores Range (200)', async () => {
    hostMode = 'no-range';
    const { sourceId, itemId } = seedWebdavSource(true);
    const resolution = await resolve(sourceId, itemId);
    expect(resolution.seekable).toBe(false);
    // Playback still proceeds: URL + session + resume are all present.
    expect(resolution.url).toContain('/Movies/');
    expect(resolution.streamSessionId).toBeDefined();
  });

  it('keeps stored progress when the host is offline', async () => {
    const repo = createCatalogRepository(db);
    const sourceId = repo.createSource({ kind: 'webdav', name: '挂了', root: 'http://127.0.0.1:1/gone' });
    const itemId = repo.upsertItem({ sourceId, sourceKey: 'movie:g', kind: 'movie', title: 'G' });
    repo.upsertFile({ sourceId, itemId, relativePath: 'g.mkv', size: 1, mtime: 1 });
    repo.upsertUserState({ itemId, position: 600, duration: 3600 });

    await expect(resolve(sourceId, itemId)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    // The stored row is untouched — nothing zeroes it on failure.
    expect(repo.getUserState(itemId)).toMatchObject({ position: 600, duration: 3600, is_finished: 0 });
  });

  it('maps expired credentials to NO_CREDENTIAL', async () => {
    hostMode = 'auth-fail';
    const { sourceId, itemId } = seedWebdavSource(true);
    await expect(resolve(sourceId, itemId)).rejects.toMatchObject({ code: 'NO_CREDENTIAL' });
  });

  it('goes through the production adapter factory', async () => {
    const { sourceId } = seedWebdavSource(true);
    const { adapter } = getAdapterForSource(db, sourceId, secretStore);
    expect(adapter.kind).toBe('webdav');
    expect(adapter instanceof WebDavSourceAdapter).toBe(true);
    expect(loadWebDavSecret(secretStore, sourceId)).toEqual({ username: 'u', password: 's3cret' });
  });
});

describe('playback progress: streams never finish early', () => {
  // Same sink shape the IPC layer wires (mediaId `<sourceId>:<relPath>`).
  function managerWithState(sourceId: number, currentTime: number, duration: number) {
    const repo = createCatalogRepository(db);
    const emitter = new EventEmitter() as PlayerCore;
    (emitter as unknown as { getState: () => { currentTime: number; duration: number } }).getState = () => ({
      currentTime,
      duration,
    });
    const sink = {
      save: (mediaType: string, mediaId: string, position: number, dur: number, isFinished: boolean) => {
        const sep = mediaId.indexOf(':');
        const file = repo.getFileByPath(Number(mediaId.slice(0, sep)), mediaId.slice(sep + 1));
        if (file) repo.upsertUserState({ itemId: file.item_id, position, duration: dur, isFinished });
        void mediaType;
      },
      getResumePosition: () => 0,
    };
    const manager = new PlaybackStateManager(emitter, createStorage(db), sink);
    manager.init();
    return { manager, emitter, itemIdOf: (rel: string) => repo.getFileByPath(sourceId, rel)!.item_id };
  }

  function seedFile(sourceId: number, rel: string): void {
    const repo = createCatalogRepository(db);
    const itemId = repo.upsertItem({ sourceId, sourceKey: `video:${rel}`, kind: 'video', title: rel });
    repo.upsertFile({ sourceId, itemId, relativePath: rel, size: 1, mtime: 1 });
  }

  it('an early EOF (dropped stream) does not mark finished', () => {
    const repo = createCatalogRepository(db);
    const sourceId = repo.createSource({ kind: 'webdav', name: 'w', root: 'http://h/d' });
    seedFile(sourceId, 'Movies/x.mkv');
    const { manager, emitter, itemIdOf } = managerWithState(sourceId, 720, 3600); // 20%
    manager.setCurrentMedia('webdav', `${sourceId}:Movies/x.mkv`, 'X');
    emitter.emit('eof');
    const row = repo.getUserState(itemIdOf('Movies/x.mkv'))!;
    expect(row.position).toBe(720);
    expect(row.is_finished).toBe(0);
    manager.destroy();
  });

  it('a natural EOF near the end still marks finished', () => {
    const repo = createCatalogRepository(db);
    const sourceId = repo.createSource({ kind: 'webdav', name: 'w', root: 'http://h/d' });
    seedFile(sourceId, 'Movies/x.mkv');
    const { manager, emitter, itemIdOf } = managerWithState(sourceId, 3500, 3600); // 97%
    manager.setCurrentMedia('webdav', `${sourceId}:Movies/x.mkv`, 'X');
    emitter.emit('eof');
    const row = repo.getUserState(itemIdOf('Movies/x.mkv'))!;
    expect(row.is_finished).toBe(1);
    manager.destroy();
  });
});
