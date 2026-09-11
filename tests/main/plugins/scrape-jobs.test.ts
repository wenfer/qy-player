import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTO_APPLY_THRESHOLD,
  CONFIRM_THRESHOLD,
  matchCandidates,
  scoreCandidate,
  similarity,
} from '../../../src/main/modules/plugin-runtime/matcher';
import { ScrapeCache } from '../../../src/main/modules/plugin-runtime/cache';
import { validateMetadataPayload } from '../../../src/main/modules/metadata/metadata-merger';
import { ScrapeJobService, type ScrapeJobDeps } from '../../../src/main/modules/plugin-runtime/job-service';
import type { MetadataCandidate } from '../../../src/shared/types/plugins';

// ---------------------------------------------------------------------------
// matcher (table-driven, §11.2)
// ---------------------------------------------------------------------------

describe('matcher scoring (table-driven)', () => {
  const cases: Array<{
    name: string;
    query: { title: string; originalTitle?: string; year?: number };
    candidate: MetadataCandidate;
    min?: number;
    max?: number;
  }> = [
    { name: 'identical titles', query: { title: '流浪地球' }, candidate: { id: '1', title: '流浪地球', score: 0 }, min: 0.99 },
    { name: 'punctuation/case ignored', query: { title: 'The, Matrix!' }, candidate: { id: '1', title: 'the matrix', score: 0 }, min: 0.99 },
    { name: 'original title cross-match', query: { title: '流浪地球', originalTitle: 'The Wandering Earth' }, candidate: { id: '1', title: 'The Wandering Earth', score: 0 }, min: 0.99 },
    { name: 'totally different', query: { title: '流浪地球' }, candidate: { id: '1', title: 'Chicago', score: 0 }, max: 0.3 },
    { name: 'exact year boosts', query: { title: '上游', year: 2019 }, candidate: { id: '1', title: '上游', year: 2019, score: 0 }, min: 0.99 },
    { name: 'year off-by-one still strong', query: { title: '上游', year: 2019 }, candidate: { id: '1', title: '上游', year: 2020, score: 0 }, min: 0.9 },
    { name: 'year far off drags down', query: { title: '上游', year: 2019 }, candidate: { id: '1', title: '上游', year: 2010, score: 0 }, max: 0.7 },
    { name: 'no year caps the score at 0.9', query: { title: '上游' }, candidate: { id: '1', title: '上游', year: 2019, score: 0 }, max: 0.9 },
  ];

  for (const entry of cases) {
    it(entry.name, () => {
      const score = scoreCandidate(entry.query, entry.candidate);
      expect(score).toBeGreaterThanOrEqual(entry.min ?? 0);
      if (entry.max !== undefined) expect(score).toBeLessThanOrEqual(entry.max);
      expect(score).toBeLessThanOrEqual(1);
    });
  }

  it('similarity is 1 for identical, 0 for empty', () => {
    expect(similarity('abc', 'abc')).toBe(1);
    expect(similarity('', 'abc')).toBe(0);
  });
});

describe('match verdicts (§11.2 thresholds)', () => {
  const query = { title: '流浪地球', year: 2019 };

  it('unique candidate ≥0.92 auto-applies', () => {
    const result = matchCandidates(query, [{ id: '1', title: '流浪地球', year: 2019, score: 0 }]);
    expect(result.verdict).toBe('auto');
    expect(result.autoCandidate?.id).toBe('1');
  });

  it('two strong candidates are ambiguous → confirm (no blind auto)', () => {
    const result = matchCandidates(query, [
      { id: '1', title: '流浪地球', year: 2019, score: 0 },
      { id: '2', title: '流浪地球', originalTitle: 'The Wandering Earth', year: 2019, score: 0 },
    ]);
    expect(result.verdict).toBe('confirm');
    expect(result.confirmCandidates).toHaveLength(2);
  });

  it('0.75–0.92 lands in the confirm queue', () => {
    const result = matchCandidates(query, [{ id: '1', title: '流浪地球2', year: 2019, score: 0 }]);
    expect(result.verdict).toBe('confirm');
    expect(result.confirmCandidates).toHaveLength(1);
  });

  it('<0.75 is rejected outright', () => {
    const result = matchCandidates(query, [{ id: '1', title: 'Chicago', score: 0 }]);
    expect(result.verdict).toBe('rejected');
  });

  it('thresholds are the documented constants', () => {
    expect(AUTO_APPLY_THRESHOLD).toBe(0.92);
    expect(CONFIRM_THRESHOLD).toBe(0.75);
  });
});

// ---------------------------------------------------------------------------
// payload schema validation (§11.1 deferred item, landed here)
// ---------------------------------------------------------------------------

const VALID_PAYLOAD = {
  kind: 'movie' as const,
  title: '流浪地球',
  year: 2019,
  genres: ['科幻'],
  studios: [] as string[],
  countries: [] as string[],
  directors: [] as string[],
  actors: [{ name: '吴京' }],
  uniqueIds: [{ provider: 'tmdb', id: '123' }],
  thumbs: [] as string[],
};

describe('validateMetadataPayload', () => {
  it('accepts a well-formed payload', () => {
    expect(validateMetadataPayload(VALID_PAYLOAD)).toEqual([]);
  });
  it('rejects non-objects', () => {
    expect(validateMetadataPayload('nope').length).toBeGreaterThan(0);
  });
  it('rejects wrong kinds and wrong-typed fields', () => {
    expect(validateMetadataPayload({ ...VALID_PAYLOAD, kind: 'weird' }).some((p) => p.includes('kind'))).toBe(true);
    expect(validateMetadataPayload({ ...VALID_PAYLOAD, year: '2019' }).some((p) => p.includes('year'))).toBe(true);
    expect(validateMetadataPayload({ ...VALID_PAYLOAD, rating: 42 }).some((p) => p.includes('rating'))).toBe(true);
    expect(validateMetadataPayload({ ...VALID_PAYLOAD, genres: '科幻' }).some((p) => p.includes('genres'))).toBe(true);
    expect(validateMetadataPayload({ ...VALID_PAYLOAD, actors: [{}] }).some((p) => p.includes('actors'))).toBe(true);
    expect(validateMetadataPayload({ ...VALID_PAYLOAD, uniqueIds: [{ provider: 'x' }] }).some((p) => p.includes('uniqueIds'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// cache (bounded disk cache)
// ---------------------------------------------------------------------------

describe('ScrapeCache', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qy-scrape-cache-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips values and isolates namespaces', () => {
    const cache = new ScrapeCache({ dir });
    cache.set('tmdb', 'search', 'k1', [{ id: '1' }]);
    expect(cache.get<unknown[]>('tmdb', 'search', 'k1')).toEqual([{ id: '1' }]);
    expect(cache.get('douban', 'search', 'k1')).toBeUndefined();
    cache.delete('tmdb', 'search', 'k1');
    expect(cache.get('tmdb', 'search', 'k1')).toBeUndefined();
  });

  it('honours TTL expiry', async () => {
    let clock = 1_000_000;
    const cache = new ScrapeCache({ dir, defaultTtlMs: 1000, now: () => clock });
    cache.set('tmdb', 'search', 'k', 'v');
    expect(cache.get('tmdb', 'search', 'k')).toBe('v');
    clock += 2000;
    expect(cache.get('tmdb', 'search', 'k')).toBeUndefined();
  });

  it('evicts LRU beyond the quota', async () => {
    const cache = new ScrapeCache({ dir, maxEntries: 3 });
    for (let i = 0; i < 5; i += 1) {
      cache.set('tmdb', 'search', `k${i}`, i);
      // Real-time spacing gives each write a distinct mtime (LRU order).
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(cache.size).toBe(3);
    // Oldest keys evicted.
    expect(cache.get('tmdb', 'search', 'k0')).toBeUndefined();
    expect(cache.get('tmdb', 'search', 'k1')).toBeUndefined();
    expect(cache.get('tmdb', 'search', 'k4')).toBeDefined();
  });

  it('secret values never appear in cache filenames', () => {
    const name = ScrapeCache.keyFor('tmdb', 'search', 'user-query with 假名 & /slashes');
    expect(name).toMatch(/^[0-9a-f]{40}$/);
  });
});

// ---------------------------------------------------------------------------
// job service (single/batch, cancel, resume, failure isolation, locks)
// ---------------------------------------------------------------------------

function makeDeps(over: {
  search?: ScrapeJobDeps['runSearch'];
  details?: ScrapeJobDeps['runDetails'];
  concurrency?: number;
} = {}): {
  deps: ScrapeJobDeps;
  kv: Map<string, string>;
  repoData: {
    items: Map<number, { kind: string; title: string }>;
  };
} {
  const kv = new Map<string, string>();
  const items = new Map<number, { kind: string; title: string }>();
  items.set(1, { kind: 'movie', title: '流浪地球' });
  items.set(2, { kind: 'movie', title: '第二部电影' });
  items.set(3, { kind: 'movie', title: '第三部电影' });
  items.set(4, { kind: 'movie', title: '第四部电影' });
  // Pre-seeded rows are JSON-encoded exactly like the real repo writes them.
  const metadataRows: Array<{ item_id: number; field: string; provider: string; value: string | null; revision: number }> = [
    { item_id: 1, field: 'year', provider: 'nfo', value: '2019', revision: 1 },
    { item_id: 1, field: 'title', provider: 'manual', value: JSON.stringify('锁定标题'), revision: 1 },
  ];
  const deps: ScrapeJobDeps = {
    repo: {
      getItem: (id) => {
        const item = items.get(id);
        return item ? { id, ...item, source_id: 1 } : undefined;
      },
      listMetadataSources: (id) => metadataRows.filter((row) => row.item_id === id),
      upsertMetadataSource: (id, field, provider, value) => {
        const existing = metadataRows.findIndex((row) => row.item_id === id && row.field === field && row.provider === provider);
        const valueJson = JSON.stringify(value);
        if (existing >= 0) {
          metadataRows[existing] = { ...metadataRows[existing], value: valueJson, revision: metadataRows[existing].revision + 1 };
        } else {
          metadataRows.push({ item_id: id, field, provider, value: valueJson, revision: 1 });
        }
      },
    },
    kv,
    cacheDir: join(tmpdir(), `qy-jobs-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`),
    runSearch:
      over.search ??
      (async (_plugin, query) => [
        { id: 'tmdb-1', title: query.title, year: query.year, score: 0 },
      ]),
    runDetails:
      over.details ??
      (async () => ({ ...VALID_PAYLOAD, title: '插件标题' })),
    concurrency: over.concurrency,
  };
  return { deps, kv, repoData: { items } };
}

describe('ScrapeJobService (§11.2)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qy-jobs-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('auto-applies a unique ≥0.92 candidate (respects manual locks)', async () => {
    // plot 不在条目已有行中：scraper 应新增；title 被手工锁定：应跳过。
    const { deps } = makeDeps({
      details: async () => ({ ...VALID_PAYLOAD, title: '插件标题', plot: '插件剧情' }),
    });
    const service = new ScrapeJobService(deps);
    const { jobId } = await service.startJob('tmdb', [1]);
    await vi.waitFor(() => expect(service.getJob(jobId)?.status === 'completed').toBe(true));
    const record = service.getJob(jobId);
    expect(record?.items[0].status).toBe('applied');
    // Manual-locked title untouched; unlocked new fields applied.
    const titleRows = deps.repo.listMetadataSources(1).filter((r) => r.field === 'title');
    expect(titleRows.some((r) => r.provider === 'scraper')).toBe(false);
    expect(titleRows.find((r) => r.provider === 'manual')?.value).toContain('锁定标题');
    const plotRows = deps.repo.listMetadataSources(1).filter((r) => r.field === 'plot' && r.provider === 'scraper');
    expect(plotRows).toHaveLength(1);
  });

  it('confirm queue for 0.75–0.92 with candidates attached', async () => {
    const { deps } = makeDeps({
      search: async () => [{ id: 'c1', title: '第二部电影2', year: 2020, score: 0 }],
    });
    const service = new ScrapeJobService(deps);
    const { jobId } = await service.startJob('tmdb', [2]);
    await vi.waitFor(() => expect(service.getJob(jobId)?.status === 'completed').toBe(true));
    const item = service.getJob(jobId)?.items[0];
    expect(item?.status).toBe('confirm');
    expect(item?.candidates?.length).toBeGreaterThan(0);
    // Nothing written for confirm items.
    expect(deps.repo.listMetadataSources(2).filter((r) => r.provider === 'scraper')).toHaveLength(0);
  });

  it('rejects <0.75 without writing', async () => {
    const { deps } = makeDeps({
      search: async () => [{ id: 'x', title: '完全不同', score: 0 }],
    });
    const service = new ScrapeJobService(deps);
    const { jobId } = await service.startJob('tmdb', [3]);
    await vi.waitFor(() => expect(service.getJob(jobId)?.status === 'completed').toBe(true));
    expect(service.getJob(jobId)?.items[0].status).toBe('rejected');
    expect(deps.repo.listMetadataSources(3).filter((r) => r.provider === 'scraper')).toHaveLength(0);
  });

  it('search failures (429) mark the item failed without overwriting values', async () => {
    const rateLimited = Object.assign(new Error('429'), { code: 'RATE_LIMITED' });
    const { deps } = makeDeps({ search: async () => Promise.reject(rateLimited) });
    const service = new ScrapeJobService(deps);
    const { jobId } = await service.startJob('tmdb', [1]);
    await vi.waitFor(() => expect(service.getJob(jobId)?.status === 'completed').toBe(true));
    const item = service.getJob(jobId)?.items[0];
    expect(item?.status).toBe('failed');
    expect(item?.message).toContain('限流');
    // Manual/NFO values intact.
    expect(deps.repo.listMetadataSources(1).find((r) => r.field === 'title' && r.provider === 'manual')).toBeDefined();
  });

  it('invalid plugin payloads fail validation, never touch the store', async () => {
    const { deps } = makeDeps({
      details: async () => ({ ...VALID_PAYLOAD, year: '2019' as unknown as number }),
    });
    const service = new ScrapeJobService(deps);
    const { jobId } = await service.startJob('tmdb', [1]);
    await vi.waitFor(() => expect(service.getJob(jobId)?.status === 'completed').toBe(true));
    expect(service.getJob(jobId)?.items[0].status).toBe('failed');
    expect(deps.repo.listMetadataSources(1).filter((r) => r.provider === 'scraper')).toHaveLength(0);
  });

  it('cancellation stops the queue; applied items persist; resume continues', async () => {
    const slowSearch = async (_plugin: string, query: { title: string }) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return [{ id: `id-${query.title}`, title: query.title, score: 0 }];
    };
    const { deps } = makeDeps({ search: slowSearch });
    const service = new ScrapeJobService(deps);
    const { jobId } = await service.startJob('tmdb', [1, 2, 3, 4]);
    service.cancelJob(jobId);
    await vi.waitFor(() => expect(['cancelled', 'completed']).toContain(service.getJob(jobId)?.status));
    const cancelled = service.getJob(jobId);
    expect(cancelled?.status).toBe('cancelled');
    const applied = cancelled?.items.filter((i) => i.status === 'applied') ?? [];
    // Applied items persist (resume skips them).
    const resumed = await service.startJob('tmdb', [1, 2, 3, 4], jobId);
    await vi.waitFor(() => expect(service.getJob(resumed.jobId)?.status === 'completed').toBe(true));
    const final = service.getJob(resumed.jobId);
    // Every item ends accounted for exactly once.
    const ids = (final?.items ?? []).map((i) => i.itemId).sort();
    expect(ids).toEqual([1, 2, 3, 4]);
    expect(applied.every((i) => (final?.items ?? []).some((f) => f.itemId === i.itemId))).toBe(true);
  });

  it('runs with bounded concurrency (≤2)', async () => {
    let inFlight = 0;
    let peak = 0;
    const { deps } = makeDeps({
      search: async (_plugin, query) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 20));
        inFlight -= 1;
        return [{ id: `id-${query.title}`, title: query.title, score: 0 }];
      },
      concurrency: 2,
    });
    const service = new ScrapeJobService(deps);
    const { jobId } = await service.startJob('tmdb', [1, 2, 3, 4]);
    await vi.waitFor(() => expect(service.getJob(jobId)?.status === 'completed').toBe(true));
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('interrupts running jobs on construction (recovery flag)', async () => {
    const { deps, kv } = makeDeps();
    kv.set(
      'scrape.job',
      JSON.stringify({
        'scrape-old': {
          id: 'scrape-old',
          status: 'running',
          createdAt: 1,
          updatedAt: 2,
          items: [],
          pending: [4],
          pluginId: 'tmdb',
        },
      })
    );
    new ScrapeJobService(deps);
    const record = JSON.parse(kv.get('scrape.job') as string) as Record<string, { status: string }>;
    expect(record['scrape-old'].status).toBe('interrupted');
  });
});
