import { describe, expect, it } from 'vitest';
import {
  PROVIDER_PRIORITY,
  applyManualField,
  applyNfoMetadata,
  applyProviderFields,
  clearManualField,
  winnerFor,
} from '../../../src/main/modules/metadata/metadata-merger';
import type { NfoMetadata, ProviderStore } from '../../../src/main/modules/metadata/types';

function nfoMeta(partial: Partial<NfoMetadata>): NfoMetadata {
  return {
    kind: 'movie',
    genres: [],
    studios: [],
    countries: [],
    actors: [],
    directors: [],
    uniqueIds: [],
    thumbs: [],
    ...partial,
  };
}

function makeStore(fields: Array<{ field: string; provider: 'manual' | 'nfo' | 'scraper' | 'filename'; value: unknown; revision?: number }>): ProviderStore {
  const store: ProviderStore = {};
  for (const f of fields) {
    store[f.field] = {
      ...store[f.field],
      [f.provider]: { value: f.value, revision: f.revision ?? 1, updatedAt: 1_000 },
    };
  }
  return store;
}

describe('metadata merger', () => {
  it('orders providers manual > nfo > scraper > filename', () => {
    expect(PROVIDER_PRIORITY).toEqual(['manual', 'nfo', 'scraper', 'filename']);
  });

  it('applies NFO fields with nfo provenance and revision 1', () => {
    const outcome = applyNfoMetadata({}, nfoMeta({ title: '标题', year: 2019, genres: ['科幻'] }));
    expect(outcome.store.title!.nfo).toEqual({ value: '标题', revision: 1, updatedAt: outcome.store.title!.nfo!.updatedAt });
    expect(winnerFor(outcome.store, 'title')).toMatchObject({ provider: 'nfo', value: '标题' });
    expect(outcome.changedFields).toEqual(expect.arrayContaining(['title', 'year', 'genres']));
    expect(outcome.skippedLockedFields).toEqual([]);
  });

  it('keeps a higher-priority winner when a lower-priority provider writes', () => {
    // nfo outranks scraper; a scraper write never displaces an nfo winner.
    const store = makeStore([{ field: 'title', provider: 'scraper', value: '刮削标题' }]);
    const outcome = applyProviderFields(store, 'filename', { title: '文件名标题' });
    expect(outcome.store.title!.filename!.value).toBe('文件名标题');
    expect(winnerFor(outcome.store, 'title')!.provider).toBe('scraper');
  });

  it('winner falls through by priority: manual > nfo > scraper > filename', () => {
    const store = makeStore([
      { field: 'title', provider: 'filename', value: '文件名' },
      { field: 'plot', provider: 'nfo', value: '剧情' },
      { field: 'year', provider: 'manual', value: 2001 },
    ]);
    expect(winnerFor(store, 'title')!.provider).toBe('filename');
    expect(winnerFor(store, 'plot')!.provider).toBe('nfo');
    expect(winnerFor(store, 'year')!.provider).toBe('manual');
    expect(winnerFor(store, 'absent')).toBeNull();
  });

  it('re-applying an identical NFO does not bump revisions', () => {
    const meta = nfoMeta({ title: '标题', year: 2019 });
    const first = applyNfoMetadata({}, meta);
    const second = applyNfoMetadata(first.store, meta);
    expect(second.changedFields).toEqual([]);
    expect(second.store.title!.nfo!.revision).toBe(1);
  });

  it('a changed value bumps the revision in place', () => {
    const first = applyNfoMetadata({}, nfoMeta({ title: '旧' }));
    const second = applyNfoMetadata(first.store, nfoMeta({ title: '新' }));
    expect(second.changedFields).toEqual(['title']);
    expect(second.store.title!.nfo).toMatchObject({ value: '新', revision: 2 });
  });

  it('a partial NFO keeps previous fields (parse failure / sparse file semantics)', () => {
    const full = applyNfoMetadata({}, nfoMeta({ title: '标题', year: 2019, plot: '剧情' })).store;
    const outcome = applyNfoMetadata(full, nfoMeta({ title: '标题' }));
    expect(outcome.store.plot!.nfo!.value).toBe('剧情');
    expect(outcome.store.year!.nfo!.value).toBe(2019);
    expect(outcome.changedFields).toEqual([]);
  });

  it('locked (manual-winner) fields are skipped on re-scan, others still update', () => {
    let store = applyNfoMetadata({}, nfoMeta({ title: 'NFO标题', year: 2000 })).store;
    store = applyManualField(store, 'title', '人工标题').store;
    const outcome = applyNfoMetadata(store, nfoMeta({ title: 'NFO新标题', year: 2001 }));
    expect(outcome.skippedLockedFields).toEqual(['title']);
    expect(winnerFor(outcome.store, 'title')).toMatchObject({ provider: 'manual', value: '人工标题' });
    expect(outcome.store.title!.nfo!.value).toBe('NFO标题'); // untouched while locked
    expect(winnerFor(outcome.store, 'year')).toMatchObject({ provider: 'nfo', value: 2001 });
  });

  it('applyManualField with a stale revision throws and reports both sides', () => {
    const store = applyNfoMetadata({}, nfoMeta({ title: '原标题' })).store;
    const winner = winnerFor(store, 'title')!;
    expect(() => applyManualField(store, 'title', '手动', { expectedRevision: winner.revision + 5 })).toThrowError(
      expect.objectContaining({
        name: 'MetadataConflictError',
        current: expect.objectContaining({ provider: 'nfo', value: '原标题' }),
      })
    );
    // Matching revision applies the manual value.
    const ok = applyManualField(store, 'title', '手动', { expectedRevision: winner.revision });
    expect(winnerFor(ok.store, 'title')).toMatchObject({ provider: 'manual', value: '手动' });
    expect(ok.changedFields).toEqual(['title']);
  });

  it('manual slot revision is independent of the underlying provider slot', () => {
    let store = applyNfoMetadata({}, nfoMeta({ title: 'NFO' })).store;
    store = applyManualField(store, 'title', '手动1').store;
    store = applyManualField(store, 'title', '手动2').store;
    expect(store.title!.manual!.revision).toBe(2);
    expect(store.title!.nfo!.revision).toBe(1);
  });

  it('clearManualField restores the highest remaining provider', () => {
    let store = applyNfoMetadata({}, nfoMeta({ title: 'NFO标题', plot: 'NFO剧情' })).store;
    store = applyManualField(store, 'title', '人工标题').store;
    expect(winnerFor(store, 'title')!.provider).toBe('manual');
    store = clearManualField(store, 'title');
    expect(winnerFor(store, 'title')).toMatchObject({ provider: 'nfo', value: 'NFO标题' });
    // Removing a manual slot keeps its revision history intact.
    expect(store.title!.manual).toBeUndefined();
    expect(winnerFor(store, 'plot')!.provider).toBe('nfo');
  });

  it('expectedRevision 0 creates a new field optimistically', () => {
    const outcome = applyManualField({}, 'title', '新字段', { expectedRevision: 0 });
    expect(winnerFor(outcome.store, 'title')).toMatchObject({ provider: 'manual', value: '新字段', revision: 1 });
  });

  it('key order differences do not bump revisions', () => {
    const meta = nfoMeta({ actors: [{ name: '甲', role: '主角' }] });
    const first = applyNfoMetadata({}, meta);
    const reordered = nfoMeta({ actors: [{ role: '主角', name: '甲' }] });
    const second = applyNfoMetadata(first.store, reordered);
    expect(second.changedFields).toEqual([]);
  });

  it('null/empty values are ignored (no field erasure)', () => {
    const outcome = applyNfoMetadata({}, nfoMeta({ title: '', year: undefined }));
    expect(outcome.store.title).toBeUndefined();
    expect(outcome.store.year).toBeUndefined();
  });
});
