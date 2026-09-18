import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

// db.ts imports { app } from 'electron'; stub it so integration tests run in
// plain Node. The mock is hoisted and must not close over outer variables.
vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => join(tmpdir(), 'qy-player-purpose-test', name),
  },
}));

import { openDatabaseAtPath } from '../../../src/main/modules/storage/db';
import { createCatalogRepository } from '../../../src/main/modules/catalog/repository';
import { isSourcePurpose } from '../../../src/shared/types/catalog';

const tmpRoots: string[] = [];
function makeDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qy-source-purpose-'));
  tmpRoots.push(dir);
  return join(dir, 'test.db');
}
afterAll(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
});

/**
 * 来源用途标记（QYP3-039，migration 009）：library_sources.purpose，
 * 三值 all/music/video，存量行默认 'all'（行为零变化）。
 */
describe('source purpose (migration 009, QYP3-039)', () => {
  it('adds the purpose column with default all on a fresh database', () => {
    const db = openDatabaseAtPath(makeDbPath());
    const version = (db.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version: number }).version;
    expect(version).toBe(9);
    // 默认值：不加 purpose 的 INSERT 落 'all'
    db.prepare("INSERT INTO library_sources (kind, name, root) VALUES ('local', '老库', '/media')").run();
    const row = db.prepare("SELECT purpose FROM library_sources WHERE name = '老库'").get() as { purpose: string };
    expect(row.purpose).toBe('all');
    db.close();
  });

  it('createSource persists purpose and defaults to all', () => {
    const db = openDatabaseAtPath(makeDbPath());
    const repo = createCatalogRepository(db);
    const allId = repo.createSource({ kind: 'local', name: '混合', root: '/mix' });
    const musicId = repo.createSource({ kind: 'local', name: '音乐盘', root: '/music', purpose: 'music' });
    const videoId = repo.createSource({ kind: 'local', name: '影片盘', root: '/movies', purpose: 'video' });
    expect(repo.getSource(allId)?.purpose).toBe('all');
    expect(repo.getSource(musicId)?.purpose).toBe('music');
    expect(repo.getSource(videoId)?.purpose).toBe('video');
    db.close();
  });

  it('updateSource changes purpose; purge clears the other domain only', () => {
    const db = openDatabaseAtPath(makeDbPath());
    const repo = createCatalogRepository(db);
    const sourceId = repo.createSource({ kind: 'local', name: '混合', root: '/mix', purpose: 'all' });
    // 两域各放一条内容
    const itemId = repo.upsertItem({ sourceId, sourceKey: 'movie:m', kind: 'movie', title: '电影' });
    repo.upsertFile({ sourceId, itemId, relativePath: '电影.mkv', size: 1, mtime: 1 });
    repo.upsertMusicTrack({
      sourceId,
      sourceKey: 'a.mp3',
      path: '/mix/a.mp3',
      title: '曲',
      fingerprint: 'f1',
    });
    expect(repo.listItemsBySource(sourceId).length).toBeGreaterThan(0);
    expect(repo.listMusicTracks(sourceId).length).toBe(1);

    // 收窄为 music：清视频域、留音乐域
    repo.updateSource(sourceId, { purpose: 'music' });
    expect(repo.getSource(sourceId)?.purpose).toBe('music');
    repo.purgeVideoContentBySource(sourceId);
    expect(repo.listItemsBySource(sourceId)).toHaveLength(0);
    expect(repo.listMusicTracks(sourceId)).toHaveLength(1);

    // 收窄为 video：清音乐域、留视频域（重新放一条）
    const itemId2 = repo.upsertItem({ sourceId, sourceKey: 'movie:m2', kind: 'movie', title: '电影2' });
    repo.updateSource(sourceId, { purpose: 'video' });
    repo.purgeMusicTracksBySource(sourceId);
    expect(repo.getSource(sourceId)?.purpose).toBe('video');
    expect(repo.getItem(itemId2)).toBeDefined();
    expect(repo.listMusicTracks(sourceId)).toHaveLength(0);
    db.close();
  });

  it('isSourcePurpose accepts only the three whitelisted values', () => {
    expect(isSourcePurpose('all')).toBe(true);
    expect(isSourcePurpose('music')).toBe(true);
    expect(isSourcePurpose('video')).toBe(true);
    expect(isSourcePurpose('both')).toBe(false);
    expect(isSourcePurpose('')).toBe(false);
    expect(isSourcePurpose(null)).toBe(false);
    expect(isSourcePurpose(1)).toBe(false);
  });
});
