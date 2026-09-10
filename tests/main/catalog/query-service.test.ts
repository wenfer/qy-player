import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabaseAtPath } from '../../../src/main/modules/storage/db';
import {
  isCatalogBrowseQuery as isCatalogBrowseQuerySafe,
  isCatalogSearchQuery as isCatalogSearchQuerySafe,
} from '../../../src/shared/types';
import { createCatalogRepository, type CatalogRepository } from '../../../src/main/modules/catalog/repository';
import { createCatalogQueryService, type CatalogQueryService } from '../../../src/main/modules/catalog/query-service';
import { migrateLegacyProgressForSource } from '../../../src/main/modules/catalog/legacy-progress';
import { ScanJobController } from '../../../src/main/modules/library-scanner/job-controller';
import {
  createLocalScanDriver,
  walkSourceTree,
} from '../../../src/main/modules/library-scanner/local-scanner';
import type { SourceAdapter, SourceEntry } from '../../../src/main/modules/library-sources/types';
import type BetterSqlite3 from 'better-sqlite3';

// --- fixture tree -----------------------------------------------------------

const MOVIE_NFO = `<movie><title>流浪地球</title><originaltitle>The Wandering Earth</originaltitle><year>2019</year><rating>7.9</rating><plot>太阳即将毁灭。</plot><genre>科幻</genre><genre>灾难</genre><actor><name>吴京</name><role>刘培强</role></actor><director>郭帆</director><runtime>125</runtime></movie>`;
const SHOW_NFO = `<tvshow><title>绝命毒师</title><originaltitle>Breaking Bad</originaltitle><plot>化学老师的转身。</plot><studio>AMC</studio></tvshow>`;
const EP_NFO_1 = `<episodedetails><title>初见</title><plot>第一集剧情。</plot><rating>8.1</rating></episodedetails>`;

interface TreeFile {
  size: number;
  mtime: number;
  content?: string;
}

function makeTree(files: Record<string, TreeFile>): { adapter: SourceAdapter; nfoContents: Map<string, string> } {
  const nodes = new Map<string, { isDir: boolean; size?: number; mtime?: number }>();
  const nfoContents = new Map<string, string>();
  for (const [path, meta] of Object.entries(files)) {
    nodes.set(path, { isDir: false, size: meta.size, mtime: meta.mtime });
    if (meta.content !== undefined) nfoContents.set(path, meta.content);
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
  return { adapter, nfoContents };
}

let dbPath: string;
let dbDir: string;
let db: BetterSqlite3.Database;
let repo: CatalogRepository;
let query: CatalogQueryService;

beforeEach(() => {
  dbDir = mkdtempSync(join(tmpdir(), 'qy-query-'));
  dbPath = join(dbDir, 'catalog.db');
  db = openDatabaseAtPath(dbPath);
  repo = createCatalogRepository(db);
  query = createCatalogQueryService(db);
});

afterEach(() => {
  db.close();
  rmSync(dbDir, { recursive: true, force: true });
});

async function scanTree(
  sourceId: number,
  tree: ReturnType<typeof makeTree>
): Promise<number> {
  const driver = createLocalScanDriver({
    repo,
    sourceId,
    readNfo: async (relativePath) => {
      const content = tree.nfoContents.get(relativePath);
      if (content === undefined) throw new Error('NFO 内容缺失（fixture 错误）');
      return Buffer.from(content, 'utf8');
    },
  });
  const scanning: SourceAdapter = {
    ...tree.adapter,
    list: (path: string, signal: AbortSignal) => walkSourceTree(tree.adapter, path, signal),
  };
  const controller = new ScanJobController({ repo, adapter: scanning, driver, sourceId, root: '/root' });
  return controller.start();
}

function makeSource(): number {
  return repo.createSource({ kind: 'local', name: '测试库', root: '/root' });
}

describe('catalog query service', () => {
  it('browses the top level with NFO-winner titles and ratings', async () => {
    const sourceId = makeSource();
    const tree = makeTree({
      '流浪地球 (2019)/流浪地球 (2019).mkv': { size: 500, mtime: 1, content: undefined },
      '流浪地球 (2019)/movie.nfo': { size: 10, mtime: 1, content: MOVIE_NFO },
      '普通文件.avi': { size: 100, mtime: 2 },
    });
    const runId = await scanTree(sourceId, tree);
    expect(repo.getScanRun(runId)!.status).toBe('completed');

    const page = query.listPage({ sourceId, parentId: null });
    expect(page.items).toHaveLength(2);
    const movie = page.items.find((i) => i.kind === 'movie')!;
    // NFO wins over filename classification.
    expect(movie.title).toBe('流浪地球');
    expect(movie.year).toBe(2019);
    expect(movie.rating).toBeCloseTo(7.9);
    const video = page.items.find((i) => i.kind === 'video')!;
    expect(video.title).toBe('普通文件');
  });

  it('paginates deterministically', async () => {
    const sourceId = makeSource();
    const files: Record<string, { size: number; mtime: number }> = {};
    for (let i = 0; i < 5; i += 1) {
      files[`video${String(i).padStart(2, '0')}.mkv`] = { size: 10, mtime: i };
    }
    await scanTree(sourceId, makeTree(files));
    const page1 = query.listPage({ sourceId, parentId: null, page: 1, pageSize: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).toBe('2');
    const page3 = query.listPage({ sourceId, parentId: null, page: 3, pageSize: 2 });
    expect(page3.items).toHaveLength(1);
    expect(page3.nextCursor).toBeUndefined();
  });

  it('searches titles with metadata winners and escapes LIKE input', async () => {
    const sourceId = makeSource();
    await scanTree(
      sourceId,
      makeTree({
        '流浪地球 (2019)/流浪地球 (2019).mkv': { size: 500, mtime: 1 },
        '流浪地球 (2019)/movie.nfo': { size: 10, mtime: 1, content: MOVIE_NFO },
        '普通文件.avi': { size: 100, mtime: 2 },
      })
    );
    expect(query.search({ sourceId, query: '流浪' }).items.map((i) => i.title)).toContain('流浪地球');
    expect(query.search({ sourceId, query: 'The Wandering' }).items).toHaveLength(1);
    // % and _ are literal, not wildcards.
    expect(query.search({ sourceId, query: '%地球' }).items).toHaveLength(0);
    expect(query.search({ sourceId, query: '普通_件' }).items).toHaveLength(0);
    expect(query.search({ sourceId, query: '普通文件' }).items).toHaveLength(1);
  });

  it('returns series detail with NFO metadata, seasons and episodes', async () => {
    const sourceId = makeSource();
    await scanTree(
      sourceId,
      makeTree({
        '绝命毒师/tvshow.nfo': { size: 10, mtime: 1, content: SHOW_NFO },
        '绝命毒师/Season 1/绝命毒师 S01E01.mkv': { size: 100, mtime: 1, content: undefined },
        '绝命毒师/Season 1/绝命毒师 S01E01.nfo': { size: 10, mtime: 1, content: EP_NFO_1 },
        '绝命毒师/Season 1/绝命毒师 S01E02.mkv': { size: 110, mtime: 2 },
      })
    );
    const series = query.listPage({ sourceId, parentId: null }).items.find((i) => i.kind === 'series')!;
    const detail = query.getDetail(sourceId, Number(series.ref.itemId))!;
    expect(detail.metadata.plot).toBe('化学老师的转身。');
    expect(detail.metadata.originalTitle).toBe('Breaking Bad');
    expect(detail.metadata.studios).toEqual(['AMC']);
    expect(detail.item.title).toBe('绝命毒师');
    expect(detail.children.filter((c) => c.kind === 'season')).toHaveLength(1);
    const season = detail.children.find((c) => c.kind === 'season')!;
    const seasonDetail = query.getDetail(sourceId, Number(season.ref.itemId))!;
    const episodes = seasonDetail.children.filter((c) => c.kind === 'episode');
    expect(episodes.map((e) => e.episodeNumber)).toEqual([1, 2]);
    // Episode NFO winner: title from <episodedetails>.
    expect(episodes[0].title).toBe('初见');
    const epDetail = query.getDetail(sourceId, Number(episodes[0].ref.itemId))!;
    expect(epDetail.metadata.plot).toBe('第一集剧情。');
    expect(epDetail.fieldProviders.title?.provider).toBe('nfo');
  });

  it('provides playback intent with series context and progress', async () => {
    const sourceId = makeSource();
    await scanTree(
      sourceId,
      makeTree({
        '绝命毒师/Season 1/绝命毒师 S01E01.mkv': { size: 100, mtime: 1 },
      })
    );
    const series = query.listPage({ sourceId, parentId: null }).items.find((i) => i.kind === 'series')!;
    const seasonDetail = query.getDetail(sourceId, Number(series.ref.itemId))!;
    const season = seasonDetail.children.find((c) => c.kind === 'season')!;
    const ep = query.getDetail(sourceId, Number(season.ref.itemId))!.children[0];
    const intent = query.getPlayback(sourceId, Number(ep.ref.itemId))!;
    expect(intent.relativePath).toBe('绝命毒师/Season 1/绝命毒师 S01E01.mkv');
    expect(intent.seriesTitle).toBe('绝命毒师');
    expect(intent.seasonNumber).toBe(1);
    expect(intent.episodeNumber).toBe(1);
    expect(intent.position).toBe(0);

    repo.upsertUserState({ itemId: Number(ep.ref.itemId), position: 300, duration: 1800 });
    expect(query.getPlayback(sourceId, Number(ep.ref.itemId))!.position).toBe(300);
  });

  it('displays legacy local_media progress after migration', async () => {
    const sourceId = makeSource();
    await scanTree(
      sourceId,
      makeTree({ '普通文件.avi': { size: 1000, mtime: 5 } })
    );
    // Pre-phase-2 progress rows: local_media + playback_progress by path.
    const lm = db
      .prepare('INSERT INTO local_media (path, file_size, title) VALUES (?, ?, ?)')
      .run('/root/普通文件.avi', 1000, '普通文件');
    db.prepare(
      `INSERT INTO playback_progress (media_type, local_media_id, position, duration, is_finished, updated_at)
       VALUES ('local', ?, 120, 900, 0, unixepoch())`
    ).run(Number(lm.lastInsertRowid));

    const result = migrateLegacyProgressForSource(db, sourceId);
    expect(result.migrated).toBe(1);

    const page = query.listPage({ sourceId, parentId: null });
    const video = page.items[0];
    expect(video.progress).toEqual({ position: 120, duration: 900, isFinished: false });
  });

  it('keeps previous metadata when a later scan sees a broken NFO', async () => {
    const sourceId = makeSource();
    const files = {
      '流浪地球 (2019)/流浪地球 (2019).mkv': { size: 500, mtime: 1, content: undefined },
      '流浪地球 (2019)/movie.nfo': { size: 10, mtime: 1, content: MOVIE_NFO },
    };
    await scanTree(sourceId, makeTree(files));
    // Break the NFO and rescan (mtime bumped → file re-read).
    const broken = makeTree({
      '流浪地球 (2019)/流浪地球 (2019).mkv': { size: 500, mtime: 2, content: undefined },
      '流浪地球 (2019)/movie.nfo': { size: 10, mtime: 2, content: '<movie><title>未闭合' },
    });
    const runId = await scanTree(sourceId, broken);
    expect(repo.getScanRun(runId)!.status).toBe('completed');
    const movie = query.listPage({ sourceId, parentId: null }).items.find((i) => i.kind === 'movie')!;
    // Previous values survive.
    expect(movie.title).toBe('流浪地球');
    expect(movie.rating).toBeCloseTo(7.9);
  });

  it('rejects invalid browse/search input shapes at the contract level', () => {
    // The guards are the IPC boundary; exercise them directly.
    expect(isCatalogBrowseQuerySafe({ sourceId: 1 })).toBe(true);
    expect(isCatalogBrowseQuerySafe({ sourceId: -1 })).toBe(false);
    expect(isCatalogBrowseQuerySafe({ sourceId: 1, kind: 'nope' })).toBe(false);
    expect(isCatalogSearchQuerySafe({ query: '' })).toBe(false);
    expect(isCatalogSearchQuerySafe({ query: 'ok' })).toBe(true);
  });
});
