import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabaseAtPath } from '../../../src/main/modules/storage/db';
import { createCatalogRepository, type CatalogRepository } from '../../../src/main/modules/catalog/repository';
import { applyNfoMetadata, winnerFor } from '../../../src/main/modules/metadata/metadata-merger';
import {
  EDITABLE_FIELDS,
  LIMITS,
  loadItemStore,
  restoreManualFields,
  saveManualEdits,
  validateEditableValue,
  type ManualPatch,
} from '../../../src/main/modules/metadata/editor-service';

let root: string;
let dbPath: string;
let db: ReturnType<typeof openDatabaseAtPath>;
let repo: CatalogRepository;
let sourceId: number;
let itemId: number;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'qy-meta-editor-'));
  dbPath = join(root, 'test.db');
  db = openDatabaseAtPath(dbPath);
  repo = createCatalogRepository(db);
  sourceId = repo.createSource({ kind: 'local', name: '库', root: '/media' });
  itemId = repo.upsertItem({ sourceId, sourceKey: 'movie-1', kind: 'movie', title: '原始标题' });
  // A scraped/NFO baseline the editor overrides and restores against.
  repo.upsertMetadataSource(itemId, 'title', 'nfo', 'NFO 标题');
  repo.upsertMetadataSource(itemId, 'year', 'nfo', 2019);
  repo.upsertMetadataSource(itemId, 'plot', 'filename', '文件名剧情');
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('saveManualEdits (QYP2-022)', () => {
  it('writes a manual slot that becomes the winner', () => {
    const store = loadItemStore(repo, itemId);
    const result = saveManualEdits(repo, itemId, [
      { field: 'title', value: '手工标题', expectedRevision: winnerFor(store, 'title')?.revision ?? 0 },
    ]);
    expect(result.ok).toBe(true);
    const after = loadItemStore(repo, itemId);
    const winner = winnerFor(after, 'title');
    expect(winner?.provider).toBe('manual');
    expect(winner?.value).toBe('手工标题');
    // The NFO slot survives underneath (restore can bring it back).
    expect(after.title?.nfo?.value).toBe('NFO 标题');
  });

  it('rejects non-whitelisted fields and invalid shapes without writing', () => {
    const before = loadItemStore(repo, itemId);
    const bad = saveManualEdits(repo, itemId, [{ field: 'notAField', value: 'x' }]);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe('VALIDATION_FAILED');

    const badYear = saveManualEdits(repo, itemId, [{ field: 'year', value: 1800 }]);
    expect(badYear.ok).toBe(false);

    const badRating = saveManualEdits(repo, itemId, [{ field: 'rating', value: 12 }]);
    expect(badRating.ok).toBe(false);

    const badList = saveManualEdits(repo, itemId, [{ field: 'genres', value: '科幻' as unknown as string[] }]);
    expect(badList.ok).toBe(false);

    // Nothing was written.
    expect(loadItemStore(repo, itemId).title).toEqual(before.title);
  });

  it('returns per-field conflict diffs on stale revisions', () => {
    const store = loadItemStore(repo, itemId);
    const stale = (winnerFor(store, 'title')?.revision ?? 0) - 1;
    const result = saveManualEdits(repo, itemId, [
      { field: 'title', value: '过期编辑', expectedRevision: stale },
      { field: 'plot', value: '并行的另一处编辑', expectedRevision: winnerFor(store, 'plot')?.revision ?? 0 },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('CONFLICT');
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts?.[0].field).toBe('title');
    // Diff carries the current winner for UI rendering.
    expect(result.conflicts?.[0].current).toMatchObject({ provider: 'nfo', value: 'NFO 标题' });
    // The valid field in the same batch was NOT applied (batch is atomic
    // under conflict; retry semantics belong to the UI).
    expect(winnerFor(loadItemStore(repo, itemId), 'plot')?.value).toBe('文件名剧情');
  });

  it('null value restores the source winner (manual row deleted)', () => {
    saveManualEdits(repo, itemId, [{ field: 'title', value: '手工标题' }]);
    expect(winnerFor(loadItemStore(repo, itemId), 'title')?.provider).toBe('manual');
    const result = saveManualEdits(repo, itemId, [{ field: 'title', value: null }]);
    expect(result.ok).toBe(true);
    const winner = winnerFor(loadItemStore(repo, itemId), 'title');
    expect(winner?.provider).toBe('nfo');
    expect(winner?.value).toBe('NFO 标题');
  });

  it('re-scan (NFO apply) never overwrites locked manual fields', () => {
    saveManualEdits(repo, itemId, [{ field: 'title', value: '手工标题' }]);
    // Simulate a re-scan arriving with fresh NFO values.
    const store = loadItemStore(repo, itemId);
    const outcome = applyNfoMetadata(store, {
      kind: 'movie',
      title: '重新扫描的标题',
      genres: [],
      studios: [],
      countries: [],
      actors: [],
      directors: [],
      uniqueIds: [],
      thumbs: [],
    });
    // Locked and reported, not applied.
    expect(outcome.skippedLockedFields).toContain('title');
    expect(winnerFor(outcome.store, 'title')?.value).toBe('手工标题');
    // Unlocked fields still flow through.
    expect(winnerFor(outcome.store, 'runtime')?.value).toBeUndefined();
  });

  it('restoreManualFields clears one field or all manual overrides', () => {
    saveManualEdits(repo, itemId, [
      { field: 'title', value: '手工标题' },
      { field: 'plot', value: '手工剧情' },
    ]);
    const single = restoreManualFields(repo, itemId, ['title']);
    expect(single.cleared).toEqual(['title']);
    expect(winnerFor(loadItemStore(repo, itemId), 'title')?.provider).toBe('nfo');
    expect(winnerFor(loadItemStore(repo, itemId), 'plot')?.provider).toBe('manual');

    const all = restoreManualFields(repo, itemId);
    expect(all.cleared).toEqual(['plot']); // title's manual row was already restored above
    expect(winnerFor(loadItemStore(repo, itemId), 'plot')?.provider).toBe('filename');
  });

  it('restore ignores fields without manual rows', () => {
    const result = restoreManualFields(repo, itemId, ['title']);
    expect(result.cleared).toEqual([]);
  });
});

describe('validateEditableValue boundaries (§14.1)', () => {
  it('enforces every whitelist shape', () => {
    expect(validateEditableValue('title', 'ok')).toBeNull();
    expect(validateEditableValue('title', '')).toMatchObject({});
    expect(validateEditableValue('title', 'x'.repeat(LIMITS.shortText + 1))).toBeTruthy();
    expect(validateEditableValue('plot', 'x'.repeat(LIMITS.longText + 1))).toBeTruthy();
    expect(validateEditableValue('premiered', '2019-01-01')).toBeNull();
    expect(validateEditableValue('premiered', '20190101')).toBeTruthy();
    expect(validateEditableValue('year', 2024)).toBeNull();
    expect(validateEditableValue('year', 2024.5)).toBeTruthy();
    expect(validateEditableValue('season', 0)).toBeNull();
    expect(validateEditableValue('season', -1)).toBeTruthy();
    expect(validateEditableValue('genres', ['科幻', '灾难'])).toBeNull();
    expect(validateEditableValue('genres', ['x'.repeat(LIMITS.itemLength + 1)])).toBeTruthy();
    expect(
      validateEditableValue('actors', [{ name: '吴京', role: '刘培强' }])
    ).toBeNull();
    expect(validateEditableValue('actors', [{ name: '' }])).toBeTruthy();
    expect(
      validateEditableValue('uniqueIds', [{ provider: 'tmdb', id: '12345' }])
    ).toBeNull();
    expect(validateEditableValue('uniqueIds', [{ provider: 'tmdb', id: '' }])).toBeTruthy();
  });

  it('whitelist is closed: unknown fields fail', () => {
    expect(EDITABLE_FIELDS['sortTitle']).toBeDefined();
    expect(validateEditableValue('thumb', 'http://x')).toBeTruthy();
  });
});

describe('store round-trip (loadItemStore)', () => {
  it('rebuilds revisions and providers from DB rows', () => {
    saveManualEdits(repo, itemId, [{ field: 'title', value: '手工标题' }]);
    const store = loadItemStore(repo, itemId);
    expect(store.title?.nfo?.value).toBe('NFO 标题');
    expect(store.title?.manual?.value).toBe('手工标题');
    expect((store.title?.manual?.revision ?? 0)).toBeGreaterThanOrEqual(1);
    // A second identical write is a no-op for revisions? The editor
    // writes only on change; same value + same revision still succeeds.
    const patches: ManualPatch[] = [{ field: 'title', value: '手工标题' }];
    const again = saveManualEdits(repo, itemId, patches);
    expect(again.ok).toBe(true);
  });
});
