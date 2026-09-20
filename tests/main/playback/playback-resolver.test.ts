import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openDatabaseAtPath } from '../../../src/main/modules/storage/db';
import { createCatalogRepository } from '../../../src/main/modules/catalog/repository';
import { createSecretStore, type SecretStore, type StreamHeaderCache, createStreamHeaderCache, MEDIA_SERVER_NAMESPACE } from '../../../src/main/modules/security/secret-store';
import { createStreamRouteCache } from '../../../src/main/modules/security/stream-route-cache';
import type { SecretCipher } from '../../../src/main/modules/security/secret-store';
import type { createStorage } from '../../../src/main/modules/storage/db';
import {
  bindOnlineServer,
  resolvePlayback,
  type ResolverDeps,
} from '../../../src/main/modules/player-core/playback-resolver';
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
// Fake online client: records which server binding it was created with
// ---------------------------------------------------------------------------

interface FakeDetails {
  Id: string;
  Name: string;
  Type: string;
  SeriesName?: string;
  ParentIndexNumber?: number;
  IndexNumber?: number;
  MediaSources?: Array<{
    Id: string;
    MediaStreams?: Array<{ Type?: string; Codec?: string }>;
  }>;
}

interface ClientCall {
  baseUrl: string;
  apiKey: string;
  kind: 'details' | 'items' | 'stream';
  itemId?: string;
  mediaSourceId?: string;
  mode?: string;
}

function makeClientFactory(detailsByUrl: Record<string, Record<string, FakeDetails>>, calls: ClientCall[]) {
  return (config: { type: string; baseUrl: string; apiKey?: string; userId?: string }) => ({
    async getItemDetails(itemId: string) {
      calls.push({ baseUrl: config.baseUrl, apiKey: config.apiKey ?? '', kind: 'details', itemId });
      const details = detailsByUrl[config.baseUrl]?.[itemId];
      if (!details) throw new Error('not found');
      return details;
    },
    async getItems(parentId: string, _opts: unknown) {
      calls.push({ baseUrl: config.baseUrl, apiKey: config.apiKey ?? '', kind: 'items', itemId: parentId });
      return [];
    },
    getStreamingUrl(itemId: string, mediaSourceId: string, mode: 'direct' | 'transcode') {
      calls.push({ baseUrl: config.baseUrl, apiKey: config.apiKey ?? '', kind: 'stream', itemId, mediaSourceId, mode });
      return `${config.baseUrl}/Videos/${itemId}/stream?ms=${mediaSourceId}&mode=${mode}`;
    },
  });
}

let dbDir: string;
let db: BetterSqlite3.Database;
let secretStore: SecretStore;
let streamHeaders: StreamHeaderCache;
let sessions = 0;
// Minimal mock WebDAV host: answers the seek probe (Range → 206).
let mockServer: Server;
let mockPort = 0;

beforeAll(async () => {
  mockServer = createServer((req, res) => {
    if (req.method === 'PROPFIND') {
      res.writeHead(207, { 'Content-Type': 'application/xml' });
      res.end('<D:multistatus xmlns:D="DAV:"></D:multistatus>');
      return;
    }
    if (req.headers.range) {
      res.writeHead(206, { 'Content-Length': 1, 'Content-Range': 'bytes 0-0/100' });
      res.end('x');
      return;
    }
    res.writeHead(200, { 'Content-Length': 100 });
    res.end('x'.repeat(100));
  });
  await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
  mockPort = (mockServer.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => mockServer.close(() => resolve()));
});
let servers: Array<{
  id: number;
  type: string;
  name: string;
  base_url: string;
  api_key?: string;
  username?: string;
  user_id?: string;
  is_active: number;
}>;

function makeDeps(clientFactory: unknown, resume = 0): ResolverDeps {
  return {
    db,
    storage: {
      getServers: () => servers,
      getProgress: () => undefined,
    } as unknown as ReturnType<typeof createStorage>,
    secretStore,
    streamHeaders,
    streamRoutes: createStreamRouteCache(),
    getResumePosition: () => resume,
    createOnlineClient: clientFactory as ResolverDeps['createOnlineClient'],
    newSessionId: () => `sess-${(sessions += 1)}`,
  };
}

beforeEach(() => {
  dbDir = mkdtempSync(join(tmpdir(), 'qy-resolve-'));
  db = openDatabaseAtPath(join(dbDir, 'catalog.db'));
  secretStore = createSecretStore(db, testCipher());
  streamHeaders = createStreamHeaderCache();
  sessions = 0;
  servers = [];
});

afterEach(() => {
  db.close();
  rmSync(dbDir, { recursive: true, force: true });
});

describe('playback resolver: local catalog', () => {
  it('resolves a movie to an absolute path with media context', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qy-media-'));
    mkdirSync(join(root, 'Movies'));
    writeFileSync(join(root, 'Movies', 'a.mkv'), 'x');
    const repo = createCatalogRepository(db);
    const sourceId = repo.createSource({ kind: 'local', name: 'm', root });
    const itemId = repo.upsertItem({ sourceId, sourceKey: 'movie:a', kind: 'movie', title: '电影A' });
    repo.upsertFile({ sourceId, itemId, relativePath: 'Movies/a.mkv', size: 1, mtime: 1, fingerprint: '1:1' });

    const calls: ClientCall[] = [];
    const resolution = await resolvePlayback(makeDeps(makeClientFactory({}, calls), 45), {
      ref: { provider: 'catalog', sourceId, itemId: String(itemId) },
    });
    expect(resolution.kind).toBe('local-file');
    expect(resolution.url).toBe(join(root, 'Movies', 'a.mkv'));
    expect(resolution.startPosition).toBe(45);
    expect(resolution.mediaContext).toMatchObject({
      mediaType: 'local',
      mediaId: join(root, 'Movies', 'a.mkv'),
      title: '电影A',
    });
    expect(resolution.streamSessionId).toBeUndefined();
    rmSync(root, { recursive: true, force: true });
  });

  it('refuses escaping relative paths', async () => {
    const repo = createCatalogRepository(db);
    const sourceId = repo.createSource({ kind: 'local', name: 'm', root: '/tmp/qy-root' });
    const itemId = repo.upsertItem({ sourceId, sourceKey: 'video:e', kind: 'video', title: 'E' });
    repo.upsertFile({ sourceId, itemId, relativePath: '../../evil.mkv', size: 1, mtime: 1 });
    const calls: ClientCall[] = [];
    await expect(
      resolvePlayback(makeDeps(makeClientFactory({}, calls)), {
        ref: { provider: 'catalog', sourceId, itemId: String(itemId) },
      })
    ).rejects.toMatchObject({ name: 'ResolverError', code: 'UNAVAILABLE' });
  });

  it('rejects unknown items', async () => {
    const repo = createCatalogRepository(db);
    const sourceId = repo.createSource({ kind: 'local', name: 'm', root: '/tmp/qy-root' });
    const calls: ClientCall[] = [];
    await expect(
      resolvePlayback(makeDeps(makeClientFactory({}, calls)), {
        ref: { provider: 'catalog', sourceId, itemId: '9999' },
      })
    ).rejects.toMatchObject({ code: 'ITEM_NOT_FOUND' });
  });
});

describe('playback resolver: webdav stream', () => {
  it('builds the URL main-side and stashes Basic auth opaquely', async () => {
    const repo = createCatalogRepository(db);
    const sourceId = repo.createSource({ kind: 'webdav', name: 'w', root: `http://127.0.0.1:${mockPort}/dav` });
    secretStore.setSecret('webdav', String(sourceId), JSON.stringify({ username: 'u', password: 'p@ss' }));
    const itemId = repo.upsertItem({ sourceId, sourceKey: 'movie:b', kind: 'movie', title: '电影B' });
    repo.upsertFile({ sourceId, itemId, relativePath: '电影B (2020).mkv', size: 1, mtime: 1 });

    const calls: ClientCall[] = [];
    const resolution = await resolvePlayback(makeDeps(makeClientFactory({}, calls)), {
      ref: { provider: 'catalog', sourceId, itemId: String(itemId) },
    });
    expect(resolution.kind).toBe('webdav-stream');
    expect(resolution.url).toBe(`http://127.0.0.1:${mockPort}/dav/%E7%94%B5%E5%BD%B1B%20(2020).mkv`);
    expect(resolution.streamSessionId).toBeDefined();
    const header = streamHeaders.take(resolution.streamSessionId!);
    expect(header).toBe(`Authorization: Basic ${Buffer.from('u:p@ss').toString('base64')}`);
    expect(JSON.stringify(resolution)).not.toContain('p@ss');
  });

  it('streams without a session when no credential is stored', async () => {
    const repo = createCatalogRepository(db);
    const sourceId = repo.createSource({ kind: 'webdav', name: 'w', root: `http://127.0.0.1:${mockPort}/open` });
    const itemId = repo.upsertItem({ sourceId, sourceKey: 'video:c', kind: 'video', title: 'C' });
    repo.upsertFile({ sourceId, itemId, relativePath: 'c.mkv', size: 1, mtime: 1 });
    const calls: ClientCall[] = [];
    const resolution = await resolvePlayback(makeDeps(makeClientFactory({}, calls)), {
      ref: { provider: 'catalog', sourceId, itemId: String(itemId) },
    });
    expect(resolution.streamSessionId).toBeUndefined();
    expect(resolution.url).toBe(`http://127.0.0.1:${mockPort}/open/c.mkv`);
  });
});

describe('playback resolver: strict online routing', () => {
  function twoServers() {
    servers = [
      { id: 1, type: 'jellyfin', name: 'A', base_url: 'http://a:8096', user_id: 'u1', is_active: 1 },
      { id: 2, type: 'jellyfin', name: 'B', base_url: 'http://b:8096', user_id: 'u2', is_active: 1 },
    ];
    secretStore.setSecret(MEDIA_SERVER_NAMESPACE, '1', 'token-A');
    secretStore.setSecret(MEDIA_SERVER_NAMESPACE, '2', 'token-B');
  }

  it('routes by serverId: same item id on two servers never crosses', async () => {
    twoServers();
    const calls: ClientCall[] = [];
    const factory = makeClientFactory(
      {
        'http://a:8096': { x: { Id: 'x', Name: 'A版', Type: 'Movie', MediaSources: [{ Id: 'ms-a' }] } },
        'http://b:8096': { x: { Id: 'x', Name: 'B版', Type: 'Movie', MediaSources: [{ Id: 'ms-b' }] } },
      },
      calls
    );
    const resolution = await resolvePlayback(makeDeps(factory), {
      ref: { provider: 'jellyfin', serverId: 1, itemId: 'x' },
    });
    expect(resolution.kind).toBe('online-direct');
    expect(resolution.url).toContain('http://a:8096');
    expect(resolution.url).toContain('ms=ms-a');
    expect(resolution.mediaContext.title).toBe('A版');
    // Client factory received server A's key, and no request hit B.
    expect(calls.every((c) => c.baseUrl === 'http://a:8096')).toBe(true);
    expect(calls.every((c) => c.apiKey === 'token-A')).toBe(true);
  });

  it('rejects a removed server and a type mismatch', async () => {
    twoServers();
    const calls: ClientCall[] = [];
    await expect(
      resolvePlayback(makeDeps(makeClientFactory({}, calls)), {
        ref: { provider: 'jellyfin', serverId: 99, itemId: 'x' },
      })
    ).rejects.toMatchObject({ code: 'SERVER_NOT_FOUND' });
    await expect(
      resolvePlayback(makeDeps(makeClientFactory({}, calls)), {
        ref: { provider: 'emby', serverId: 1, itemId: 'x' },
      })
    ).rejects.toMatchObject({ code: 'SERVER_NOT_FOUND' });
  });

  it('rejects servers without credentials', async () => {
    servers = [{ id: 3, type: 'emby', name: 'C', base_url: 'http://c:8096', user_id: 'u3', is_active: 1 }];
    const calls: ClientCall[] = [];
    await expect(
      resolvePlayback(makeDeps(makeClientFactory({}, calls)), {
        ref: { provider: 'emby', serverId: 3, itemId: 'x' },
      })
    ).rejects.toMatchObject({ code: 'NO_CREDENTIAL' });
  });

  it('pins mediaSourceId and stashes transcode headers main-side', async () => {
    twoServers();
    const calls: ClientCall[] = [];
    const factory = makeClientFactory(
      {
        'http://a:8096': {
          y: { Id: 'y', Name: '片', Type: 'Movie', MediaSources: [{ Id: 'ms-1' }, { Id: 'ms-2' }] },
        },
      },
      calls
    );
    const resolution = await resolvePlayback(makeDeps(factory), {
      ref: { provider: 'jellyfin', serverId: 1, itemId: 'y' },
      mode: 'transcode',
      mediaSourceId: 'ms-2',
    });
    expect(resolution.kind).toBe('online-transcode');
    expect(resolution.url).toContain('ms=ms-2');
    expect(resolution.streamSessionId).toBeDefined();
    const header = streamHeaders.take(resolution.streamSessionId!);
    expect(header).toBe('X-Emby-Token: token-A');
    expect(JSON.stringify(resolution)).not.toContain('token-A');
    expect(resolution.mediaContext.mediaSourceId).toBe('ms-2');
  });

  it('resolves a Series to its first playable episode', async () => {
    twoServers();
    const calls: ClientCall[] = [];
    const factory = (config: { type: string; baseUrl: string; apiKey?: string; userId?: string }) => {
      const base = makeClientFactory(
        {
          'http://a:8096': {
            s: { Id: 's', Name: '剧', Type: 'Series', MediaSources: [] },
            e1: { Id: 'e1', Name: '第一集', Type: 'Episode', SeriesName: '剧', ParentIndexNumber: 1, IndexNumber: 1, MediaSources: [{ Id: 'ms-e1' }] },
          },
        },
        calls
      )(config);
      return {
        ...base,
        getItems: async (parentId: string, _opts: unknown) => {
          void _opts;
          calls.push({ baseUrl: config.baseUrl, apiKey: config.apiKey ?? '', kind: 'items', itemId: parentId });
          return parentId === 's'
            ? [{ Id: 'e1', Name: '第一集', SeriesName: '剧', ParentIndexNumber: 1, IndexNumber: 1 }]
            : [];
        },
      };
    };
    const resolution = await resolvePlayback(makeDeps(factory), {
      ref: { provider: 'jellyfin', serverId: 1, itemId: 's' },
    });
    expect(resolution.url).toContain('/Videos/e1/stream');
    expect(resolution.mediaContext).toMatchObject({
      mediaId: 'e1',
      title: '第一集',
      seriesName: '剧',
      seasonNumber: 1,
      episodeNumber: 1,
      mediaSourceId: 'ms-e1',
    });
  });

  it('surfaces missing items as ITEM_NOT_FOUND', async () => {
    twoServers();
    const calls: ClientCall[] = [];
    await expect(
      resolvePlayback(makeDeps(makeClientFactory({}, calls)), {
        ref: { provider: 'jellyfin', serverId: 1, itemId: 'ghost' },
      })
    ).rejects.toMatchObject({ code: 'ITEM_NOT_FOUND' });
  });
});

describe('playback resolver: server audio → webaudio proxy (QYP3-037)', () => {
  function oneServer() {
    servers = [
      { id: 1, type: 'jellyfin', name: 'A', base_url: 'http://a:8096', user_id: 'u1', is_active: 1 },
    ];
    secretStore.setSecret(MEDIA_SERVER_NAMESPACE, '1', 'token-A');
  }

  function audioClientFactory(calls: ClientCall[], details: FakeDetails) {
    return makeClientFactory({ 'http://a:8096': { song: details } }, calls);
  }

  it('direct audio codec routes through qy-stream with engine webaudio', async () => {
    oneServer();
    const calls: ClientCall[] = [];
    const deps = makeDeps(
      audioClientFactory(calls, {
        Id: 'song',
        Name: '歌曲',
        Type: 'Audio',
        MediaSources: [
          { Id: 'ms-1', MediaStreams: [{ Type: 'Audio', Codec: 'flac' }] },
        ],
      })
    );
    const resolution = await resolvePlayback(deps, {
      ref: { provider: 'jellyfin', serverId: 1, itemId: 'song' },
    });
    expect(resolution.kind).toBe('music-direct');
    expect(resolution.url).toMatch(/^qy-stream:\/\/audio\//);
    expect(resolution.engine).toEqual({ engine: 'webaudio', reason: 'direct-codec' });
    expect(resolution.mediaContext).toMatchObject({
      mediaType: 'jellyfin',
      mediaId: 'song',
      serverId: 1,
      mediaSourceId: 'ms-1',
    });
    // token 不出现在解析结果里，而是留在路由表里
    expect(JSON.stringify(resolution)).not.toContain('token-A');
    const route = deps.streamRoutes.get(resolution.url.replace('qy-stream://audio/', ''));
    expect(route?.url).toContain('/Videos/song/stream');
    expect(route?.headers['X-Emby-Token']).toBe('token-A');
  });

  it('unknown codec still attempts webaudio (乐观直解, 用户决策)', async () => {
    oneServer();
    const calls: ClientCall[] = [];
    const resolution = await resolvePlayback(
      makeDeps(
        audioClientFactory(calls, {
          Id: 'song',
          Name: '歌曲',
          Type: 'Audio',
          MediaSources: [{ Id: 'ms-1' }],
        })
      ),
      { ref: { provider: 'jellyfin', serverId: 1, itemId: 'song' } }
    );
    expect(resolution.engine).toEqual({ engine: 'webaudio', reason: 'direct-codec' });
    expect(resolution.url).toMatch(/^qy-stream:\/\/audio\//);
  });

  it('non-direct codec degrades to mpv (plain streaming url, no engine)', async () => {
    oneServer();
    const calls: ClientCall[] = [];
    const resolution = await resolvePlayback(
      makeDeps(
        audioClientFactory(calls, {
          Id: 'song',
          Name: '歌曲',
          Type: 'Audio',
          MediaSources: [
            { Id: 'ms-1', MediaStreams: [{ Type: 'Audio', Codec: 'ape' }] },
          ],
        })
      ),
      { ref: { provider: 'jellyfin', serverId: 1, itemId: 'song' } }
    );
    expect(resolution.kind).toBe('online-direct');
    expect(resolution.url).toContain('/Videos/song/stream');
    expect(resolution.engine).toBeUndefined();
  });

  it('engineForce mpv bypasses the proxy (probe / fallback paths)', async () => {
    oneServer();
    const calls: ClientCall[] = [];
    const resolution = await resolvePlayback(
      makeDeps(
        audioClientFactory(calls, {
          Id: 'song',
          Name: '歌曲',
          Type: 'Audio',
          MediaSources: [
            { Id: 'ms-1', MediaStreams: [{ Type: 'Audio', Codec: 'flac' }] },
          ],
        })
      ),
      {
        ref: { provider: 'jellyfin', serverId: 1, itemId: 'song' },
        engineForce: 'mpv',
      }
    );
    expect(resolution.kind).toBe('online-direct');
    expect(resolution.engine).toBeUndefined();
  });

  it('video items are never routed to the proxy', async () => {
    oneServer();
    const calls: ClientCall[] = [];
    const resolution = await resolvePlayback(
      makeDeps(
        audioClientFactory(calls, {
          Id: 'song',
          Name: '电影',
          Type: 'Movie',
          MediaSources: [
            { Id: 'ms-1', MediaStreams: [{ Type: 'Video', Codec: 'h264' }] },
          ],
        })
      ),
      { ref: { provider: 'jellyfin', serverId: 1, itemId: 'song' } }
    );
    expect(resolution.kind).toBe('online-direct');
    expect(resolution.url).toContain('/Videos/song/stream');
    expect(resolution.engine).toBeUndefined();
  });
});

describe('playback resolver: webdav music → webaudio proxy (QYP3-037)', () => {
  it('direct codec music routes through qy-stream with Basic auth in the route', async () => {
    const repo = createCatalogRepository(db);
    const sourceId = repo.createSource({ kind: 'webdav', name: 'w', root: `http://127.0.0.1:${mockPort}/dav` });
    secretStore.setSecret('webdav', String(sourceId), JSON.stringify({ username: 'u', password: 'p@ss' }));
    const trackId = repo.upsertMusicTrack({
      sourceId,
      sourceKey: 'm1',
      path: 'Music/song.flac',
      title: '云上歌',
      artist: '歌手',
      album: '专辑',
      albumartist: '歌手',
      trackNo: 1,
      duration: 200,
      codec: 'flac',
      fingerprint: 'fp-w1',
    });
    const progressKeys: Array<{ mediaType: string; mediaId: string }> = [];
    const deps: ResolverDeps = {
      ...makeDeps(makeClientFactory({}, [])),
      storage: {
        getServers: () => servers,
        getProgress: (mediaType: string, mediaId: string) => {
          progressKeys.push({ mediaType, mediaId });
          return undefined;
        },
      } as unknown as ReturnType<typeof createStorage>,
    };
    const resolution = await resolvePlayback(deps, {
      ref: { provider: 'music', sourceId, itemId: String(trackId) },
    });
    expect(resolution.kind).toBe('music-direct');
    expect(resolution.url).toMatch(/^qy-stream:\/\/audio\//);
    expect(resolution.engine).toEqual({ engine: 'webaudio', reason: 'direct-codec' });
    expect(resolution.mediaContext).toMatchObject({
      mediaType: 'webdav',
      mediaId: `${sourceId}:Music/song.flac`,
    });
    expect(resolution.streamSessionId).toBeUndefined();
    // QYP3-053：音乐不再读播放进度（不按曲目续播），一律从 0 起播
    expect(progressKeys).toEqual([]);
    expect(resolution.startPosition).toBe(0);
    const route = deps.streamRoutes.get(resolution.url.replace('qy-stream://audio/', ''));
    expect(route?.url).toBe(`http://127.0.0.1:${mockPort}/dav/Music/song.flac`);
    expect(route?.headers.Authorization).toBe(
      `Basic ${Buffer.from('u:p@ss').toString('base64')}`
    );
    expect(JSON.stringify(resolution)).not.toContain('p@ss');
  });

  it('non-direct codec music still goes to mpv with stashed headers', async () => {
    const repo = createCatalogRepository(db);
    const sourceId = repo.createSource({ kind: 'webdav', name: 'w', root: `http://127.0.0.1:${mockPort}/dav` });
    secretStore.setSecret('webdav', String(sourceId), JSON.stringify({ username: 'u', password: 'p' }));
    const trackId = repo.upsertMusicTrack({
      sourceId,
      sourceKey: 'm2',
      path: 'Music/song.ape',
      title: '老歌',
      trackNo: 1,
      duration: 200,
      codec: 'ape',
      fingerprint: 'fp-w2',
    });
    const resolution = await resolvePlayback(makeDeps(makeClientFactory({}, [])), {
      ref: { provider: 'music', sourceId, itemId: String(trackId) },
    });
    expect(resolution.kind).toBe('webdav-stream');
    expect(resolution.engine).toEqual({ engine: 'mpv', reason: 'non-direct-codec' });
    expect(resolution.streamSessionId).toBeDefined();
  });
});

describe('bindOnlineServer', () => {
  it('accepts only the exact server id', () => {
    servers = [{ id: 7, type: 'jellyfin', name: 'S', base_url: 'http://s:8096', user_id: 'u', is_active: 1 }];
    secretStore.setSecret(MEDIA_SERVER_NAMESPACE, '7', 'tok');
    const storage = { getServers: () => servers } as unknown as ReturnType<typeof createStorage>;
    const binding = bindOnlineServer(storage, secretStore, 'jellyfin', 7);
    expect(binding).toMatchObject({ id: 7, baseUrl: 'http://s:8096', apiKey: 'tok', userId: 'u' });
    expect(() => bindOnlineServer(storage, secretStore, 'jellyfin', 8)).toThrowError(
      expect.objectContaining({ code: 'SERVER_NOT_FOUND' })
    );
  });

  it('treats a missing user id as no credential', () => {
    servers = [{ id: 7, type: 'jellyfin', name: 'S', base_url: 'http://s:8096', is_active: 1 }];
    secretStore.setSecret(MEDIA_SERVER_NAMESPACE, '7', 'tok');
    const storage = { getServers: () => servers } as unknown as ReturnType<typeof createStorage>;
    expect(() => bindOnlineServer(storage, secretStore, 'jellyfin', 7)).toThrowError(
      expect.objectContaining({ code: 'NO_CREDENTIAL' })
    );
  });

  it('never mixes credentials between servers', () => {
    servers = [
      { id: 1, type: 'jellyfin', name: 'A', base_url: 'http://a:8096', user_id: 'u1', is_active: 1 },
      { id: 2, type: 'emby', name: 'B', base_url: 'http://b:8096', user_id: 'u2', is_active: 1 },
    ];
    secretStore.setSecret(MEDIA_SERVER_NAMESPACE, '1', 'tok-1');
    secretStore.setSecret(MEDIA_SERVER_NAMESPACE, '2', 'tok-2');
    const storage = { getServers: () => servers } as unknown as ReturnType<typeof createStorage>;
    expect(bindOnlineServer(storage, secretStore, 'jellyfin', 1).apiKey).toBe('tok-1');
    expect(bindOnlineServer(storage, secretStore, 'emby', 2).apiKey).toBe('tok-2');
  });
});
