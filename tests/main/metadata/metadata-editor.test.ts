import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'fs';
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
let sourceDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'qy-meta-editor-'));
  dbPath = join(root, 'test.db');
  db = openDatabaseAtPath(dbPath);
  repo = createCatalogRepository(db);
  sourceId = repo.createSource({ kind: 'local', name: '库', root: '/media' });
  itemId = repo.upsertItem({ sourceId, sourceKey: 'movie-1', kind: 'movie', title: '原始标题' });
  sourceDir = join(root, 'source');
  mkdirSync(sourceDir, { recursive: true });
  // A scraped/NFO baseline the editor overrides and restores against.
  repo.upsertMetadataSource(itemId, 'title', 'nfo', 'NFO 标题');
  repo.upsertMetadataSource(itemId, 'year', 'nfo', 2019);
  repo.upsertMetadataSource(itemId, 'plot', 'filename', '文件名剧情');
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

/** Revision the editor would currently see for a field. */
function currentRevision(field: string): number {
  return winnerFor(loadItemStore(repo, itemId), field)?.revision ?? 0;
}

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
    saveManualEdits(repo, itemId, [{ field: 'title', value: '手工标题', expectedRevision: currentRevision('title') }]);
    expect(winnerFor(loadItemStore(repo, itemId), 'title')?.provider).toBe('manual');
    const result = saveManualEdits(repo, itemId, [{ field: 'title', value: null, expectedRevision: currentRevision('title') }]);
    expect(result.ok).toBe(true);
    const winner = winnerFor(loadItemStore(repo, itemId), 'title');
    expect(winner?.provider).toBe('nfo');
    expect(winner?.value).toBe('NFO 标题');
  });

  it('re-scan (NFO apply) never overwrites locked manual fields', () => {
    saveManualEdits(repo, itemId, [{ field: 'title', value: '手工标题', expectedRevision: currentRevision('title') }]);
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
      { field: 'title', value: '手工标题', expectedRevision: currentRevision('title') },
      { field: 'plot', value: '手工剧情', expectedRevision: currentRevision('plot') },
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

describe('item precheck and revision contract', () => {
  it('returns ITEM_NOT_FOUND for unknown items', () => {
    const result = saveManualEdits(repo, 999999, [{ field: 'title', value: 'x', expectedRevision: 0 }]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('ITEM_NOT_FOUND');
  });

  it('rejects patches without expectedRevision (no silent LWW)', () => {
    const result = saveManualEdits(repo, itemId, [
      { field: 'title', value: 'no revision' } as unknown as ManualPatch,
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('VALIDATION_FAILED');
    expect(winnerFor(loadItemStore(repo, itemId), 'title')?.provider).toBe('nfo');
  });

  it('treats a value identical to the current source winner as a no-op (no silent lock)', () => {
    const result = saveManualEdits(repo, itemId, [
      { field: 'title', value: 'NFO 标题', expectedRevision: currentRevision('title') },
    ]);
    if (!result.ok) throw new Error('save failed');
    expect(result.changed).toEqual([]);
    const winner = winnerFor(loadItemStore(repo, itemId), 'title');
    expect(winner?.provider).toBe('nfo'); // not locked to manual
  });
});

describe('loadItemStore tolerance branches', () => {
  it('skips unknown providers, null values and corrupt JSON while loading healthy rows', () => {
    repo.upsertMetadataSource(itemId, 'title', 'manual', '手工标题');
    // Raw rows with problematic shapes (bypassing the typed API).
    db.prepare(
      "INSERT INTO catalog_metadata_sources (item_id, field, provider, value, revision) VALUES (?, ?, ?, ?, 1)"
    ).run(itemId, 'mystery', 'unknown-provider', '"x"');
    db.prepare(
      "INSERT INTO catalog_metadata_sources (item_id, field, provider, value, revision) VALUES (?, ?, ?, NULL, 1)"
    ).run(itemId, 'empty', 'nfo');
    db.prepare(
      "INSERT INTO catalog_metadata_sources (item_id, field, provider, value, revision) VALUES (?, ?, ?, ?, 1)"
    ).run(itemId, 'broken', 'nfo', '{not-json');
    const store = loadItemStore(repo, itemId);
    expect(store.title?.manual?.value).toBe('手工标题');
    expect(store.mystery).toBeUndefined();
    expect(store.empty).toBeUndefined();
    expect(store.broken).toBeUndefined();
    // Healthy NFO rows still load.
    expect(store.year?.nfo?.value).toBe(2019);
  });
});

describe('validateEditableValue boundaries (§14.1)', () => {
  it('enforces every whitelist shape', () => {
    expect(validateEditableValue('title', 'ok')).toBeNull();
    expect(validateEditableValue('title', '')).toContain('非空文本');
    expect(validateEditableValue('title', 'x'.repeat(LIMITS.shortText + 1))).toBeTruthy();
    expect(validateEditableValue('plot', 'x'.repeat(LIMITS.longText + 1))).toBeTruthy();
    expect(validateEditableValue('premiered', '2019-01-01')).toBeNull();
    expect(validateEditableValue('premiered', '20190101')).toBeTruthy();
    expect(validateEditableValue('premiered', '2021-13-99')).toBeTruthy();
    expect(validateEditableValue('premiered', '2021-02-30')).toBeTruthy();
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
    saveManualEdits(repo, itemId, [{ field: 'title', value: '手工标题', expectedRevision: currentRevision('title') }]);
    const store = loadItemStore(repo, itemId);
    expect(store.title?.nfo?.value).toBe('NFO 标题');
    expect(store.title?.manual?.value).toBe('手工标题');
    expect((store.title?.manual?.revision ?? 0)).toBeGreaterThanOrEqual(1);
    // A second identical write is a no-op for revisions? The editor
    // writes only on change; same value + same revision still succeeds.
    const patches: ManualPatch[] = [{ field: 'title', value: '手工标题', expectedRevision: currentRevision('title') }];
    const again = saveManualEdits(repo, itemId, patches);
    expect(again.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// QYP2-023 wire contract + image import (review-required coverage)
// ---------------------------------------------------------------------------

import {
  describeItemFields,
  importItemImages,
  toEditorActionResult,
} from '../../../src/main/modules/metadata/editor-service';

describe('toEditorActionResult (wire contract)', () => {
  it('maps success to ok with changed/cleared', () => {
    const wire = toEditorActionResult(itemId, [{ field: 'title', value: '手工标题', expectedRevision: currentRevision('title') }], repo);
    expect(wire.ok).toBe(true);
    if (wire.ok) expect(wire.data?.changed).toEqual(['title']);
  });

  it('maps conflicts into error.details (never a false success)', () => {
    const store = loadItemStore(repo, itemId);
    const stale = (winnerFor(store, 'title')?.revision ?? 0) - 1;
    const wire = toEditorActionResult(itemId, [{ field: 'title', value: 'x', expectedRevision: stale }], repo);
    expect(wire.ok).toBe(false);
    if (wire.ok) return;
    expect(wire.error?.code).toBe('CONFLICT');
    const conflicts = (wire.error?.details as { conflicts?: Array<{ field: string }> }).conflicts;
    expect(conflicts?.[0].field).toBe('title');
  });

  it('maps validation and not-found failures to typed errors', () => {
    const bad = toEditorActionResult(itemId, [{ field: 'nope', value: 'x', expectedRevision: 0 }], repo);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error?.code).toBe('VALIDATION_FAILED');
    const missing = toEditorActionResult(999999, [{ field: 'title', value: 'x', expectedRevision: 0 }], repo);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error?.code).toBe('NOT_FOUND');
  });
});

describe('describeItemFields (GET payload)', () => {
  it('lists editable fields with winner provenance', () => {
    saveManualEdits(repo, itemId, [{ field: 'title', value: '手工标题', expectedRevision: currentRevision('title') }]);
    const fields = describeItemFields(repo, itemId);
    const title = fields.find((f) => f.field === 'title');
    expect(title?.winner).toMatchObject({ provider: 'manual', value: '手工标题' });
    // Provenance keeps the NFO slot visible alongside the manual winner.
    expect(title?.providers.some((p) => p.provider === 'nfo')).toBe(true);
    // Whitelist fields appear even without values.
    expect(fields.find((f) => f.field === 'premiered')).toBeDefined();
  });
});

describe('importItemImages (§14.1 managed image cache)', () => {
  let imagesRoot: string;
  beforeEach(() => {
    imagesRoot = join(root, 'images');
    mkdirSync(imagesRoot, { recursive: true });
  });

  it('copies poster/fanart into the managed dir and records manual slots', () => {
    const poster = join(sourceDir, 'poster.jpg');
    writeFileSync(poster, 'fake-jpeg');
    const result = importItemImages(repo, itemId, imagesRoot, [{ kind: 'poster', sourcePath: poster }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.imported[0].managedPath).toContain(join('images', String(itemId)));
    expect(winnerFor(loadItemStore(repo, itemId), 'poster')?.provider).toBe('manual');
    // The temp file was renamed away (no .tmp- leftovers).
    const dirFiles = readdirSync(join(imagesRoot, String(itemId)));
    expect(dirFiles.every((f) => !f.startsWith('.tmp-'))).toBe(true);
  });

  it('rejects non-image extensions, oversize files and unknown items', () => {
    const text = join(sourceDir, 'not-image.txt');
    writeFileSync(text, 'x');
    const badExt = importItemImages(repo, itemId, imagesRoot, [{ kind: 'poster', sourcePath: text }]);
    expect(badExt.ok).toBe(false);

    const huge = join(sourceDir, 'big.png');
    writeFileSync(huge, Buffer.alloc(21 * 1024 * 1024, 0x61));
    const oversize = importItemImages(repo, itemId, imagesRoot, [{ kind: 'poster', sourcePath: huge }]);
    expect(oversize.ok).toBe(false);

    const missing = importItemImages(repo, 999999, imagesRoot, [{ kind: 'poster', sourcePath: text }]);
    expect(missing.ok).toBe(false);
  });

  it('deletes the managed file when the DB write fails (no orphans)', () => {
    const poster = join(sourceDir, 'poster.jpg');
    writeFileSync(poster, 'fake-jpeg');
    // A repo whose upsert throws simulates a DB failure after the copy.
    const failingRepo = {
      ...repo,
      upsertMetadataSource: () => {
        throw new Error('db down');
      },
    };
    const result = importItemImages(failingRepo, itemId, imagesRoot, [{ kind: 'poster', sourcePath: poster }]);
    expect(result.ok).toBe(false);
    const dirFiles = readdirSync(imagesRoot, { recursive: true });
    expect(dirFiles.every((f) => !f.includes('poster-'))).toBe(true);
  });
});
