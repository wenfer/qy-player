import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabaseAtPath } from '../../../src/main/modules/storage/db';
import { createCatalogRepository, type CatalogRepository } from '../../../src/main/modules/catalog/repository';
import { ScanJobController } from '../../../src/main/modules/library-scanner/job-controller';
import type { SourceAdapter, SourceEntry, ScanDriver } from '../../../src/main/modules/library-sources/types';
import {
  classifyPath,
  normalizeNameKey,
} from '../../../src/main/modules/library-scanner/classifier';
import {
  createLocalScanDriver,
  markAvailabilityAfterScan,
  walkSourceTree,
} from '../../../src/main/modules/library-scanner/local-scanner';

// ---------------------------------------------------------------------------
// classifier (pure functions)
// ---------------------------------------------------------------------------

describe('classifier', () => {
  it('parses S01E02 with series title', () => {
    const c = classifyPath('Show/Show.S01E02.720p.mkv');
    expect(c.fileClass).toBe('video');
    expect(c.episode).toBeDefined();
    expect(c.episode!.season).toBe(1);
    expect(c.episode!.episode).toBe(2);
    expect(c.episode!.seriesTitle).toBe('Show');
    expect(c.confidence).toBe('high');
  });

  it('parses 1x02 style', () => {
    const c = classifyPath('Show/Show.1x02.mkv');
    expect(c.episode).toBeDefined();
    expect(c.episode!.season).toBe(1);
    expect(c.episode!.episode).toBe(2);
  });

  it('parses multi-episode files (S01E02E03 and S01E02-E03)', () => {
    for (const name of ['Show.S01E02E03.mkv', 'Show.S01E02-E03.mkv']) {
      const c = classifyPath(name);
      expect(c.episode).toBeDefined();
      expect(c.episode!.episode).toBe(2);
      expect(c.episode!.episodeEnd).toBe(3);
    }
  });

  it('derives season from Season 01 directory and bare episode number', () => {
    const c = classifyPath('Show/Season 01/02.mkv');
    expect(c.episode).toBeDefined();
    expect(c.episode!.season).toBe(1);
    expect(c.episode!.episode).toBe(2);
    expect(c.episode!.seriesTitle).toBe('Show');
  });

  it('maps Specials directory to Season 0', () => {
    const c = classifyPath('Show/Specials/05.mkv');
    expect(c.episode).toBeDefined();
    expect(c.episode!.season).toBe(0);
    expect(c.episode!.episode).toBe(5);
  });

  it('treats E-prefixed filenames inside season dirs as episodes', () => {
    const c = classifyPath('Show/Season 2/E03.mkv');
    expect(c.episode).toBeDefined();
    expect(c.episode!.season).toBe(2);
    expect(c.episode!.episode).toBe(3);
  });

  it('classifies a year-suffixed file as a high-confidence movie', () => {
    const c = classifyPath('Blade Runner 2049 (2017).mkv');
    expect(c.episode).toBeUndefined();
    expect(c.movie).toEqual({ title: 'Blade Runner 2049', year: 2017 });
    expect(c.confidence).toBe('high');
  });

  it('strips release tags from movie titles', () => {
    const c = classifyPath('Up.2009.1080p.BluRay.x264.mkv');
    expect(c.movie).toEqual({ title: 'Up', year: 2009 });
  });

  it('falls back to low-confidence video without a year', () => {
    const c = classifyPath('family video.avi');
    expect(c.movie).toBeUndefined();
    expect(c.episode).toBeUndefined();
    expect(c.videoTitle).toBe('family video');
    expect(c.confidence).toBe('low');
  });

  it('flags sample files only when the name starts with the marker', () => {
    expect(classifyPath('Movie (2019)/sample.mkv').isSample).toBe(true);
    expect(classifyPath('Movie (2019)/sample 2.mkv').isSample).toBe(true);
    // Real titles must not be swallowed by the sample filter.
    expect(classifyPath('Movie (2019)/The.Sample.2023.mkv').isSample).toBe(false);
    expect(classifyPath('Movie (2019)/Movie.SAMPLE.mkv').isSample).toBe(false);
    expect(classifyPath('Movie (2019)/Movie (2019).mkv').isSample).toBe(false);
  });

  it('flags extras markers only at the start of the name', () => {
    expect(classifyPath('Movie (2019)/trailer.mkv').isExtra).toBe(true);
    expect(classifyPath('Movie (2019)/trailer 2.mkv').isExtra).toBe(true);
    expect(classifyPath('Movie (2019)/deleted.scenes.mkv').isExtra).toBe(true);
    expect(classifyPath('Movie (2019)/behind.the.scenes.mkv').isExtra).toBe(true);
    // Real titles must not be flagged as extras.
    expect(classifyPath('The Interview (2014).mkv').isExtra).toBe(false);
    expect(classifyPath('Movie (2019)/Movie (2019).mkv').isExtra).toBe(false);
  });

  it('recognizes NFO files and image/subtitle sidecars', () => {
    expect(classifyPath('movie.nfo').fileClass).toBe('nfo');
    expect(classifyPath('poster.jpg').fileClass).toBe('sidecar');
    expect(classifyPath('movie.en.srt').fileClass).toBe('sidecar');
    expect(classifyPath('readme.txt').fileClass).toBe('ignored');
  });

  it('rejects episode match without a series title (low confidence)', () => {
    const c = classifyPath('S01E02.mkv');
    expect(c.episode).toBeUndefined();
    expect(c.confidence).toBe('low');
  });

  it('recognizes a year at the end of the filename', () => {
    const c = classifyPath('Movie 2019.mkv');
    expect(c.movie).toEqual({ title: 'Movie', year: 2019 });
    expect(c.confidence).toBe('high');
  });

  it('does not leak release tags into the episode title', () => {
    const c = classifyPath('Show.S01E02.720p.mkv');
    expect(c.episode).toBeDefined();
    expect(c.episode!.episodeTitle).toBeUndefined();
    const named = classifyPath('Show.S01E02.Pilot.1080p.mkv');
    expect(named.episode!.episodeTitle).toBe('Pilot');
  });

  it('treats E-prefixed filenames outside season dirs as low confidence', () => {
    const c = classifyPath('E03.mkv');
    expect(c.episode).toBeUndefined();
    expect(c.confidence).toBe('low');
  });

  it('keeps same-name different-year movies apart', () => {
    const a = classifyPath('Flash (1990).mkv');
    const b = classifyPath('Flash (2014).mkv');
    expect(a.movie!.year).toBe(1990);
    expect(b.movie!.year).toBe(2014);
    // sourceKey includes the year so both items coexist.
    expect(a.movie!.title).toBe(b.movie!.title);
  });

  it('normalizes name keys', () => {
    expect(normalizeNameKey('The.Matrix.1999')).toBe('matrix 1999');
    expect(normalizeNameKey('肖申克的救赎')).toBe('肖申克的救赎');
  });
});

// ---------------------------------------------------------------------------
// integration: walker + driver + controller against a real temp database
// ---------------------------------------------------------------------------

interface FakeNode {
  isDir: boolean;
  size?: number;
  mtime?: number;
}

function makeTreeAdapter(entries: Record<string, { size?: number; mtime?: number }>): SourceAdapter {
  const nodes = new Map<string, FakeNode>();
  for (const [path, meta] of Object.entries(entries)) {
    nodes.set(path, { isDir: false, ...meta });
    const segments = path.split('/');
    for (let i = 1; i < segments.length; i += 1) {
      const dir = segments.slice(0, i).join('/');
      if (!nodes.has(dir)) nodes.set(dir, { isDir: true });
    }
  }
  const adapter: SourceAdapter = {
    kind: 'local',
    async *list(relativePath: string, signal: AbortSignal): AsyncGenerator<SourceEntry> {
      const prefix = relativePath === '' ? '' : `${relativePath}/`;
      const children = [...nodes.entries()]
        .filter(([p]) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
        .map(([p, node]) => ({
          relativePath: p,
          isDirectory: node.isDir,
          size: node.size,
          mtime: node.mtime,
        }))
        .sort((a, b) => (a.relativePath < b.relativePath ? -1 : 1));
      for (const entry of children) {
        if (signal.aborted) return;
        yield entry;
      }
    },
    testConnection: async () => ({ canSeek: true, canDelete: false, supportsEtag: false, supportsRange: true }),
    stat: async () => ({ supportsRange: true }),
    open: async () => {
      throw new Error('not implemented in test adapter');
    },
  };
  return adapter;
}

function scanningAdapterOf(adapter: SourceAdapter): SourceAdapter {
  return { ...adapter, list: (path: string, signal: AbortSignal) => walkSourceTree(adapter, path, signal) };
}

let dbPath: string;
let dbDir: string;
let repo: CatalogRepository;

beforeEach(() => {
  dbDir = mkdtempSync(join(tmpdir(), 'qy-local-scan-'));
  dbPath = join(dbDir, 'catalog.db');
  repo = createCatalogRepository(openDatabaseAtPath(dbPath));
});

afterEach(() => {
  rmSync(dbDir, { recursive: true, force: true });
});

async function runScan(adapter: SourceAdapter, driver: ScanDriver, sourceId: number): Promise<number> {
  const controller = new ScanJobController({
    repo,
    adapter,
    driver,
    sourceId,
    root: '/fake-root',
  });
  return controller.start();
}

function makeSource(): number {
  return repo.createSource({ kind: 'local', name: '测试库', root: '/fake-root' });
}

describe('local scan driver', () => {
  it('builds series → season → episode hierarchy', async () => {
    const sourceId = makeSource();
    const adapter = makeTreeAdapter({
      '硅谷/Silicon Valley S01E01.mkv': { size: 100, mtime: 1 },
      '硅谷/Silicon Valley S01E02.mkv': { size: 110, mtime: 2 },
      '硅谷/Season 2/Silicon Valley S02E01.mkv': { size: 200, mtime: 3 },
    });
    const driver = createLocalScanDriver({ repo, sourceId });
    const runId = await runScan(scanningAdapterOf(adapter), driver, sourceId);
    expect(repo.getScanRun(runId)!.status).toBe('completed');

    const items = repo.listByParent(null, sourceId);
    const series = items.find((i) => i.kind === 'series')!;
    // Filename prefix wins when present.
    expect(series.title).toBe('Silicon Valley');
    const seasons = repo.listByParent(series.id);
    expect(seasons.map((s) => s.season_number).sort()).toEqual([1, 2]);
    const s1 = seasons.find((s) => s.season_number === 1)!;
    const eps = repo.listByParent(s1.id);
    expect(eps.map((e) => e.episode_number)).toEqual([1, 2]);
  });

  it('takes the series title from the directory when the filename has none', async () => {
    const sourceId = makeSource();
    const adapter = makeTreeAdapter({
      '绝命毒师/Season 1/01.mkv': { size: 100, mtime: 1 },
      '绝命毒师/Season 1/02.mkv': { size: 110, mtime: 2 },
    });
    const driver = createLocalScanDriver({ repo, sourceId });
    await runScan(scanningAdapterOf(adapter), driver, sourceId);
    const series = repo.listByParent(null, sourceId).find((i) => i.kind === 'series')!;
    expect(series.title).toBe('绝命毒师');
    const episodes = repo.listByParent(repo.listByParent(series.id)[0].id);
    expect(episodes.map((e) => e.episode_number)).toEqual([1, 2]);
  });

  it('groups a movie directory: largest file wins, extras attach, sample is dropped', async () => {
    const sourceId = makeSource();
    const adapter = makeTreeAdapter({
      'Movie (2019)/Movie (2019).mkv': { size: 500, mtime: 1 },
      'Movie (2019)/Movie (2019) 720p.mkv': { size: 100, mtime: 2 },
      'Movie (2019)/trailer.mkv': { size: 50, mtime: 3 },
      'Movie (2019)/sample.mkv': { size: 10, mtime: 4 },
    });
    const driver = createLocalScanDriver({ repo, sourceId });
    await runScan(scanningAdapterOf(adapter), driver, sourceId);

    const movies = repo.listByParent(null, sourceId).filter((i) => i.kind === 'movie');
    expect(movies).toHaveLength(1);
    expect(movies[0].title).toBe('Movie');
    expect(movies[0].year).toBe(2019);
    const files = repo.listFilesByItem(movies[0].id);
    expect(files.map((f) => f.relative_path).sort()).toEqual([
      'Movie (2019)/Movie (2019) 720p.mkv',
      'Movie (2019)/Movie (2019).mkv',
      'Movie (2019)/trailer.mkv',
    ]);
    // Sample produced no item and no file anywhere.
    const allFiles = repo.listFilesBySource(sourceId);
    expect(allFiles.some((f) => f.relative_path.includes('sample'))).toBe(false);
  });

  it('indexes NFO and sidecar files as nothing (metadata arrives with QYP2-010)', async () => {
    const sourceId = makeSource();
    const adapter = makeTreeAdapter({
      'Movie (2019)/Movie (2019).mkv': { size: 500, mtime: 1 },
      'Movie (2019)/movie.nfo': { size: 10, mtime: 1 },
      'Movie (2019)/poster.jpg': { size: 10, mtime: 1 },
    });
    const driver = createLocalScanDriver({ repo, sourceId });
    await runScan(scanningAdapterOf(adapter), driver, sourceId);
    expect(repo.listFilesBySource(sourceId)).toHaveLength(1);
  });

  it('second unchanged scan does not rewrite rows (fingerprint skip)', async () => {
    const sourceId = makeSource();
    const tree = { 'Movie (2019)/Movie (2019).mkv': { size: 500, mtime: 1000 } };
    const adapter = makeTreeAdapter(tree);
    const driver = createLocalScanDriver({ repo, sourceId });
    await runScan(scanningAdapterOf(adapter), driver, sourceId);
    const fileAfterFirst = repo.listFilesBySource(sourceId)[0];
    expect(fileAfterFirst.fingerprint).toBe('500:1000');
    const itemAfterFirst = repo.listByParent(null, sourceId)[0];

    await runScan(scanningAdapterOf(adapter), createLocalScanDriver({ repo, sourceId }), sourceId);
    const fileAfterSecond = repo.listFilesBySource(sourceId)[0];
    expect(fileAfterSecond.updated_at).toBe(fileAfterFirst.updated_at);
    const itemAfterSecond = repo.listByParent(null, sourceId)[0];
    expect(itemAfterSecond.updated_at).toBe(itemAfterFirst.updated_at);
  });

  it('re-indexes a file whose size/mtime changed', async () => {
    const sourceId = makeSource();
    const adapter = makeTreeAdapter({ 'a.mkv': { size: 100, mtime: 1 } });
    await runScan(scanningAdapterOf(adapter), createLocalScanDriver({ repo, sourceId }), sourceId);
    const before = repo.listFilesBySource(sourceId)[0];
    const adapter2 = makeTreeAdapter({ 'a.mkv': { size: 250, mtime: 99 } });
    await runScan(scanningAdapterOf(adapter2), createLocalScanDriver({ repo, sourceId }), sourceId);
    const after = repo.listFilesBySource(sourceId)[0];
    expect(after.fingerprint).toBe('250:99');
    expect(after.id).toBe(before.id);
  });

  it('marks disappeared items missing only after a successful full scan', async () => {
    const sourceId = makeSource();
    const tree = {
      'Keep (2019)/Keep (2019).mkv': { size: 100, mtime: 1 },
      'Gone (2020)/Gone (2020).mkv': { size: 100, mtime: 2 },
    };
    await runScan(
      scanningAdapterOf(makeTreeAdapter(tree)),
      createLocalScanDriver({ repo, sourceId }),
      sourceId
    );
    // Full scan of the reduced tree, finalize runs.
    const driver = createLocalScanDriver({ repo, sourceId });
    const runId = await runScan(scanningAdapterOf(makeTreeAdapter({ 'Keep (2019)/Keep (2019).mkv': { size: 100, mtime: 1 } })), driver, sourceId);
    expect(repo.getScanRun(runId)!.status).toBe('completed');
    markAvailabilityAfterScan(repo, sourceId, driver.seen, { fullScan: true });
    const items = repo.listByParent(null, sourceId);
    const keep = items.find((i) => i.title === 'Keep')!;
    const gone = items.find((i) => i.title === 'Gone')!;
    expect(keep.availability).toBe('online');
    expect(gone.availability).toBe('missing');
    // History/state of the missing item is untouched.
    repo.upsertUserState({ itemId: gone.id, position: 30 });
    expect(repo.getUserState(gone.id)!.position).toBe(30);
  });

  it('never marks missing when the scan fails or is partial', async () => {
    const sourceId = makeSource();
    await runScan(
      scanningAdapterOf(makeTreeAdapter({ 'a.mkv': { size: 1, mtime: 1 } })),
      createLocalScanDriver({ repo, sourceId }),
      sourceId
    );
    // Failing adapter: walks fine but the driver throws mid-indexing.
    const failingDriver: ScanDriver = {
      index: async (entry) => {
        if (!entry.isDirectory) throw new Error('boom');
      },
    };
    const runId = await runScan(scanningAdapterOf(makeTreeAdapter({ 'a.mkv': { size: 1, mtime: 1 }, 'b/b.mkv': { size: 1, mtime: 1 } })), failingDriver, sourceId);
    expect(repo.getScanRun(runId)!.status).toBe('failed');
    // Even if someone finalized with an empty/partial seen set, the guard holds.
    const driver = createLocalScanDriver({ repo, sourceId });
    markAvailabilityAfterScan(repo, sourceId, driver.seen, { fullScan: true });
    const item = repo.listByParent(null, sourceId)[0];
    expect(item.availability).toBe('online');
  });

  it('does not mark missing on a resumed (partial) scan', async () => {
    const sourceId = makeSource();
    await runScan(
      scanningAdapterOf(makeTreeAdapter({ 'a.mkv': { size: 1, mtime: 1 }, 'b.mkv': { size: 1, mtime: 2 } })),
      createLocalScanDriver({ repo, sourceId }),
      sourceId
    );
    const driver = createLocalScanDriver({ repo, sourceId });
    // Partial walk: only entries after the cursor are visited.
    const partialAdapter = makeTreeAdapter({ 'a.mkv': { size: 1, mtime: 1 }, 'b.mkv': { size: 1, mtime: 2 } });
    const controller = new ScanJobController({
      repo,
      adapter: scanningAdapterOf(partialAdapter),
      driver,
      sourceId,
      root: '/fake-root',
    });
    const runId = await controller.start({ fromCursor: 'a.mkv' });
    expect(repo.getScanRun(runId)!.status).toBe('completed');
    markAvailabilityAfterScan(repo, sourceId, driver.seen, { fullScan: false });
    const items = repo.listByParent(null, sourceId);
    expect(items.every((i) => i.availability === 'online')).toBe(true);
  });

  it('caps pathological trees with a failure instead of silent truncation', async () => {
    const sourceId = makeSource();
    const entries: Record<string, { size?: number; mtime?: number }> = {};
    for (let i = 0; i < 50; i += 1) entries[`f${i}.mkv`] = { size: 1, mtime: i };
    const driver = createLocalScanDriver({ repo, sourceId });
    const cappedAdapter = makeTreeAdapter(entries);
    const scanning: SourceAdapter = {
      ...cappedAdapter,
      list: (path: string, signal: AbortSignal) => walkSourceTree(cappedAdapter, path, signal, { maxEntries: 10 }),
    };
    const runId = await runScan(scanning, driver, sourceId);
    expect(repo.getScanRun(runId)!.status).toBe('failed');
  });

  it('walks nested trees via the recursive list wrapper', async () => {
    const sourceId = makeSource();
    const tree: Record<string, { size?: number; mtime?: number }> = {};
    for (let d = 0; d < 10; d += 1) {
      for (let f = 0; f < 5; f += 1) {
        tree[`dir${d}/dir${d}-sub/f${f}.mkv`] = { size: 10 + f, mtime: d * 10 + f };
      }
    }
    const driver = createLocalScanDriver({ repo, sourceId });
    const runId = await runScan(scanningAdapterOf(makeTreeAdapter(tree)), driver, sourceId);
    expect(repo.getScanRun(runId)!.status).toBe('completed');
    expect(repo.listFilesBySource(sourceId)).toHaveLength(50);
  });

  it('resume cursor: skips only up to the cursor, then continues', async () => {
    const sourceId = makeSource();
    const tree = {
      'a.mkv': { size: 1, mtime: 1 },
      'b/b.mkv': { size: 2, mtime: 2 },
      'c.mkv': { size: 3, mtime: 3 },
    };
    const driver = createLocalScanDriver({ repo, sourceId });
    const controller = new ScanJobController({
      repo,
      adapter: scanningAdapterOf(makeTreeAdapter(tree)),
      driver,
      sourceId,
      root: '/fake-root',
    });
    const runId = await controller.start({ fromCursor: 'a.mkv' });
    expect(repo.getScanRun(runId)!.status).toBe('completed');
    // Cursor (a.mkv) itself is skipped; everything after it is covered.
    expect(repo.listFilesBySource(sourceId).map((f) => f.relative_path).sort()).toEqual(['b/b.mkv', 'c.mkv']);
  });

  it('resume cursor that no longer exists falls back to a full walk', async () => {
    const sourceId = makeSource();
    const tree = {
      'a.mkv': { size: 1, mtime: 1 },
      'b.mkv': { size: 2, mtime: 2 },
    };
    const driver = createLocalScanDriver({ repo, sourceId });
    const controller = new ScanJobController({
      repo,
      adapter: scanningAdapterOf(makeTreeAdapter(tree)),
      driver,
      sourceId,
      root: '/fake-root',
    });
    const runId = await controller.start({ fromCursor: 'ghost.mkv' });
    expect(repo.getScanRun(runId)!.status).toBe('completed');
    expect(repo.listFilesBySource(sourceId)).toHaveLength(2);
  });

  it('handles a 10,000-entry synthetic tree (baseline)', async () => {
    const sourceId = makeSource();
    const entries: Record<string, { size?: number; mtime?: number }> = {};
    for (let d = 0; d < 200; d += 1) {
      for (let f = 0; f < 50; f += 1) {
        entries[`show${d}/Season 1/Show ${String(d).padStart(3, '0')} S01E${String(f + 1).padStart(2, '0')}.mkv`] = {
          size: 1000 + f,
          mtime: d * 100 + f,
        };
      }
    }
    const driver = createLocalScanDriver({ repo, sourceId });
    const started = Date.now();
    const runId = await runScan(scanningAdapterOf(makeTreeAdapter(entries)), driver, sourceId);
    const elapsedMs = Date.now() - started;
    expect(repo.getScanRun(runId)!.status).toBe('completed');
    expect(repo.listFilesBySource(sourceId)).toHaveLength(10_000);
    // Baseline evidence only; generous ceiling to stay deterministic on CI.
    expect(elapsedMs).toBeLessThan(60_000);
    console.log(`[BASELINE] 10,000-entry synthetic scan: ${elapsedMs}ms`);
  }, 120_000);
});
