import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

// db.ts imports { app } from 'electron'; stub it so integration tests run in
// plain Node. The mock is hoisted and must not close over outer variables.
vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => join(tmpdir(), 'qy-player-legacy-test', name),
  },
}));

import { openDatabaseAtPath } from '../../../src/main/modules/storage/db';
import { createCatalogRepository, type CatalogRepository } from '../../../src/main/modules/catalog/repository';
import { migrateLegacyProgressForSource } from '../../../src/main/modules/catalog/legacy-progress';

const tmpRoots: string[] = [];
function makeRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qy-legacy-'));
  tmpRoots.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
});

interface MountOptions {
  files: Array<{ itemKey: string; relPath: string; size?: number; onDisk?: boolean }>;
}

/** Mount a source with the given files and return db + repo + sourceId. */
function mount(root: string, opts: MountOptions): { db: Database.Database; repo: CatalogRepository; sourceId: number } {
  const db = openDatabaseAtPath(join(root, 'qy-player.db'));
  const repo = createCatalogRepository(db);
  const sourceId = repo.createSource({ kind: 'local', name: 'Migrated', root });
  for (const f of opts.files) {
    const itemId = repo.upsertItem({ sourceId, sourceKey: f.itemKey, kind: 'movie', title: f.itemKey });
    if (f.onDisk !== false && f.size !== undefined) {
      writeFileSync(join(root, f.relPath), Buffer.alloc(f.size));
    }
    repo.upsertFile({ sourceId, itemId, relativePath: f.relPath, size: f.size });
  }
  return { db, repo, sourceId };
}

function seedLegacyRow(
  db: Database.Database,
  opts: { path: string; position: number; duration?: number; isFinished?: boolean; fileSize?: number; updatedAt: number }
): void {
  const result = db
    .prepare('INSERT INTO local_media (path, title, duration, file_size) VALUES (?, ?, ?, ?)')
    .run(opts.path, 'Legacy', opts.duration ?? null, opts.fileSize ?? null);
  const localId = Number(result.lastInsertRowid);
  db.prepare(
    `INSERT INTO playback_progress (media_type, local_media_id, position, duration, is_finished, updated_at)
     VALUES ('local', ?, ?, ?, ?, ?)`
  ).run(localId, opts.position, opts.duration ?? null, opts.isFinished ? 1 : 0, opts.updatedAt);
}

describe('legacy progress migration (ADR-0001 D4)', () => {
  it('migrates valid legacy progress into catalog_user_state', () => {
    const root = makeRoot();
    const { db, repo, sourceId } = mount(root, {
      files: [{ itemKey: 'movie.mkv', relPath: 'movie.mkv', size: 1000 }],
    });
    seedLegacyRow(db, {
      path: join(root, 'movie.mkv'),
      position: 600,
      duration: 7200,
      updatedAt: 1_700_000_000,
      fileSize: 1000,
    });
    const itemId = repo.listFilesBySource(sourceId)[0].item_id;

    const result = migrateLegacyProgressForSource(db, sourceId);
    expect(result.scanned).toBe(1);
    expect(result.matched).toBe(1);
    expect(result.migrated).toBe(1);

    const state = repo.getUserState(itemId)!;
    expect(state.position).toBe(600);
    expect(state.duration).toBe(7200);
    expect(state.is_finished).toBe(0);

    // Old tables are the rollback path and must stay untouched.
    expect((db.prepare('SELECT COUNT(*) AS n FROM playback_progress').get() as { n: number }).n).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS n FROM local_media').get() as { n: number }).n).toBe(1);
  });

  it('is idempotent: a second run changes nothing', () => {
    const root = makeRoot();
    const { db, repo, sourceId } = mount(root, {
      files: [{ itemKey: 'a.mkv', relPath: 'a.mkv' }],
    });
    seedLegacyRow(db, { path: join(root, 'a.mkv'), position: 120, updatedAt: 1_700_000_000 });
    const itemId = repo.listFilesBySource(sourceId)[0].item_id;

    const first = migrateLegacyProgressForSource(db, sourceId);
    const state = repo.getUserState(itemId)!;
    const second = migrateLegacyProgressForSource(db, sourceId);

    expect(first.migrated).toBe(1);
    expect(second.migrated).toBe(0);
    expect(second.matched).toBe(1);
    const stateAfter = repo.getUserState(itemId)!;
    expect(stateAfter.position).toBe(state.position);
    expect(stateAfter.updated_at).toBe(state.updated_at);
  });

  it('keeps the newer catalog state when legacy is older', () => {
    const root = makeRoot();
    const { db, repo, sourceId } = mount(root, {
      files: [{ itemKey: 'b.mkv', relPath: 'b.mkv' }],
    });
    const itemId = repo.listFilesBySource(sourceId)[0].item_id;
    repo.upsertUserState({ itemId, position: 900, duration: 7200 });
    seedLegacyRow(db, { path: join(root, 'b.mkv'), position: 60, updatedAt: 1 });

    const result = migrateLegacyProgressForSource(db, sourceId);
    expect(result.matched).toBe(1);
    expect(result.migrated).toBe(0);
    expect(result.skipped).toBe(1);
    expect(repo.getUserState(itemId)!.position).toBe(900);
  });

  it('applies legacy progress when it is strictly newer than catalog state', () => {
    const root = makeRoot();
    const { db, repo, sourceId } = mount(root, {
      files: [{ itemKey: 'c.mkv', relPath: 'c.mkv' }],
    });
    const itemId = repo.listFilesBySource(sourceId)[0].item_id;
    repo.upsertUserState({ itemId, position: 100, duration: 7200 });
    seedLegacyRow(db, { path: join(root, 'c.mkv'), position: 500, updatedAt: 9_000_000_000 });

    const result = migrateLegacyProgressForSource(db, sourceId);
    expect(result.migrated).toBe(1);
    expect(repo.getUserState(itemId)!.position).toBe(500);
  });

  it('skips invalid legacy rows (position 0, not finished)', () => {
    const root = makeRoot();
    const { db, repo, sourceId } = mount(root, {
      files: [{ itemKey: 'd.mkv', relPath: 'd.mkv' }],
    });
    const itemId = repo.listFilesBySource(sourceId)[0].item_id;
    seedLegacyRow(db, { path: join(root, 'd.mkv'), position: 0, updatedAt: 1_700_000_000 });

    const result = migrateLegacyProgressForSource(db, sourceId);
    expect(result.matched).toBe(1);
    expect(result.migrated).toBe(0);
    expect(result.skipped).toBe(1);
    expect(repo.getUserState(itemId)).toBeUndefined();
  });

  it('prefers the size-matching legacy row over a newer size-mismatched one', () => {
    const root = makeRoot();
    writeFileSync(join(root, 'e.mkv'), Buffer.alloc(2000));
    // Two legacy paths converging on the same file: the direct path and a
    // symlink recorded by the old app (both realpath to e.mkv).
    symlinkSync(join(root, 'e.mkv'), join(root, 'link.mkv'));
    const { db, repo, sourceId } = mount(root, {
      files: [{ itemKey: 'e.mkv', relPath: 'e.mkv', size: 2000 }],
    });
    const itemId = repo.listFilesBySource(sourceId)[0].item_id;
    // Older row with the right size vs newer row whose recorded size no
    // longer matches the on-disk file.
    seedLegacyRow(db, { path: join(root, 'e.mkv'), position: 333, updatedAt: 1, fileSize: 2000 });
    seedLegacyRow(db, { path: join(root, 'link.mkv'), position: 777, updatedAt: 2_000_000, fileSize: 999 });

    const result = migrateLegacyProgressForSource(db, sourceId);
    expect(result.migrated).toBe(1);
    expect(repo.getUserState(itemId)!.position).toBe(333);
  });

  it('migrates only the matched item without touching siblings', () => {
    const root = makeRoot();
    const { db, repo, sourceId } = mount(root, {
      files: [{ itemKey: 'show.mkv', relPath: 'show.mkv' }],
    });
    const withLegacy = repo.listFilesBySource(sourceId)[0].item_id;
    const otherId = repo.upsertItem({ sourceId, sourceKey: 'other.mkv', kind: 'movie', title: 'Other' });
    repo.upsertFile({ sourceId, itemId: otherId, relativePath: 'other.mkv' });

    seedLegacyRow(db, { path: join(root, 'show.mkv'), position: 400, updatedAt: 1_700_000_000 });
    migrateLegacyProgressForSource(db, sourceId);
    expect(repo.getUserState(withLegacy)!.position).toBe(400);
    expect(repo.getUserState(otherId)).toBeUndefined();
  });

  it('matches offline files by normalized path when realpath is impossible', () => {
    const root = makeRoot();
    const { db, repo, sourceId } = mount(root, {
      // onDisk: false -> file never existed, realpathSync cannot resolve
      files: [{ itemKey: 'gone.mkv', relPath: 'gone.mkv', onDisk: false }],
    });
    const itemId = repo.listFilesBySource(sourceId)[0].item_id;
    seedLegacyRow(db, { path: join(root, 'gone.mkv'), position: 250, updatedAt: 1_700_000_000 });

    const result = migrateLegacyProgressForSource(db, sourceId);
    expect(result.migrated).toBe(1);
    expect(repo.getUserState(itemId)!.position).toBe(250);
  });

  it('migrates finished rows even when position is 0', () => {
    const root = makeRoot();
    const { db, repo, sourceId } = mount(root, {
      files: [{ itemKey: 'f.mkv', relPath: 'f.mkv' }],
    });
    const itemId = repo.listFilesBySource(sourceId)[0].item_id;
    seedLegacyRow(db, {
      path: join(root, 'f.mkv'),
      position: 0,
      isFinished: true,
      updatedAt: 1_700_000_000,
    });

    const result = migrateLegacyProgressForSource(db, sourceId);
    expect(result.migrated).toBe(1);
    expect(repo.getUserState(itemId)!.is_finished).toBe(1);
  });

  it('keeps catalog state on an exact updated_at tie', () => {
    const root = makeRoot();
    const { db, repo, sourceId } = mount(root, {
      files: [{ itemKey: 'g.mkv', relPath: 'g.mkv' }],
    });
    const itemId = repo.listFilesBySource(sourceId)[0].item_id;
    const tieTime = 1_700_000_000;
    repo.upsertUserState({ itemId, position: 800, duration: 7200 });
    // Force the catalog row to the same unixepoch second as the legacy row.
    db.prepare('UPDATE catalog_user_state SET updated_at = ? WHERE item_id = ?').run(tieTime, itemId);
    seedLegacyRow(db, { path: join(root, 'g.mkv'), position: 50, updatedAt: tieTime });

    const result = migrateLegacyProgressForSource(db, sourceId);
    expect(result.migrated).toBe(0);
    expect(result.skipped).toBe(1);
    expect(repo.getUserState(itemId)!.position).toBe(800);
  });

  it('migrates one user state per item when an item has multiple files', () => {
    const root = makeRoot();
    const { db, repo, sourceId } = mount(root, {
      files: [
        { itemKey: 'multi-a', relPath: 'multi-a.mkv' },
        { itemKey: 'multi-b', relPath: 'multi-b.mkv' },
      ],
    });
    // Point both files at the same item (e.g. multi-part edition).
    const itemId = repo.listFilesBySource(sourceId)[0].item_id;
    const secondFile = repo.listFilesBySource(sourceId)[1].id;
    db.prepare('UPDATE catalog_files SET item_id = ? WHERE id = ?').run(itemId, secondFile);
    const link = join(root, 'multi-b.mkv');
    symlinkSync(join(root, 'multi-a.mkv'), link);
    seedLegacyRow(db, { path: join(root, 'multi-a.mkv'), position: 300, updatedAt: 1_700_000_000 });
    seedLegacyRow(db, { path: link, position: 310, updatedAt: 1_700_000_500 });

    const result = migrateLegacyProgressForSource(db, sourceId);
    expect(result.matched).toBe(1);
    expect(result.migrated).toBe(1);
    expect(result.skipped).toBe(1); // the alternate file match was consumed
    expect(repo.getUserState(itemId)!.position).toBe(300);
  });

  it('ignores non-local legacy rows entirely', () => {
    const root = makeRoot();
    const { db, repo, sourceId } = mount(root, {
      files: [{ itemKey: 'h.mkv', relPath: 'h.mkv' }],
    });
    // A server-side progress row must never enter the local migration scan.
    db.prepare(
      `INSERT INTO playback_progress (media_type, server_id, position, duration, is_finished, updated_at)
       VALUES ('jellyfin', 'server-1', 999, 7200, 0, 1_700_000_000)`
    ).run();

    const result = migrateLegacyProgressForSource(db, sourceId);
    expect(result.scanned).toBe(0);
    expect(result.matched).toBe(0);
    expect(repo.listFilesBySource(sourceId).length).toBe(1);
    expect(repo.getUserState(repo.listFilesBySource(sourceId)[0].item_id)).toBeUndefined();
  });

  it('never matches through paths escaping the source root', () => {
    const root = makeRoot();
    writeFileSync(join(root, 'outside.mkv'), Buffer.alloc(500));
    const { db, repo, sourceId } = mount(root, {
      files: [],
    });
    // Simulate corrupted scanner data: relative path escapes the root.
    const itemId = repo.upsertItem({ sourceId, sourceKey: 'escape', kind: 'movie', title: 'Escape' });
    repo.upsertFile({ sourceId, itemId, relativePath: '../outside.mkv' });
    seedLegacyRow(db, { path: join(root, 'outside.mkv'), position: 420, updatedAt: 1_700_000_000 });

    const result = migrateLegacyProgressForSource(db, sourceId);
    expect(result.matched).toBe(0);
    expect(result.skipped).toBe(1);
    expect(repo.getUserState(itemId)).toBeUndefined();
  });

  it('returns an empty result for an unknown source', () => {
    const root = makeRoot();
    const { db } = mount(root, { files: [] });
    const result = migrateLegacyProgressForSource(db, 99999);
    expect(result).toEqual({ scanned: 0, matched: 0, migrated: 0, skipped: 0 });
  });
});
