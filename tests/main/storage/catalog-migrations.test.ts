import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

// db.ts imports { app } from 'electron'; stub it so integration tests run in
// plain Node. The mock is hoisted and must not close over outer variables.
vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => join(tmpdir(), 'qy-player-migration-test', name),
  },
}));

import { openDatabaseAtPath, runMigrations } from '../../../src/main/modules/storage/db';
import { createCatalogRepository } from '../../../src/main/modules/catalog/repository';

const CATALOG_TABLES = [
  'library_sources',
  'catalog_items',
  'catalog_files',
  'catalog_streams',
  'catalog_external_ids',
  'catalog_user_state',
  'catalog_subtitles',
  'catalog_metadata_sources',
  'catalog_metadata_overrides',
  'scan_runs',
  'plugin_configs',
  'plugin_cache',
] as const;

const LEGACY_TABLES = ['local_media', 'playback_progress', 'watch_history', 'servers', 'app_config'] as const;

const tmpRoots: string[] = [];
function makeDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qy-migration-'));
  tmpRoots.push(dir);
  return join(dir, 'test.db');
}
afterAll(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
});

function tableNames(db: Database.Database): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{
      name: string;
    }>
  ).map((r) => r.name);
}

function getVersion(db: Database.Database): number {
  return (db.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version: number }).version;
}

describe('catalog migrations (005)', () => {
  it('applies the full chain on an empty database', () => {
    const db = openDatabaseAtPath(makeDbPath());
    expect(getVersion(db)).toBe(5);
    const tables = tableNames(db);
    for (const table of CATALOG_TABLES) expect(tables).toContain(table);
    for (const table of LEGACY_TABLES) expect(tables).toContain(table);
  });

  it('upgrades a v4 fixture and preserves legacy tables, rows and CHECKs', () => {
    const path = makeDbPath();
    // Build a real v4 database, then stop at migration 004.
    const v4 = new Database(path);
    v4.pragma('journal_mode = WAL');
    runMigrations(v4, { upTo: 4 });
    expect(getVersion(v4)).toBe(4);
    v4.prepare('INSERT INTO local_media (path, title, duration) VALUES (?, ?, ?)').run(
      '/old/library/movie.mkv',
      'Old Movie',
      7200
    );
    const legacyId = (v4.prepare('SELECT id FROM local_media').get() as { id: number }).id;
    v4.prepare(
      'INSERT INTO playback_progress (media_type, local_media_id, position, duration, is_finished) VALUES (?, ?, ?, ?, ?)'
    ).run('local', legacyId, 600, 7200, 0);
    v4.prepare(
      'INSERT INTO watch_history (media_type, media_id, title, position, series_name, season_number, episode_number) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('local', '/old/library/movie.mkv', 'Old Movie', 600, null, null, null);
    v4.close();

    // Reopen through the normal path: only migration 005 runs.
    const db = openDatabaseAtPath(path);
    expect(getVersion(db)).toBe(5);
    expect((db.prepare('SELECT COUNT(*) AS n FROM local_media').get() as { n: number }).n).toBe(1);
    expect((db.prepare('SELECT position FROM playback_progress').get() as { position: number }).position).toBe(600);

    // The legacy media_type CHECK must still be in force.
    expect(() =>
      db
        .prepare(
          'INSERT INTO playback_progress (media_type, server_id, position) VALUES (?, ?, ?)'
        )
        .run('webdav', 'x', 1)
    ).toThrow();
  });

  it('is idempotent across repeated openings', () => {
    const path = makeDbPath();
    const first = openDatabaseAtPath(path);
    const version = getVersion(first);
    first.close();
    const second = openDatabaseAtPath(path);
    expect(getVersion(second)).toBe(version);
    second.close();
    const third = openDatabaseAtPath(path);
    expect(getVersion(third)).toBe(version);
  });

  it('enforces foreign keys with cascade deletes', () => {
    const db = openDatabaseAtPath(makeDbPath());
    const repo = createCatalogRepository(db);
    const sourceId = repo.createSource({ kind: 'local', name: 'Movies', root: '/data/movies' });
    const itemId = repo.upsertItem({ sourceId, sourceKey: 'Series', kind: 'series', title: 'Series' });
    const childId = repo.upsertItem({
      sourceId,
      sourceKey: 'Series/S01',
      parentId: itemId,
      kind: 'season',
      seasonNumber: 1,
    });
    repo.upsertFile({ sourceId, itemId: childId, relativePath: 'Series/S01/e01.mkv', size: 1 });
    repo.upsertUserState({ itemId: childId, position: 30, duration: 1800 });

    // FK: item under an unknown source is rejected.
    expect(() =>
      repo.upsertItem({ sourceId: 9999, sourceKey: 'ghost', kind: 'video' })
    ).toThrow();

    // Cascade: removing a source removes its items, files and user state.
    repo.deleteSource(sourceId);
    expect(repo.getItem(childId)).toBeUndefined();
    expect(repo.getUserState(childId)).toBeUndefined();
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM catalog_files').get() as { n: number }).n
    ).toBe(0);
  });

  it('enforces unique keys on items, files, external ids and streams', () => {
    const db = openDatabaseAtPath(makeDbPath());
    const repo = createCatalogRepository(db);
    const sourceId = repo.createSource({ kind: 'local', name: 'S', root: '/data/s' });
    repo.upsertItem({ sourceId, sourceKey: 'a', kind: 'movie', title: 'A' });
    expect(() => {
      db.prepare('INSERT INTO catalog_items (source_id, source_key, kind) VALUES (?, ?, ?)').run(
        sourceId,
        'a',
        'movie'
      );
    }).toThrow();

    const itemId = repo.getItemKey(sourceId, 'a')!.id;
    repo.upsertFile({ sourceId, itemId, relativePath: 'a.mkv' });
    expect(() => {
      db.prepare('INSERT INTO catalog_files (source_id, item_id, relative_path) VALUES (?, ?, ?)').run(
        sourceId,
        itemId,
        'a.mkv'
      );
    }).toThrow();

    repo.upsertExternalId('tmdb', '42', itemId);
    expect(repo.findItemIdByExternalId('tmdb', '42')).toBe(itemId);
    expect(() =>
      db
        .prepare('INSERT INTO catalog_external_ids (provider, external_id, item_id) VALUES (?, ?, ?)')
        .run('tmdb', '42', itemId)
    ).toThrow();

    const fileId = repo.listFilesByItem(itemId)[0].id;
    repo.replaceStreams(fileId, [
      { streamIndex: 0, kind: 'video', codec: 'h264' },
      { streamIndex: 1, kind: 'audio', codec: 'aac', language: 'chi' },
    ]);
    expect(() =>
      db.prepare('INSERT INTO catalog_streams (file_id, stream_index, kind) VALUES (?, ?, ?)').run(
        fileId,
        0,
        'video'
      )
    ).toThrow();
    // Replace semantics: re-probing overwrites instead of duplicating.
    repo.replaceStreams(fileId, [{ streamIndex: 0, kind: 'video', codec: 'hevc' }]);
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM catalog_streams WHERE file_id = ?').get(fileId) as { n: number }).n
    ).toBe(1);
  });

  it('library_sources rejects credential-bearing roots and bad kinds', () => {
    const db = openDatabaseAtPath(makeDbPath());
    expect(() =>
      db
        .prepare('INSERT INTO library_sources (kind, name, root) VALUES (?, ?, ?)')
        .run('local', 'bad', 'https://user:pass@host/dav')
    ).toThrow();
    expect(() =>
      db
        .prepare('INSERT INTO library_sources (kind, name, root) VALUES (?, ?, ?)')
        .run('smb', 'bad', '/data')
    ).toThrow();
  });

  it('catalog upserts never null-out previously valid values', () => {
    const db = openDatabaseAtPath(makeDbPath());
    const repo = createCatalogRepository(db);
    const sourceId = repo.createSource({ kind: 'local', name: 'S', root: '/data' });

    // Item: a rescan without title keeps the old title and bumps the same row.
    const id = repo.upsertItem({ sourceId, sourceKey: 'm', kind: 'movie', title: 'Kept', year: 2001 });
    const again = repo.upsertItem({ sourceId, sourceKey: 'm', kind: 'movie' });
    expect(again).toBe(id);
    const item = repo.getItem(id)!;
    expect(item.title).toBe('Kept');
    expect(item.year).toBe(2001);

    // User state: progress update without duration keeps the stored duration.
    repo.upsertUserState({ itemId: id, position: 100, duration: 5000 });
    repo.upsertUserState({ itemId: id, position: 200 });
    const state = repo.getUserState(id)!;
    expect(state.position).toBe(200);
    expect(state.duration).toBe(5000);

    // Episode numbers and file attributes survive partial rescans too.
    repo.upsertItem({ sourceId, sourceKey: 'e', kind: 'episode', seasonNumber: 1, episodeNumber: 5 });
    repo.upsertItem({ sourceId, sourceKey: 'e', kind: 'episode' });
    const episode = repo.getItem(repo.getItemKey(sourceId, 'e')!.id)!;
    expect(episode.season_number).toBe(1);
    expect(episode.episode_number).toBe(5);

    const fileId = repo.upsertFile({
      sourceId,
      itemId: episode.id,
      relativePath: 'e.mkv',
      size: 1234,
      mtime: 111111,
      fingerprint: 'e.mkv|1234|111111',
    });
    repo.upsertFile({ sourceId, itemId: episode.id, relativePath: 'e.mkv' });
    const file = repo.listFilesByItem(episode.id)[0];
    expect(file.id).toBe(fileId);
    expect(file.size).toBe(1234);
    expect(file.mtime).toBe(111111);
    expect(file.fingerprint).toBe('e.mkv|1234|111111');

    // metadata_revision is untouched by catalog upserts (owned by QYP2-022).
    expect(item.metadata_revision).toBe(0);
  });
});
