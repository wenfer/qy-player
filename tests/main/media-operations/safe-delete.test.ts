import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabaseAtPath } from '../../../src/main/modules/storage/db';
import { createCatalogRepository, type CatalogRepository } from '../../../src/main/modules/catalog/repository';
import { LocalSourceAdapter } from '../../../src/main/modules/library-sources/local-source';
import {
  mapDeleteExecuteResult,
  mapDeletePreviewResult,
  SafeDeleteService,
  type DeleteExecuteResult,
  type DeleteServiceDeps,
} from '../../../src/main/modules/media-operations/delete-service';

let root: string;
let db: ReturnType<typeof openDatabaseAtPath>;
let repo: CatalogRepository;
let mediaRoot: string;
let cacheRoot: string;
let adapters: Map<number, LocalSourceAdapter>;
let trashCalls: string[];
let trashBehavior: 'ok' | 'fail' | 'unknown' = 'ok';
let webdavCalls: Array<{ relativePath: string; ifMatch?: string }>;
let webdavBehavior: 'ok' | 'fail' | 'unknown' | 'precondition-fail' = 'ok';
let service: SafeDeleteService;
let localSourceId: number;
let webdavSourceId: number;
let itemId: number;

function makeService(): SafeDeleteService {
  const deps: DeleteServiceDeps = {
    repo,
    resolveInside: (sourceId, relativePath) => {
      const adapter = adapters.get(sourceId);
      if (!adapter) throw new Error('no adapter');
      return adapter.resolveInside(relativePath);
    },
    trashFn: async (absolutePath) => {
      trashCalls.push(absolutePath);
      if (trashBehavior === 'fail') throw new Error('trash failed');
    },
    webdavDelete: async ({ relativePath, ifMatch }) => {
      webdavCalls.push({ relativePath, ifMatch });
      if (webdavBehavior === 'fail') throw new Error('network drop');
      if (webdavBehavior === 'precondition-fail') {
        const err = new Error('precondition failed') as Error & { status?: number };
        err.status = 412;
        throw err;
      }
      if (webdavBehavior === 'unknown') return { status: 'unknown' };
      return { status: 'deleted' };
    },
    managedCacheRoots: [cacheRoot],
    now: vi.fn(() => Date.now()),
  };
  return new SafeDeleteService(deps);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'qy-safe-delete-'));
  db = openDatabaseAtPath(join(root, 'test.db'));
  repo = createCatalogRepository(db);
  mediaRoot = join(root, 'media');
  cacheRoot = join(root, 'cache');
  mkdirSync(join(mediaRoot, '电影A'), { recursive: true });
  writeFileSync(join(mediaRoot, '电影A', 'a.mkv'), Buffer.alloc(100, 0x61));
  // DB rows must mirror the real on-disk stat (the execute-phase spot
  // check compares them against a fresh statSync).
  const aStat = statSync(join(mediaRoot, '电影A', 'a.mkv'));
  trashCalls = [];
  webdavCalls = [];
  adapters = new Map();
  trashBehavior = 'ok';
  webdavBehavior = 'ok';

  localSourceId = repo.createSource({ kind: 'local', name: '本地库', root: mediaRoot, readOnly: false });
  webdavSourceId = repo.createSource({ kind: 'webdav', name: '云盘', root: 'http://dav.example/dav', readOnly: false });
  adapters.set(localSourceId, LocalSourceAdapter.fromSource(localSourceId, mediaRoot));
  itemId = repo.upsertItem({ sourceId: localSourceId, sourceKey: 'movieA', kind: 'movie', title: '电影A' });
  repo.upsertFile({ sourceId: localSourceId, itemId, relativePath: '电影A/a.mkv', size: aStat.size, mtime: aStat.mtimeMs });
  service = makeService();
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('preview phase (plan §14.2.1-3)', () => {
  it('computes target/size/count and returns a single-use token', () => {
    const result = service.preview(localSourceId, itemId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preview.targetDir).toBe('电影A');
    expect(result.preview.fileCount).toBe(1);
    expect(result.preview.totalBytes).toBe(100);
    expect(result.preview.method).toBe('local-trash');
    expect(result.preview.token).toBeTruthy();
    expect(result.preview.requiresTitleConfirmation).toBe(false);
  });

  it('rejects the source root itself and single-file root-level targets', () => {
    // A file directly at the root: no independent directory.
    const rootItemId = repo.upsertItem({ sourceId: localSourceId, sourceKey: 'loose', kind: 'movie', title: '散文件' });
    repo.upsertFile({ sourceId: localSourceId, itemId: rootItemId, relativePath: 'loose.mkv', size: 10, mtime: 1 });
    const result = service.preview(localSourceId, rootItemId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('NO_OWNERSHIP');
  });

  it('rejects shared directories (another item owns files inside)', () => {
    const otherId = repo.upsertItem({ sourceId: localSourceId, sourceKey: 'movieB', kind: 'movie', title: '电影B' });
    repo.upsertFile({ sourceId: localSourceId, itemId: otherId, relativePath: '电影A/extra.nfo', size: 5, mtime: 1 });
    const result = service.preview(localSourceId, itemId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('NO_OWNERSHIP');
  });

  it('rejects non-deletable kinds (season/episode) and read-only sources', () => {
    const epId = repo.upsertItem({ sourceId: localSourceId, sourceKey: 'ep', kind: 'episode', title: '单集' });
    repo.upsertFile({ sourceId: localSourceId, itemId: epId, relativePath: '电影A/ep.mkv', size: 1, mtime: 1 });
    const ep = service.preview(localSourceId, epId);
    expect(ep.ok).toBe(false);
    if (!ep.ok) expect(ep.code).toBe('NOT_DELETABLE_KIND');

    repo.updateSource(localSourceId, { readOnly: true });
    const ro = service.preview(localSourceId, itemId);
    expect(ro.ok).toBe(false);
    if (!ro.ok) expect(ro.code).toBe('READ_ONLY');
    repo.updateSource(localSourceId, { readOnly: false });
  });

  it('rejects symlink containment breaks (root-外 via symlink)', () => {
    // A symlinked subdirectory pointing outside the root must refuse.
    symlinkSync(join(root, 'outside'), join(mediaRoot, '链接'));
    const linkId = repo.upsertItem({ sourceId: localSourceId, sourceKey: 'link', kind: 'movie', title: '链接' });
    repo.upsertFile({ sourceId: localSourceId, itemId: linkId, relativePath: '链接/a.mkv', size: 1, mtime: 1 });
    const result = service.preview(localSourceId, linkId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(['OUT_OF_ROOT', 'NO_OWNERSHIP']).toContain(result.code);
  });

  it('rejects unknown sources/items', () => {
    expect(service.preview(999, itemId).ok).toBe(false);
    expect(service.preview(localSourceId, 999999).ok).toBe(false);
  });
});

describe('execute phase (§14.2.5-8)', () => {
  it('trashes the verified directory and marks the item missing', async () => {
    const preview = service.preview(localSourceId, itemId);
    if (!preview.ok) throw new Error('preview failed');
    mkdirSync(join(cacheRoot, String(itemId)), { recursive: true });
    writeFileSync(join(cacheRoot, String(itemId), 'sub.srt'), 'x');
    const result = await service.execute(preview.preview.token);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe('trashed');
    expect(trashCalls).toHaveLength(1);
    expect(trashCalls[0]).toContain('电影A');
    // Success (not before): availability flips to missing afterwards.
    expect(repo.getItem(itemId)?.availability).toBe('missing');
  });

  it('re-verifies the fingerprint: content change between phases aborts', async () => {
    const preview = service.preview(localSourceId, itemId);
    if (!preview.ok) throw new Error('preview failed');
    // Simulate a scan refreshing sizes after the preview.
    repo.upsertFile({ sourceId: localSourceId, itemId, relativePath: '电影A/a.mkv', size: 200, mtime: 1000 });
    const result = await service.execute(preview.preview.token);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('FINGERPRINT_CHANGED');
    expect(trashCalls).toHaveLength(0);
  });

  it('re-verifies symlink containment at execution time', async () => {
    const preview = service.preview(localSourceId, itemId);
    if (!preview.ok) throw new Error('preview failed');
    // Replace the item dir with a symlink pointing outside.
    rmSync(join(mediaRoot, '电影A'), { recursive: true, force: true });
    mkdirSync(join(root, 'elsewhere'), { recursive: true });
    symlinkSync(join(root, 'elsewhere'), join(mediaRoot, '电影A'));
    const result = await service.execute(preview.preview.token);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('SYMLINK_CHANGED');
    expect(trashCalls).toHaveLength(0);
  });

  it('trash failure never falls back to a permanent delete', async () => {
    trashBehavior = 'fail';
    const preview = service.preview(localSourceId, itemId);
    if (!preview.ok) throw new Error('preview failed');
    const result = await service.execute(preview.preview.token);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('TRASH_FAILED');
    // Index untouched (失败不先删索引).
    expect(repo.getItem(itemId)?.availability).toBe('online');
    expect(repo.listFilesByItem(itemId)).toHaveLength(1);
  });

  it('tokens are single-use and expire', async () => {
    const preview = service.preview(localSourceId, itemId);
    if (!preview.ok) throw new Error('preview failed');
    const first = await service.execute(preview.preview.token);
    if (!first.ok) throw new Error(`execute failed: ${(first as { code?: string }).code}`);
    expect(first.ok).toBe(true);
    const replay = await service.execute(preview.preview.token);
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.code).toBe('TOKEN_INVALID');

    // Expiry: a fresh service whose clock jumps past the TTL.
    let clock = Date.now();
    const expiring = new SafeDeleteService({
      repo,
      resolveInside: (id, relativePath) => adapters.get(id)!.resolveInside(relativePath),
      trashFn: async () => undefined,
      webdavDelete: async () => ({ status: 'deleted' }),
      managedCacheRoots: [cacheRoot],
      tokenTtlMs: 1000,
      now: () => clock,
    });
    const p2 = expiring.preview(localSourceId, itemId);
    if (!p2.ok) throw new Error('preview failed');
    clock += 60_000;
    const expired = await expiring.execute(p2.preview.token);
    expect(expired.ok).toBe(false);
    if (!expired.ok) expect(expired.code).toBe('TOKEN_EXPIRED');
  });

  it('invalid token input is rejected', async () => {
    const result = await service.execute('garbage');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('TOKEN_INVALID');
  });
});

describe('webdav delete (capability + preconditions)', () => {
  function makeWebdavItem(): number {
    const id = repo.upsertItem({ sourceId: webdavSourceId, sourceKey: 'cloud', kind: 'movie', title: '云盘电影' });
    repo.upsertFile({
      sourceId: webdavSourceId,
      itemId: id,
      relativePath: 'cloud-movie/movie.mkv',
      size: 500,
      mtime: 100,
    });
    return id;
  }

  it('previews with title confirmation requirement and sends If-Match', async () => {
    const wid = makeWebdavItem();
    // Give the file an etag fingerprint so the precondition is real.
    repo.upsertFile({
      sourceId: webdavSourceId,
      itemId: wid,
      relativePath: 'cloud-movie/movie.mkv',
      size: 500,
      mtime: 100,
      fingerprint: 'etag:abc123',
    });
    const preview = service.preview(webdavSourceId, wid);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.preview.method).toBe('webdav-delete');
    expect(preview.preview.requiresTitleConfirmation).toBe(true);

    // Title mismatch aborts before any network call.
    const mismatch = await service.execute(preview.preview.token, { confirmTitle: '错误的标题' });
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.code).toBe('TITLE_MISMATCH');
    expect(webdavCalls).toHaveLength(0);

    // Correct title proceeds; the etag rides If-Match (server-side
    // re-verification between preview and execute, §14.2.5).
    const done = await service.execute(preview.preview.token, { confirmTitle: '云盘电影' });
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    expect(done.status).toBe('deleted');
    expect(webdavCalls).toEqual([{ relativePath: 'cloud-movie', ifMatch: 'abc123' }]);
    expect(repo.getItem(wid)?.availability).toBe('missing');
  });

  it('maps a 412 precondition failure to FINGERPRINT_CHANGED', async () => {
    webdavBehavior = 'precondition-fail';
    const wid = makeWebdavItem();
    repo.upsertFile({
      sourceId: webdavSourceId,
      itemId: wid,
      relativePath: 'cloud-movie/movie.mkv',
      size: 500,
      mtime: 100,
      fingerprint: 'etag:stale',
    });
    const preview = service.preview(webdavSourceId, wid);
    if (!preview.ok) throw new Error('preview failed');
    const result = await service.execute(preview.preview.token, { confirmTitle: '云盘电影' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('FINGERPRINT_CHANGED');
    expect(repo.getItem(wid)?.availability).toBe('online');
  });

  it('refuses WebDAV delete for null-title items (empty-string bypass)', () => {
    const wid = repo.upsertItem({ sourceId: webdavSourceId, sourceKey: 'no-title', kind: 'movie', title: null as unknown as string });
    repo.upsertFile({ sourceId: webdavSourceId, itemId: wid, relativePath: 'no-title/movie.mkv', size: 1, mtime: 1 });
    const preview = service.preview(webdavSourceId, wid);
    expect(preview.ok).toBe(false);
    if (!preview.ok) expect(preview.code).toBe('INVALID_INPUT');
  });

  it('marks unknown outcomes instead of faking success', async () => {
    webdavBehavior = 'unknown';
    const wid = makeWebdavItem();
    const preview = service.preview(webdavSourceId, wid);
    if (!preview.ok) throw new Error('preview failed');
    const result = await service.execute(preview.preview.token, { confirmTitle: '云盘电影' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe('unknown');
    // Unknown → offline (re-scan will settle it); never 'missing'.
    expect(repo.getItem(wid)?.availability).toBe('offline');
  });

  it('webdav failures do not mark anything deleted', async () => {
    webdavBehavior = 'fail';
    const wid = makeWebdavItem();
    const preview = service.preview(webdavSourceId, wid);
    if (!preview.ok) throw new Error('preview failed');
    const result = await service.execute(preview.preview.token, { confirmTitle: '云盘电影' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('WEBDAV_FAILED');
    expect(repo.getItem(wid)?.availability).toBe('online');
  });
});

describe('managed cache cleanup', () => {
  it('cleans the managed cache only after a successful delete', async () => {
    const removeManagedCache = vi.fn();
    const custom = new SafeDeleteService({
      repo,
      resolveInside: (id, relativePath) => adapters.get(id)!.resolveInside(relativePath),
      trashFn: async () => undefined,
      webdavDelete: async () => ({ status: 'deleted' }),
      managedCacheRoots: [cacheRoot],
      removeManagedCache,
    });
    mkdirSync(join(cacheRoot, String(itemId)), { recursive: true });
    writeFileSync(join(cacheRoot, String(itemId), 'poster.png'), 'x');
    const preview = custom.preview(localSourceId, itemId);
    if (!preview.ok) throw new Error('preview failed');
    await custom.execute(preview.preview.token);
    expect(removeManagedCache).toHaveBeenCalledWith(itemId);
    const result: DeleteExecuteResult = { ok: true, status: 'trashed', itemId };
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Wire contract (QYP2-024 §16.6): service results → IPC envelope shapes
// ---------------------------------------------------------------------------

describe('wire contract mappers', () => {
  it('maps preview ok/failure without double wrapping', () => {
    const good = mapDeletePreviewResult(service.preview(localSourceId, itemId));
    expect(good.ok).toBe(true);
    if (good.ok) expect(good.data?.token).toBeTruthy();

    const bad = mapDeletePreviewResult(service.preview(localSourceId, 999999));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error?.code).toBe('NOT_FOUND');
  });

  it('maps execute ok/unknown/typed failures', async () => {
    const preview = service.preview(localSourceId, itemId);
    if (!preview.ok) throw new Error('preview failed');
    const good = mapDeleteExecuteResult(await service.execute(preview.preview.token));
    expect(good.ok).toBe(true);
    if (good.ok) expect(good.data?.status).toBe('trashed');

    const replay = mapDeleteExecuteResult(await service.execute(preview.preview.token));
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.error?.code).toBe('VALIDATION_FAILED'); // TOKEN_INVALID → validation
  });
});
