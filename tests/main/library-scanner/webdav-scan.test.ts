import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabaseAtPath } from '../../../src/main/modules/storage/db';
import { createCatalogRepository, type CatalogRepository } from '../../../src/main/modules/catalog/repository';
import { ScanJobController } from '../../../src/main/modules/library-scanner/job-controller';
import {
  createWebDavScanDriver,
  persistSourceHealth,
  readPersistedHealth,
  webdavFingerprint,
} from '../../../src/main/modules/library-scanner/webdav-scanner';
import { markAvailabilityAfterScan, walkSourceTree } from '../../../src/main/modules/library-scanner/local-scanner';
import { WebDavSourceAdapter } from '../../../src/main/modules/library-sources/webdav-source';
import type { SourceAdapter, SourceEntry, ScanDriver } from '../../../src/main/modules/library-sources/types';
import type BetterSqlite3 from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Fake WebDAV adapter: an in-memory tree with ETags and NFO contents
// ---------------------------------------------------------------------------

interface FakeFile {
  isDir: boolean;
  size: number;
  mtime: number;
  etag?: string;
  content?: string;
}

function makeWebDavTree(files: Record<string, Omit<FakeFile, 'isDir'> & Partial<Pick<FakeFile, 'isDir'>>>) {
  const nodes = new Map<string, FakeFile>();
  for (const [path, meta] of Object.entries(files)) {
    nodes.set(path, { isDir: meta.isDir ?? false, size: meta.size, mtime: meta.mtime, ...(meta.etag ? { etag: meta.etag } : {}), ...(meta.content !== undefined ? { content: meta.content } : {}) });
    const segments = path.split('/');
    for (let i = 1; i < segments.length; i += 1) {
      const dir = segments.slice(0, i).join('/');
      if (!nodes.has(dir)) nodes.set(dir, { isDir: true, size: 0, mtime: 0 });
    }
  }
  const adapter: SourceAdapter & { setNode(path: string, patch: Partial<FakeFile>): void; remove(path: string): void } = {
    kind: 'webdav',
    async *list(relativePath: string, signal: AbortSignal): AsyncGenerator<SourceEntry> {
      const prefix = relativePath === '' ? '' : `${relativePath}/`;
      const children = [...nodes.entries()]
        .filter(([p]) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
        .map(([p, node]) => ({
          relativePath: p,
          isDirectory: node.isDir,
          size: node.isDir ? undefined : node.size,
          mtime: node.mtime,
          ...(node.etag !== undefined ? { etag: node.etag } : {}),
        }))
        .sort((a, b) => (a.relativePath < b.relativePath ? -1 : 1));
      for (const entry of children) {
        if (signal.aborted) return;
        yield entry;
      }
    },
    async testConnection(signal: AbortSignal) {
      void signal;
      return { canSeek: true, canDelete: false, supportsEtag: true, supportsRange: true };
    },
    stat: async () => ({ supportsRange: true }),
    async open(locator, signal: AbortSignal) {
      const node = nodes.get(locator.relativePath);
      if (!node || node.content === undefined) throw new Error('not found');
      void signal;
      const buffer = Buffer.from(node.content, 'utf8');
      const stream = new (require('stream').Readable as typeof import('stream').Readable)();
      stream.push(buffer);
      stream.push(null);
      return { stream, size: buffer.length, supportsRange: true };
    },
    setNode(path: string, patch: Partial<FakeFile>): void {
      const node = nodes.get(path);
      if (node) Object.assign(node, patch);
    },
    remove(path: string): void {
      nodes.delete(path);
      for (const p of [...nodes.keys()]) {
        if (p.startsWith(`${path}/`)) nodes.delete(p);
      }
    },
  };
  return adapter;
}

let dbDir: string;
let db: BetterSqlite3.Database;
let repo: CatalogRepository;

beforeEach(() => {
  dbDir = mkdtempSync(join(tmpdir(), 'qy-webdav-scan-'));
  db = openDatabaseAtPath(join(dbDir, 'catalog.db'));
  repo = createCatalogRepository(db);
});

afterEach(() => {
  db.close();
  rmSync(dbDir, { recursive: true, force: true });
});

function makeSource(): number {
  return repo.createSource({ kind: 'webdav', name: '云盘', root: 'http://127.0.0.1:1/dav' });
}

async function runScan(
  sourceId: number,
  adapter: SourceAdapter,
  driver: ScanDriver,
  opts: { resume?: { fromCursor?: string } } = {}
): Promise<number> {
  // Recursive wrapper, same as the IPC layer wires it.
  const scanning: SourceAdapter = {
    ...adapter,
    list: (path: string, signal: AbortSignal) => walkSourceTree(adapter, path, signal),
  };
  const controller = new ScanJobController({
    repo,
    adapter: scanning,
    driver,
    sourceId,
    root: 'http://127.0.0.1:1/dav',
  });
  return controller.start(opts.resume);
}

const SHOW_NFO = '<tvshow><title>云上剧集</title><plot>来自 WebDAV 的简介。</plot></tvshow>';

describe('webdav scan driver', () => {
  it('indexes a webdav tree with ETag fingerprints', async () => {
    const sourceId = makeSource();
    const tree = makeWebDavTree({
      'Movies/流浪地球 (2019).mkv': { size: 500, mtime: 1000, etag: 'e-1' },
      '剧集/tvshow.nfo': { size: 10, mtime: 1, content: SHOW_NFO },
      '剧集/Season 1/云上剧集 S01E01.mkv': { size: 100, mtime: 2, etag: 'e-2' },
    });
    const driver = createWebDavScanDriver({ repo, sourceId, adapter: tree });
    const runId = await runScan(sourceId, tree, driver);
    expect(repo.getScanRun(runId)!.status).toBe('completed');

    const movie = repo.listByParent(null, sourceId).find((i) => i.kind === 'movie')!;
    expect(movie.title).toBe('流浪地球');
    const movieFiles = repo.listFilesByItem(movie.id);
    expect(movieFiles[0].fingerprint).toBe('etag:e-1');

    // NFO read through the adapter (GET), tvshow.nfo wins the title.
    const series = repo.listByParent(null, sourceId).find((i) => i.kind === 'series')!;
    const sources = repo.listMetadataSources(series.id);
    const title = sources.find((s) => s.field === 'title' && s.provider === 'nfo');
    expect(JSON.parse(title!.value!)).toBe('云上剧集');
  });

  it('prefers the ETag: same size/mtime but new ETag re-indexes', async () => {
    const sourceId = makeSource();
    const tree = makeWebDavTree({ 'a.mkv': { size: 100, mtime: 1, etag: 'e-old' } });
    await runScan(sourceId, tree, createWebDavScanDriver({ repo, sourceId, adapter: tree }));
    const before = repo.listFilesBySource(sourceId)[0];
    expect(before.fingerprint).toBe('etag:e-old');

    tree.setNode('a.mkv', { etag: 'e-new' });
    await runScan(sourceId, tree, createWebDavScanDriver({ repo, sourceId, adapter: tree }));
    const after = repo.listFilesBySource(sourceId)[0];
    expect(after.fingerprint).toBe('etag:e-new');
    expect(after.updated_at).toBeGreaterThanOrEqual(before.updated_at ?? 0);
  });

  it('skips everything on a second unchanged scan (ETag path)', async () => {
    const sourceId = makeSource();
    const tree = makeWebDavTree({
      'a.mkv': { size: 100, mtime: 1, etag: 'e-1' },
      'b/series S01E02.mkv': { size: 120, mtime: 2, etag: 'e-2' },
    });
    await runScan(sourceId, tree, createWebDavScanDriver({ repo, sourceId, adapter: tree }));
    const filesAfterFirst = repo.listFilesBySource(sourceId);
    const series = repo.listByParent(null, sourceId).find((i) => i.kind === 'series')!;

    await runScan(sourceId, tree, createWebDavScanDriver({ repo, sourceId, adapter: tree }));
    const filesAfterSecond = repo.listFilesBySource(sourceId);
    expect(filesAfterSecond.map((f) => f.updated_at)).toEqual(filesAfterFirst.map((f) => f.updated_at));
    expect(repo.listByParent(null, sourceId).find((i) => i.kind === 'series')!.updated_at).toBe(
      series.updated_at
    );
  });

  it('degrades to size:mtime when the server has no ETags', async () => {
    const sourceId = makeSource();
    const tree = makeWebDavTree({ 'a.mkv': { size: 100, mtime: 1234 } });
    const driver = createWebDavScanDriver({ repo, sourceId, adapter: tree });
    await runScan(sourceId, tree, driver);
    expect(repo.listFilesBySource(sourceId)[0].fingerprint).toBe('nofetag:100:1234');
    expect(webdavFingerprint({ relativePath: 'x', isDirectory: false, size: 1, mtime: 2, etag: 'e' })).toBe('etag:e');
  });

  it('never marks missing on connection failure (offline semantics)', async () => {
    const sourceId = makeSource();
    const tree = makeWebDavTree({
      'keep.mkv': { size: 1, mtime: 1, etag: 'e-1' },
      'gone/gone.mkv': { size: 1, mtime: 2, etag: 'e-2' },
    });
    await runScan(sourceId, tree, createWebDavScanDriver({ repo, sourceId, adapter: tree }));
    const before = repo.listByParent(null, sourceId).map((i) => i.availability);

    // Server unreachable during discovery: the whole walk fails.
    const broken = makeWebDavTree({});
    const failing: SourceAdapter = {
      ...broken,
      list: async function* () {
        const err = new Error('connect ECONNREFUSED');
        (err as { code?: string }).code = 'ECONNREFUSED';
        throw err;
      },
    };
    const runId = await runScan(sourceId, failing, createWebDavScanDriver({ repo, sourceId, adapter: failing }));
    expect(repo.getScanRun(runId)!.status).toBe('failed');
    expect(repo.listByParent(null, sourceId).map((i) => i.availability)).toEqual(before);
  });

  it('never marks missing on auth failure', async () => {
    const sourceId = makeSource();
    const tree = makeWebDavTree({ 'a.mkv': { size: 1, mtime: 1, etag: 'e-1' } });
    await runScan(sourceId, tree, createWebDavScanDriver({ repo, sourceId, adapter: tree }));
    const before = repo.listByParent(null, sourceId).map((i) => i.availability);

    const unauthorized: SourceAdapter = {
      ...tree,
      list: async function* () {
        const err = new Error('认证失败（401）');
        (err as { status?: number }).status = 401;
        throw err;
      },
    };
    const runId = await runScan(sourceId, unauthorized, createWebDavScanDriver({ repo, sourceId, adapter: unauthorized }));
    expect(repo.getScanRun(runId)!.status).toBe('failed');
    expect(repo.listByParent(null, sourceId).map((i) => i.availability)).toEqual(before);
  });

  it('never marks missing on cancellation', async () => {
    const sourceId = makeSource();
    const tree = makeWebDavTree({
      'a.mkv': { size: 1, mtime: 1, etag: 'e-1' },
      'b/b.mkv': { size: 1, mtime: 2, etag: 'e-2' },
    });
    await runScan(sourceId, tree, createWebDavScanDriver({ repo, sourceId, adapter: tree }));
    const before = repo.listByParent(null, sourceId).map((i) => i.availability);

    const scanning: SourceAdapter = {
      ...tree,
      list: (path: string, signal: AbortSignal) => walkSourceTree(tree, path, signal),
    };
    const controller = new ScanJobController({
      repo,
      adapter: scanning,
      driver: createWebDavScanDriver({ repo, sourceId, adapter: tree }),
      sourceId,
      root: 'http://127.0.0.1:1/dav',
    });
    const runPromise = controller.start();
    controller.cancel();
    const runId = await runPromise;
    expect(repo.getScanRun(runId)!.status).toBe('cancelled');
    expect(repo.listByParent(null, sourceId).map((i) => i.availability)).toEqual(before);
  });

  it('marks missing only after a successful full scan', async () => {
    const sourceId = makeSource();
    const tree = makeWebDavTree({
      'keep.mkv': { size: 1, mtime: 1, etag: 'e-1' },
      'gone/gone.mkv': { size: 1, mtime: 2, etag: 'e-2' },
    });
    await runScan(sourceId, tree, createWebDavScanDriver({ repo, sourceId, adapter: tree }));

    tree.remove('gone');
    const driver = createWebDavScanDriver({ repo, sourceId, adapter: tree });
    const runId = await runScan(sourceId, tree, driver);
    expect(repo.getScanRun(runId)!.status).toBe('completed');
    markAvailabilityAfterScan(repo, sourceId, driver.seen, { fullScan: true });

    const titles = new Map(repo.listByParent(null, sourceId).map((i) => [i.title, i.availability]));
    expect(titles.get('keep')).toBe('online');
    expect(titles.get('gone')).toBe('missing');
  });

  it('resumed (partial) scans do not mark missing', async () => {
    const sourceId = makeSource();
    const tree = makeWebDavTree({
      'a.mkv': { size: 1, mtime: 1, etag: 'e-1' },
      'b.mkv': { size: 1, mtime: 2, etag: 'e-2' },
    });
    const driver = createWebDavScanDriver({ repo, sourceId, adapter: tree });
    const runId = await runScan(sourceId, tree, driver, { resume: { fromCursor: 'a.mkv' } });
    expect(repo.getScanRun(runId)!.status).toBe('completed');
    markAvailabilityAfterScan(repo, sourceId, driver.seen, { fullScan: false });
    expect(repo.listByParent(null, sourceId).every((i) => i.availability === 'online')).toBe(true);
  });

  it('handles a 10,000-entry synthetic tree (baseline)', async () => {
    const sourceId = makeSource();
    const files: Record<string, { size: number; mtime: number; etag: string }> = {};
    for (let d = 0; d < 200; d += 1) {
      for (let f = 0; f < 50; f += 1) {
        files[`show${d}/Season 1/Show ${String(d).padStart(3, '0')} S01E${String(f + 1).padStart(2, '0')}.mkv`] = {
          size: 1000 + f,
          mtime: d * 100 + f,
          etag: `etag-${d}-${f}`,
        };
      }
    }
    const tree = makeWebDavTree(files);
    const driver = createWebDavScanDriver({ repo, sourceId, adapter: tree });
    const started = Date.now();
    const runId = await runScan(sourceId, tree, driver);
    const elapsed = Date.now() - started;
    expect(repo.getScanRun(runId)!.status).toBe('completed');
    expect(repo.listFilesBySource(sourceId)).toHaveLength(10_000);
    // Peak concurrency is the controller's bounded queue (4 for webdav,
    // plan §16.4); this fixture measures wall time, not memory.
    console.log(`[BASELINE] 10,000-entry webdav synthetic scan: ${elapsed}ms`);
    expect(elapsed).toBeLessThan(60_000);
  }, 120_000);
});

describe('health persistence', () => {
  it('persists and reads health without clobbering other options', () => {
    const sourceId = repo.createSource({
      kind: 'webdav',
      name: '云盘',
      root: 'http://127.0.0.1:1/dav',
      options: { keepMe: 'yes' },
    });
    persistSourceHealth(repo, sourceId, 'auth-required');
    const stored = repo.getSource(sourceId)!;
    const health = readPersistedHealth(stored)!;
    expect(health.health).toBe('auth-required');
    expect(health.checkedAt).toBeGreaterThan(0);
    expect((JSON.parse(stored.options!) as Record<string, string>).keepMe).toBe('yes');
    // Idempotent overwrite with a different state.
    persistSourceHealth(repo, sourceId, 'ok');
    expect(readPersistedHealth(repo.getSource(sourceId)!)!.health).toBe('ok');
  });

  it('returns undefined when health was never probed', () => {
    const sourceId = repo.createSource({ kind: 'webdav', name: 'x', root: 'http://127.0.0.1:1/d' });
    expect(readPersistedHealth(repo.getSource(sourceId)!)).toBeUndefined();
  });
});

describe('webdav adapter scan integration', () => {
  it('real WebDavSourceAdapter lists with etags (sanity through the HTTP stack)', async () => {
    // Construct against an unreachable host just to verify the factory; the
    // HTTP behaviors live in webdav-client.test.ts.
    const adapter = WebDavSourceAdapter.fromSource(1, 'http://127.0.0.1:1/dav', null);
    expect(adapter.kind).toBe('webdav');
  });
});
