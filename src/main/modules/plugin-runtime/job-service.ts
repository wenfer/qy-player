import { applyProviderFields, validateMetadataPayload, winnerFor, type ProviderStore } from '../metadata/metadata-merger';
import type { MetadataValue } from '../../../shared/types/plugins';
import { matchCandidates, type MatchResult } from './matcher';
import { ScrapeCache } from './cache';
import type { MetadataCandidate, MetadataPayload } from '../../../shared/types/plugins';

/**
 * Scrape job orchestration (QYP2-028, plan §11.2).
 *
 * - Single-item and batch jobs over catalog items, concurrency 2 (§16.4).
 * - Verdict per §11.2: unique candidate ≥0.92 auto-applies (through schema
 *   validation + the merger, so manual locks and existing values survive);
 *   0.75–0.92 lands in the manual-confirm queue; <0.75 rejected.
 * - Failures (network, 429, invalid payloads) NEVER overwrite existing
 *   values — the item keeps its current metadata.
 * - Cancellable mid-run and resumable: progress persists to app_config,
 *   interrupted jobs are flagged on construction, resumeJob() continues.
 */

export type ScrapeItemStatus = 'applied' | 'confirm' | 'rejected' | 'failed' | 'skipped';

export interface ScrapeItemResult {
  itemId: number;
  status: ScrapeItemStatus;
  message?: string;
  /** Confirm-queue candidates when status === 'confirm'. */
  candidates?: Array<{ id: string; title: string; score: number }>;
}

export interface ScrapeJobRecord {
  id: string;
  status: 'running' | 'completed' | 'cancelled' | 'failed' | 'interrupted';
  createdAt: number;
  updatedAt: number;
  items: ScrapeItemResult[];
  pending: number[];
  pluginId: string;
}

export interface ScrapeJobDeps {
  repo: {
    getItem(id: number): { id: number; kind: string; title: string | null; source_id: number } | undefined;
    listMetadataSources(itemId: number): Array<{ field: string; provider: string; value: string | null; revision: number }>;
    upsertMetadataSource(itemId: number, field: string, provider: string, value: unknown): void;
  };
  kv: {
    get(key: string): string | undefined;
    set(key: string, value: string): void;
  };
  cacheDir: string;
  /** Runs the registered plugin's search via its PluginContext. */
  runSearch: (pluginId: string, query: { title: string; year?: number; kind?: 'movie' | 'series' }) => Promise<MetadataCandidate[]>;
  /** Runs the registered plugin's getDetails via its PluginContext. */
  runDetails: (pluginId: string, id: string) => Promise<MetadataPayload>;
  concurrency?: number;
  now?: () => number;
}

const JOB_KEY = 'scrape.job';
const CONCURRENCY = 2;

function storeFromRows(rows: Array<{ field: string; provider: string; value: string | null; revision: number }>): ProviderStore {
  const store: ProviderStore = {};
  for (const row of rows) {
    if (row.value === null) continue;
    try {
      const slots = (store[row.field] ??= {});
      slots[row.provider as 'nfo' | 'scraper' | 'manual' | 'filename'] = {
        value: JSON.parse(row.value),
        revision: row.revision,
        updatedAt: 0,
      };
    } catch {
      continue;
    }
  }
  return store;
}

export class ScrapeJobService {
  private readonly deps: ScrapeJobDeps;
  private readonly cache: ScrapeCache;
  private readonly cancelled = new Set<string>();

  constructor(deps: ScrapeJobDeps) {
    this.deps = deps;
    this.cache = new ScrapeCache({ dir: deps.cacheDir });
    // Recovery: any job left 'running' by a crash/exit is marked interrupted
    // (its applied items persist; resumeJob continues the rest). Terminal
    // jobs are pruned beyond the newest 20 so the KV cannot grow forever.
    const all = this.allJobRecords();
    for (const [key, raw] of Object.entries(all)) {
      if (raw.status === 'running') {
        this.saveJob(key, { ...raw, status: 'interrupted' });
      }
    }
    const terminal = Object.entries(all)
      .filter(([, raw]) => raw.status !== 'running')
      .sort((a, b) => b[1].updatedAt - a[1].updatedAt);
    for (const [key] of terminal.slice(20)) {
      const current = this.allJobRecords();
      delete current[key];
      this.deps.kv.set(JOB_KEY, JSON.stringify(current));
    }
  }

  private allJobRecords(): Record<string, ScrapeJobRecord> {
    const raw = this.deps.kv.get(JOB_KEY);
    if (!raw) return {};
    try {
      return JSON.parse(raw) as Record<string, ScrapeJobRecord>;
    } catch {
      return {};
    }
  }

  private saveJob(id: string, record: ScrapeJobRecord): void {
    const all = this.allJobRecords();
    all[id] = record;
    this.deps.kv.set(JOB_KEY, JSON.stringify(all));
  }

  getJob(id: string): ScrapeJobRecord | undefined {
    return this.allJobRecords()[id];
  }

  cancelJob(id: string): boolean {
    const record = this.allJobRecords()[id];
    if (!record || record.status !== 'running') return false;
    this.cancelled.add(id);
    return true;
  }

  /** Start (or resume) a batch scrape over the given items. */
  async startJob(pluginId: string, itemIds: number[], jobId?: string): Promise<{ jobId: string }> {
    const id = jobId ?? `scrape-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const existing = jobId ? this.allJobRecords()[jobId] : undefined;
    if (existing?.status === 'running') {
      // Re-entry guard: a second queue over the same job would double-fetch
      // and overwrite state (review #3). The caller polls instead.
      throw new Error('任务正在运行中，请等待完成或取消后再试');
    }
    const done = existing ? existing.items : [];
    const doneIds = new Set(done.map((entry) => entry.itemId));
    const pending = itemIds.filter((id2) => !doneIds.has(id2));
    this.cancelled.delete(id);
    this.saveJob(id, {
      id,
      status: 'running',
      createdAt: existing?.createdAt ?? this.deps.now?.() ?? Date.now(),
      updatedAt: this.deps.now?.() ?? Date.now(),
      items: done,
      pending,
      pluginId,
    });
    // The queue never rejects (per-item isolation above); belt-and-braces.
    this.runQueue(id, pluginId, pending).catch(() => {
      const record = this.allJobRecords()[id];
      if (record?.status === 'running') {
        this.saveJob(id, { ...record, status: 'failed' });
      }
    });
    return { jobId: id };
  }

  private async runQueue(jobId: string, pluginId: string, pending: number[]): Promise<void> {
    const concurrency = this.deps.concurrency ?? CONCURRENCY;
    let index = 0;
    const workers: Array<Promise<void>> = [];
    for (let w = 0; w < Math.min(concurrency, pending.length); w += 1) {
      workers.push(
        (async () => {
          for (;;) {
            if (this.cancelled.has(jobId)) return;
            const current = index;
            index += 1;
            if (current >= pending.length) return;
            const itemId = pending[current];
            // Repo/cache层异常也要落到 failed 记录——绝不卡死 job 或产生
            // unhandled rejection（plan §11.2: 失败不得覆盖已有值）。
            let result: ScrapeItemResult;
            try {
              result = await this.scrapeItem(pluginId, itemId);
            } catch (err) {
              result = {
                itemId,
                status: 'failed',
                message: err instanceof Error ? err.message.slice(0, 200) : '刮削失败',
              };
            }
            const record = this.allJobRecords()[jobId];
            if (!record) return;
            record.items.push(result);
            record.pending = record.pending.filter((id) => id !== itemId);
            record.updatedAt = this.deps.now?.() ?? Date.now();
            this.saveJob(jobId, record);
          }
        })()
      );
    }
    await Promise.all(workers);
    const record = this.allJobRecords()[jobId];
    if (!record) return;
    if (this.cancelled.has(jobId)) {
      this.cancelled.delete(jobId);
      this.saveJob(jobId, { ...record, status: 'cancelled' });
    } else {
      this.saveJob(jobId, { ...record, status: 'completed' });
    }
  }

  /** One item: search → match → (auto) details → validate → apply. */
  async scrapeItem(pluginId: string, itemId: number): Promise<ScrapeItemResult> {
    const item = this.deps.repo.getItem(itemId);
    if (!item || !item.title) {
      return { itemId, status: 'skipped', message: '条目不存在或缺少标题' };
    }
    const kind: 'movie' | 'series' = item.kind === 'series' ? 'series' : 'movie';
    const store = storeFromRows(this.deps.repo.listMetadataSources(itemId));
    const year = winnerFor(store, 'year')?.value;
    const query = { title: item.title, year: typeof year === 'number' ? year : undefined, kind };

    // Cache first (§16.4: 有界缓存), then the plugin.
    const cacheNs = 'search';
    let candidates = this.cache.get<MetadataCandidate[]>(pluginId, cacheNs, `${query.title}|${query.year ?? ''}|${kind}`);
    if (!candidates) {
      try {
        candidates = await this.deps.runSearch(pluginId, query);
        if (!Array.isArray(candidates)) throw new Error('bad shape');
        this.cache.set(pluginId, cacheNs, `${query.title}|${query.year ?? ''}|${kind}`, candidates);
      } catch (err) {
        const code = (err as { code?: string } | null)?.code;
        return {
          itemId,
          status: 'failed',
          message: code === 'RATE_LIMITED' ? '上游限流（429），可稍后重试' : `搜索失败：${(err as Error).message}`,
        };
      }
    }

    const match: MatchResult = matchCandidates(query, candidates);
    if (match.verdict === 'rejected') {
      return { itemId, status: 'rejected', message: '无足够置信度的候选（<0.75），保留现有元数据' };
    }
    if (match.verdict === 'confirm') {
      return {
        itemId,
        status: 'confirm',
        candidates: match.confirmCandidates.map((candidate) => ({
          id: candidate.id,
          title: candidate.title,
          score: match.scored.find((entry) => entry.candidate.id === candidate.id)?.score ?? 0,
        })),
      };
    }

    const candidate = match.autoCandidate as MetadataCandidate;
    return this.applyCandidate(pluginId, itemId, candidate.id);
  }

  /** Manual-confirm path: the user picked a candidate explicitly. */
  async applyCandidate(
    pluginId: string,
    itemId: number,
    candidateId: string
  ): Promise<ScrapeItemResult> {
    let payload: MetadataPayload;
    try {
      payload = await this.deps.runDetails(pluginId, candidateId);
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      return {
        itemId,
        status: 'failed',
        message: code === 'RATE_LIMITED' ? '上游限流（429），可稍后重试' : `详情获取失败：${(err as Error).message}`,
      };
    }
    // Runtime schema validation (§11.1) — invalid payloads never touch the store.
    const problems = validateMetadataPayload(payload);
    if (problems.length > 0) {
      return { itemId, status: 'failed', message: `插件输出不合法：${problems[0]}` };
    }
    let store: ProviderStore;
    try {
      store = storeFromRows(this.deps.repo.listMetadataSources(itemId));
    } catch (err) {
      return {
        itemId,
        status: 'failed',
        message: `元数据读取失败：${err instanceof Error ? err.message.slice(0, 200) : '未知错误'}`,
      };
    }
    // Provider 'scraper': applyProviderFields skips manual-locked winners,
    // so a failed scrape or a locked field can never overwrite existing values.
    const fields: Record<string, MetadataValue | undefined> = {
      title: payload.title,
      originalTitle: payload.originalTitle,
      sortTitle: payload.sortTitle,
      year: payload.year,
      premiered: payload.premiered,
      plot: payload.plot,
      tagline: payload.tagline,
      runtime: payload.runtime,
      rating: payload.rating,
      contentRating: payload.contentRating,
      genres: payload.genres,
      studios: payload.studios,
      countries: payload.countries,
      actors: payload.actors,
      directors: payload.directors,
      season: payload.season,
      episode: payload.episode,
      uniqueIds: payload.uniqueIds,
      thumbs: payload.thumbs,
      set: payload.set,
    };
      let outcome;
    try {
      outcome = applyProviderFields(store, 'scraper', fields, { now: this.deps.now?.() ?? Date.now() });
    } catch (err) {
      return {
        itemId,
        status: 'failed',
        message: `元数据合并失败：${err instanceof Error ? err.message.slice(0, 200) : '未知错误'}`,
      };
    }
    try {
      for (const field of outcome.changedFields) {
        const slots = outcome.store[field];
        const scraper = slots?.scraper;
        if (scraper) {
          this.deps.repo.upsertMetadataSource(itemId, field, 'scraper', scraper.value);
        }
      }
    } catch (err) {
      return {
        itemId,
        status: 'failed',
        message: `元数据写入失败：${err instanceof Error ? err.message.slice(0, 200) : '未知错误'}（已应用字段可能不完整）`,
      };
    }
    return { itemId, status: 'applied', message: `已应用 ${outcome.changedFields.length} 个字段` };
  }
}
