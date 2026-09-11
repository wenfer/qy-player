import { mkdtempSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildDoubanPlugin } from '../../../src/main/plugins/douban';
import { DOUBAN_MIN_INTERVAL_MS, resetDoubanThrottleForTests } from '../../../src/main/plugins/douban/client';
import { PluginError, type MetadataCandidate, type PluginContext } from '../../../src/shared/types/plugins';
import { validateMetadataPayload } from '../../../src/main/modules/metadata/metadata-merger';
import { ScrapeJobService, type ScrapeJobDeps } from '../../../src/main/modules/plugin-runtime/job-service';

/**
 * QYP2-031 豆瓣插件安全降级测试（fixture 覆盖：正常、空、限流、结构变化）。
 * 真实网络访问属「获准环境单项手工测试」，列入人工验证清单。
 */

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/douban');
const SUGGEST_FIXTURE = JSON.parse(readFileSync(join(FIXTURE_DIR, 'subject-suggest.json'), 'utf8'));
const DETAIL_HTML = readFileSync(join(FIXTURE_DIR, 'subject-detail.html'), 'utf8');
const DETAIL_TV_HTML = readFileSync(join(FIXTURE_DIR, 'subject-detail-tv.html'), 'utf8');

function makeContext(responses: Map<string, { status: number; body: string }>) {
  const requests: Array<{ url: string; headers: Record<string, string>; query: Record<string, unknown> }> = [];
  const cacheStore = new Map<string, unknown>();
  const context: PluginContext = {
    pluginId: 'douban',
    locale: 'zh-CN',
    appVersion: 'test',
    http: {
      allowHosts: vi.fn(),
      request: async (req) => {
        const url = new URL(req.url);
        for (const [key, value] of Object.entries(req.query ?? {})) {
          if (value !== undefined) url.searchParams.set(key, String(value));
        }
        requests.push({ url: url.toString(), headers: req.headers ?? {}, query: req.query ?? {} });
        const res = responses.get(`${url.pathname}?q=${url.searchParams.get('q') ?? ''}`);
        if (!res) return { status: 404, headers: {}, body: Buffer.from('not found') };
        return { status: res.status, headers: {}, body: Buffer.from(res.body) };
      },
    },
    cache: {
      get: <T>(key: string) => cacheStore.get(key) as T | undefined,
      set: (key: string, value: unknown) => void cacheStore.set(key, value),
      delete: (key: string) => void cacheStore.delete(key),
      clear: () => void cacheStore.clear(),
    },
    secrets: { get: () => null, has: () => false },
  };
  return { context, requests, cacheStore };
}

/** 压缩自限速（10ms），并保留节流语义可测。 */
const PLUGIN_OPTIONS = { minIntervalMs: 10, sleep: (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)) };

beforeEach(() => {
  vi.clearAllMocks();
  resetDoubanThrottleForTests();
});

describe('douban plugin safe degradation (QYP2-031)', () => {
  it('search returns candidates from subject_suggest (正常)', async () => {
    const plugin = buildDoubanPlugin(PLUGIN_OPTIONS);
    const ctx = makeContext(new Map([['/j/subject_suggest?q=示例电影', { status: 200, body: JSON.stringify(SUGGEST_FIXTURE) }]]));
    const candidates = await plugin.search({ query: '示例电影', kind: 'movie' }, ctx.context);
    // kind=movie 过滤掉 fixture 里的 tv 条目
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatchObject({ id: '25457203', title: '示例电影', year: 2023, originalTitle: 'A Sample Movie' });
  });

  it('empty suggest result is a legal [] — matcher keeps existing metadata', async () => {
    const plugin = buildDoubanPlugin(PLUGIN_OPTIONS);
    const ctx = makeContext(new Map([['/j/subject_suggest?q=不存在', { status: 200, body: '[]' }]]));
    const candidates = await plugin.search({ query: '不存在' }, ctx.context);
    expect(candidates).toEqual([]);
  });

  it('429 → RATE_LIMITED; other non-200 → NETWORK_ERROR; 404 → NOT_FOUND', async () => {
    const plugin = buildDoubanPlugin(PLUGIN_OPTIONS);
    const rateCtx = makeContext(new Map([['/j/subject_suggest?q=x', { status: 429, body: '{}' }]]));
    await expect(plugin.search({ query: 'x' }, rateCtx.context)).rejects.toMatchObject({ code: 'RATE_LIMITED' });

    const errCtx = makeContext(new Map([['/j/subject_suggest?q=x', { status: 503, body: 'oops' }]]));
    await expect(plugin.search({ query: 'x' }, errCtx.context)).rejects.toMatchObject({ code: 'NETWORK_ERROR' });

    const detailCtx = makeContext(new Map());
    await expect(plugin.getDetails('99999999', {}, detailCtx.context)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('structural drift in suggest → UPSTREAM_CHANGED (fail-closed, not [])', async () => {
    const plugin = buildDoubanPlugin(PLUGIN_OPTIONS);
    const drifted = SUGGEST_FIXTURE.map((item: Record<string, unknown>, i: number) =>
      i === 1 ? { ...item, type: undefined } : item
    );
    const ctx = makeContext(new Map([['/j/subject_suggest?q=示例', { status: 200, body: JSON.stringify(drifted) }]]));
    await expect(plugin.search({ query: '示例' }, ctx.context)).rejects.toMatchObject({ code: 'UPSTREAM_CHANGED' });
  });

  it('subject page without valid JSON-LD → UPSTREAM_CHANGED', async () => {
    const plugin = buildDoubanPlugin(PLUGIN_OPTIONS);
    const ctx = makeContext(
      new Map([['/subject/123/?q=', { status: 200, body: '<html><body>改版后的页面，没有 ld+json</body></html>' }]])
    );
    await expect(plugin.getDetails('123', {}, ctx.context)).rejects.toMatchObject({ code: 'UPSTREAM_CHANGED' });
  });

  it('maps movie and tv details with full closure and schema validity', async () => {
    const plugin = buildDoubanPlugin(PLUGIN_OPTIONS);
    const movieCtx = makeContext(new Map([['/subject/25457203/?q=', { status: 200, body: DETAIL_HTML }]]));
    const payload = await plugin.getDetails('25457203', {}, movieCtx.context);
    expect(validateMetadataPayload(payload)).toEqual([]);
    expect(payload.kind).toBe('movie');
    expect(payload.title).toBe('示例电影');
    expect(payload.year).toBe(2023);
    expect(payload.premiered).toBe('2023-04-01');
    expect(payload.genres).toEqual(['剧情', '科幻']);
    expect(payload.directors).toEqual(['张三']);
    expect(payload.actors.map((a) => a.name)).toEqual(['李四', '王五']);
    expect(payload.rating).toBe(7.6);
    expect(payload.uniqueIds).toEqual([{ provider: 'douban', id: '25457203' }]);
    expect(payload.thumbs[0]).toContain('doubanio.com');

    const tvCtx = makeContext(new Map([['/subject/35465232/?q=', { status: 200, body: DETAIL_TV_HTML }]]));
    const tvPayload = await plugin.getDetails('35465232', {}, tvCtx.context);
    expect(validateMetadataPayload(tvPayload)).toEqual([]);
    expect(tvPayload.kind).toBe('tvshow');
  });

  it('season/episode lookups → NOT_FOUND (诚实拒绝分集粒度)', async () => {
    const plugin = buildDoubanPlugin(PLUGIN_OPTIONS);
    const ctx = makeContext(new Map());
    await expect(plugin.getDetails('25457203', { season: 1 }, ctx.context)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(plugin.getDetails('25457203', { season: 1, episode: 2 }, ctx.context)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(ctx.requests).toHaveLength(0);
  });

  it('strong cache: second call makes zero requests (详情 30 天 / 搜索 6h)', async () => {
    const plugin = buildDoubanPlugin(PLUGIN_OPTIONS);
    const ctx = makeContext(
      new Map([
        ['/subject/25457203/?q=', { status: 200, body: DETAIL_HTML }],
        ['/j/subject_suggest?q=示例电影', { status: 200, body: JSON.stringify(SUGGEST_FIXTURE) }],
      ])
    );
    await plugin.getDetails('25457203', {}, ctx.context);
    await plugin.getDetails('25457203', {}, ctx.context);
    expect(ctx.requests).toHaveLength(1);

    await plugin.search({ query: '示例电影', kind: 'movie' }, ctx.context);
    await plugin.search({ query: '示例电影', kind: 'movie' }, ctx.context);
    expect(ctx.requests.filter((r) => r.url.includes('subject_suggest'))).toHaveLength(1);
  });

  it('self-throttles requests ≥ DOUBAN_MIN_INTERVAL_MS (生产默认 3s)', async () => {
    // 注入时钟：sleep 推进虚拟时钟，断言两次网络请求间隔 ≥ 3s。
    const clock = { now: Date.now() };
    const plugin = buildDoubanPlugin({
      now: () => clock.now,
      sleep: async (ms) => {
        clock.now += ms;
      },
    });
    const hitTimes: number[] = [];
    const mkCtx = (q: string) =>
      makeContext(
        new Map([
          [`/j/subject_suggest?q=${q}`, { status: 200, body: '[]' }],
          [`/j/subject_suggest?q=${q}&_`, { status: 200, body: '[]' }],
        ])
      );
    const wrap = (ctx: ReturnType<typeof makeContext>): PluginContext => ({
      ...ctx.context,
      http: {
        ...ctx.context.http,
        request: async (req) => {
          hitTimes.push(clock.now);
          return ctx.context.http.request(req);
        },
      },
    });
    await plugin.search({ query: 'a' }, wrap(mkCtx('a')));
    await plugin.search({ query: 'b' }, wrap(mkCtx('b')));
    expect(hitTimes).toHaveLength(2);
    expect(hitTimes[1] - hitTimes[0]).toBeGreaterThanOrEqual(DOUBAN_MIN_INTERVAL_MS);
  });

  it('sends a descriptive UA and no cookies (无登录态)', async () => {
    const plugin = buildDoubanPlugin(PLUGIN_OPTIONS);
    const ctx = makeContext(new Map([['/j/subject_suggest?q=x', { status: 200, body: '[]' }]]));
    await plugin.search({ query: 'x' }, ctx.context);
    expect(ctx.requests.length).toBeGreaterThan(0);
    for (const request of ctx.requests) {
      expect(request.headers['User-Agent']).toContain('qy-player/');
      expect(request.headers['User-Agent']).toContain('douban-experimental');
      expect(request.headers['Cookie']).toBeUndefined();
      expect(request.headers['Authorization']).toBeUndefined();
    }
  });

  it('GATE: manifest marks experimental and is registry-compatible', () => {
    const plugin = buildDoubanPlugin();
    expect(plugin.manifest).toMatchObject({ id: 'douban', name: '豆瓣（实验性）', version: '0.1.0', apiVersion: 1 });
  });
});

// ---------------------------------------------------------------------------
// 批量暂停（§11.4：结构变化 → UPSTREAM_CHANGED → 暂停批量任务）
// ---------------------------------------------------------------------------

function makeJobDeps(over: { search?: ScrapeJobDeps['runSearch']; details?: ScrapeJobDeps['runDetails'] } = {}) {
  const kv = new Map<string, string>();
  const repo = {
    getItem: (id: number) => ({ id, kind: 'movie', title: `电影${id}`, source_id: 1 }),
    listMetadataSources: () => [],
    upsertMetadataSource: () => undefined,
  };
  const deps: ScrapeJobDeps = {
    repo,
    kv,
    cacheDir: mkdtempSync(join(tmpdir(), 'douban-job-')),
    runSearch: over.search ?? (async () => []),
    runDetails: over.details ?? (async () => {
      throw new PluginError('NOT_FOUND', 'no details');
    }),
  };
  return { deps };
}

describe('batch pause on UPSTREAM_CHANGED (§11.4 / job-service integration)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('one item hitting UPSTREAM_CHANGED pauses the whole batch (pending preserved)', async () => {
    const { deps } = makeJobDeps({
      search: async (_id: string, query: { title: string }) => {
        if (query.title === '电影2') {
          throw new PluginError('UPSTREAM_CHANGED', '豆瓣页面结构变化：ld-json 缺少必需字段 name');
        }
        return [{ id: `d-${query.title}`, title: query.title, score: 0 } as MetadataCandidate];
      },
      details: async () => {
        throw new Error('should not reach details');
      },
    });
    const service = new ScrapeJobService(deps);
    const { jobId } = await service.startJob('douban', [1, 2, 3, 4]);
    await vi.waitFor(() => {
      const record = service.getJob(jobId);
      expect(record?.status === 'failed' || record?.status === 'completed').toBe(true);
    });
    const record = service.getJob(jobId);
    if (!record) throw new Error('job record missing');
    // 批量被暂停：状态 failed（非 completed），pending 保留未处理条目。
    expect(record.status).toBe('failed');
    expect(record.items.some((item) => item.errorCode === 'UPSTREAM_CHANGED')).toBe(true);
    expect(record.pending.length).toBeGreaterThan(0);
    // 除触发条目外没有继续调度：items 数 < 总数。
    expect(record.items.length).toBeLessThan(4);
  });

  it('non-fatal failures do NOT pause the batch (RATE_LIMITED per-item)', async () => {
    const { deps } = makeJobDeps({
      search: async (_id: string, query: { title: string }) => {
        if (query.title === '电影1') throw new PluginError('RATE_LIMITED', '限流');
        return [{ id: `d-${query.title}`, title: query.title, score: 0 } as MetadataCandidate];
      },
      details: async () => {
        throw new PluginError('NOT_FOUND', 'no');
      },
    });
    const service = new ScrapeJobService(deps);
    const { jobId } = await service.startJob('douban', [1, 2, 3, 4]);
    await vi.waitFor(() => expect(service.getJob(jobId)?.status).toBe('completed'));
    const record = service.getJob(jobId);
    if (!record) throw new Error('job record missing');
    expect(record.items).toHaveLength(4); // 全部处理完
  });
});
