import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabaseAtPath } from '../../../src/main/modules/storage/db';
import { createCatalogRepository, type CatalogRepository } from '../../../src/main/modules/catalog/repository';
import { ScanJobController } from '../../../src/main/modules/library-scanner/job-controller';
import type { SourceAdapter, SourceEntry, ScanDriver } from '../../../src/main/modules/library-sources/types';
import { createLocalScanDriver, walkSourceTree } from '../../../src/main/modules/library-scanner/local-scanner';
import type Database from 'better-sqlite3';

/**
 * 来源用途的扫描过滤（QYP3-039/041）：'music' 只索引音频、'video' 只索引视频，
 * 不再有"混放"模式——缺省按视频处理。'video' 的收尾清理必须跳过音轨删除
 * （批次里没有音频路径，跑了会把存量音轨全删）。
 */

let dbPath: string;
let dbDir: string;
let repo: CatalogRepository;
let db: Database.Database;

type TreeNode = { size: number; mtime: number };

/** 最小内存树适配器（沿用 local-scan.test 的 makeTreeAdapter 思路）。 */
function makeTreeAdapter(tree: Record<string, TreeNode>): SourceAdapter {
  const dirs = new Set<string>();
  for (const path of Object.keys(tree)) {
    const parts = path.split('/');
    parts.pop();
    let cur = '';
    for (const part of parts) {
      cur = cur ? `${cur}/${part}` : part;
      dirs.add(cur);
    }
  }
  return {
    kind: 'local',
    list: async function* (path: string): AsyncGenerator<SourceEntry> {
      const prefix = path === '' ? '' : `${path}/`;
      for (const dir of [...dirs].sort()) {
        if (dir.startsWith(prefix) && !dir.slice(prefix.length).includes('/')) {
          yield { relativePath: dir, isDirectory: true };
        }
      }
      const children = Object.entries(tree)
        .filter(([p]) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
        .map(([p, node]) => ({
          relativePath: p,
          isDirectory: false,
          size: node.size,
          mtime: node.mtime,
        }))
        .sort((a, b) => (a.relativePath < b.relativePath ? -1 : 1));
      for (const entry of children) yield entry;
    },
    testConnection: async () => ({ canSeek: true, canDelete: false, supportsEtag: false, supportsRange: true }),
    stat: async () => ({ supportsRange: true }),
    open: async () => {
      throw new Error('not implemented in test adapter');
    },
  } as SourceAdapter;
}

function scanningAdapterOf(adapter: SourceAdapter): SourceAdapter {
  return { ...adapter, list: (path: string, signal: AbortSignal) => walkSourceTree(adapter, path, signal) };
}

async function runScan(adapter: SourceAdapter, driver: ScanDriver, sourceId: number): Promise<void> {
  const controller = new ScanJobController({ repo, adapter, driver, sourceId, root: '/fake-root' });
  await controller.start();
}

beforeEach(() => {
  dbDir = mkdtempSync(join(tmpdir(), 'qy-purpose-scan-'));
  dbPath = join(dbDir, 'catalog.db');
  db = openDatabaseAtPath(dbPath);
  repo = createCatalogRepository(db);
});

afterEach(() => {
  db.close();
  rmSync(dbDir, { recursive: true, force: true });
});

const MIXED_TREE = {
  '电影/绝命毒师.S01E01.mkv': { size: 9000, mtime: 1 },
  '电影/show.nfo': { size: 100, mtime: 2 },
  '音乐/晴天.mp3': { size: 4000, mtime: 3 },
  '音乐/串烧.cue': { size: 30, mtime: 4 },
};

describe('scan filter by source purpose (QYP3-039/041)', () => {
  it('defaults to video: indexes video/nfo, never audio', async () => {
    const sourceId = repo.createSource({ kind: 'local', name: '未标记', root: '/fake-root' });
    expect(repo.getSource(sourceId)?.purpose).toBe('video');
    const driver = createLocalScanDriver({ repo, sourceId });
    await runScan(scanningAdapterOf(makeTreeAdapter(MIXED_TREE)), driver, sourceId);
    expect(repo.listItemsBySource(sourceId).length).toBeGreaterThan(0);
    expect(repo.listMusicTracks(sourceId)).toHaveLength(0);
  });

  it("purpose 'music' skips video and nfo, still indexes audio", async () => {
    const sourceId = repo.createSource({ kind: 'local', name: '音乐盘', root: '/fake-root', purpose: 'music' });
    const driver = createLocalScanDriver({ repo, sourceId, purpose: 'music' });
    await runScan(scanningAdapterOf(makeTreeAdapter(MIXED_TREE)), driver, sourceId);
    expect(repo.listMusicTracks(sourceId).length).toBe(1);
    expect(repo.listItemsBySource(sourceId)).toHaveLength(0);
  });

  it("purpose 'video' skips audio and cue, keeps pre-existing music tracks", async () => {
    const sourceId = repo.createSource({ kind: 'local', name: '影片盘', root: '/fake-root', purpose: 'video' });
    // 存量音轨（此前 'all' 扫描留下的）：'video' 扫描不得误删
    repo.upsertMusicTrack({
      sourceId,
      sourceKey: 'old.mp3',
      path: '/fake-root/old.mp3',
      title: '旧曲',
      fingerprint: 'f-old',
    });
    const driver = createLocalScanDriver({ repo, sourceId, purpose: 'video' });
    await runScan(scanningAdapterOf(makeTreeAdapter(MIXED_TREE)), driver, sourceId);
    expect(repo.listItemsBySource(sourceId).length).toBeGreaterThan(0);
    // 音频/CUE 都不入库，且存量音轨完好（cleanupMissingMusic 被跳过）
    expect(repo.listMusicTracks(sourceId)).toHaveLength(1);
    expect(repo.listMusicTracks(sourceId)[0].source_key).toBe('old.mp3');
    const cues = db
      .prepare('SELECT COUNT(*) c FROM music_cue_entries')
      .get() as { c: number };
    expect(cues.c).toBe(0);
  });
});
