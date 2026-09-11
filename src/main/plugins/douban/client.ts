/**
 * Douban public-page client (QYP2-031, plan §11.4, ADR-0006 入口④).
 *
 * 合规边界（红线，勿放松）：
 * - 仅 GET 两个无需登录的公开入口（subject_suggest JSON + 条目页 JSON-LD）；
 * - 不携带任何登录态/Cookie，不模拟登录，不处理验证码，不重试轰炸；
 * - 自限速 ≥3s/请求（context 的 per-host 限速是通用预算，豆瓣走更严值）；
 * - 强缓存：条目详情 30 天、搜索 6h——缓存命中零请求；
 * - 结构锚点校验失败 → UPSTREAM_CHANGED（fail-closed，绝不把坏结构
 *   静默成空数据去覆盖目录）。
 */

import { PluginError } from '../../../shared/types/plugins';
import {
  DOUBAN_SUGGEST_ENDPOINT,
  DOUBAN_SUBJECT_URL_PREFIX,
  extractLdJsonBlocks,
  structureProblemsToError,
  validateDoubanDetailLd,
  validateDoubanSuggestPayload,
  type DoubanDetailLd,
  type DoubanSuggestItem,
} from './types';

/** 豆瓣自限速（ADR-0006：≥3s/请求，严于 §16.4 通用预算）。 */
export const DOUBAN_MIN_INTERVAL_MS = 3000;
/** 条目详情强缓存 TTL（30 天）：subject 页几乎不变，命中即零请求。 */
export const DOUBAN_DETAIL_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** 搜索候选缓存 TTL。 */
export const DOUBAN_SEARCH_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

const HTTP = {
  TIMEOUT_MS: 10_000,
  MAX_BYTES: 1024 * 1024,
} as const;

interface ThrottleOptions {
  minIntervalMs: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

const defaultThrottle: ThrottleOptions = {
  minIntervalMs: DOUBAN_MIN_INTERVAL_MS,
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * 进程级共享节流：多个调用方（并发 2 的批量任务）共享同一条请求队列，
 * 相邻两次请求的**发起时刻**间隔 ≥ minIntervalMs（start-to-start）。
 * 语义约定：不中断已在途的请求——上游响应慢时可能同时存在两个连接，
 * 但新请求永远遵守间隔；这正是 §11.4「低速」要求的落地方式。
 */
const throttleState = { lastAt: 0, chain: Promise.resolve() };

/** 仅测试用：重置进程级节流状态（跨用例隔离）。 */
export function resetDoubanThrottleForTests(): void {
  throttleState.lastAt = 0;
  throttleState.chain = Promise.resolve();
}

async function throttled<T>(fn: () => Promise<T>, options: ThrottleOptions): Promise<T> {
  const run = throttleState.chain.then(async () => {
    const wait = throttleState.lastAt + options.minIntervalMs - options.now();
    if (wait > 0) await options.sleep(wait);
    throttleState.lastAt = options.now();
  });
  throttleState.chain = run.catch(() => undefined);
  await run;
  return fn();
}

export interface DoubanFetchDeps {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** 仅测试用：压缩自限速间隔。生产代码不得传小值。 */
  minIntervalMs?: number;
}

export class DoubanClient {
  private readonly context: PluginContextLike;
  private readonly throttle: ThrottleOptions;

  constructor(context: PluginContextLike, deps: DoubanFetchDeps = {}) {
    this.context = context;
    this.throttle = {
      minIntervalMs: deps.minIntervalMs ?? defaultThrottle.minIntervalMs,
      now: deps.now ?? defaultThrottle.now,
      sleep: deps.sleep ?? defaultThrottle.sleep,
    };
  }

  /**
   * 搜索候选（subject_suggest）。返回 [] 表示确实无候选（合法空结果，
   * 上层 matcher 保留现有元数据）；结构问题一律 UPSTREAM_CHANGED。
   */
  async searchSuggest(query: string, kind?: 'movie' | 'series'): Promise<DoubanSuggestItem[]> {
    const cacheKey = `suggest:${query}|${kind ?? 'all'}`;
    const cached = this.context.cache.get<DoubanSuggestItem[]>(cacheKey);
    if (cached) return cached;

    const body = await this.getJson(DOUBAN_SUGGEST_ENDPOINT, { q: query });
    const problems = validateDoubanSuggestPayload(body);
    if (problems.length > 0) throw structureProblemsToError(problems);
    const items = (body as DoubanSuggestItem[]).filter(
      (item) => kind === undefined || (kind === 'movie' ? item.type === 'movie' : item.type === 'tv')
    );
    this.context.cache.set(cacheKey, items, DOUBAN_SEARCH_CACHE_TTL_MS);
    return items;
  }

  /**
   * 条目详情 JSON-LD（subject 页）。无 JSON-LD 块或全部块不满足锚点 →
   * UPSTREAM_CHANGED（§11.4：结构变化 fail-closed）。
   */
  async fetchSubjectDetail(id: string): Promise<DoubanDetailLd> {
    if (!/^\d+$/.test(id)) throw new PluginError('NOT_FOUND', '豆瓣条目 id 必须是纯数字');
    const cacheKey = `subject:${id}`;
    const cached = this.context.cache.get<DoubanDetailLd>(cacheKey);
    if (cached) return cached;

    const html = await this.getText(`${DOUBAN_SUBJECT_URL_PREFIX}${id}/`);
    const blocks = extractLdJsonBlocks(html);
    for (const block of blocks) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(block);
      } catch {
        continue; // 坏块跳过；若全部坏块，走下方 UPSTREAM_CHANGED
      }
      const problems = validateDoubanDetailLd(parsed);
      if (problems.length === 0) {
        const ld = parsed as DoubanDetailLd;
        this.context.cache.set(cacheKey, ld, DOUBAN_DETAIL_CACHE_TTL_MS);
        return ld;
      }
    }
    throw structureProblemsToError([
      { where: 'ld-json', problem: '条目页未包含满足锚点的 JSON-LD 块' },
    ]);
  }

  private async request(url: string, query: Record<string, string | undefined>): Promise<{ status: number; body: Buffer }> {
    // 明确 UA（标明应用与实验插件身份）；绝不携带 Cookie/登录态（ADR-0006）。
    const headers: Record<string, string> = {
      'User-Agent': `qy-player/${this.context.appVersion} (douban-experimental-plugin)`,
      'Accept-Language': 'zh-CN,zh;q=0.9',
    };
    return throttled(
      async () => {
        let res: { status: number; body: Buffer };
        try {
          res = await this.context.http.request({ url, method: 'GET', headers, query, timeoutMs: HTTP.TIMEOUT_MS, maxBytes: HTTP.MAX_BYTES });
        } catch (err) {
          // context 层错误已脱敏；统一归类网络错误（§11.4：失败不阻断播放）。
          if (err instanceof PluginError) throw err;
          throw new PluginError('NETWORK_ERROR', `豆瓣请求失败：${err instanceof Error ? err.message.slice(0, 120) : '未知错误'}`);
        }
        if (res.status === 429) throw new PluginError('RATE_LIMITED', '豆瓣限流（429），稍后重试');
        if (res.status === 404) throw new PluginError('NOT_FOUND', '豆瓣条目不存在');
        if (res.status !== 200) throw new PluginError('NETWORK_ERROR', `豆瓣响应异常（HTTP ${res.status}）`);
        return res;
      },
      this.throttle
    );
  }

  private async getJson(url: string, query: Record<string, string | undefined>): Promise<unknown> {
    const { body } = await this.request(url, query);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      throw new PluginError('UPSTREAM_CHANGED', '豆瓣页面结构变化：响应不是合法 JSON');
    }
    return parsed;
  }

  private async getText(url: string, query: Record<string, string | undefined> = {}): Promise<string> {
    const { body } = await this.request(url, query);
    return body.toString('utf8');
  }
}

/** 测试与生产共用的最小 context 形状（生产即 PluginContext）。 */
export interface PluginContextLike {
  appVersion: string;
  http: {
    request(req: {
      url: string;
      method?: 'GET' | 'HEAD';
      headers?: Record<string, string>;
      query?: Record<string, string | number | boolean | undefined>;
      timeoutMs?: number;
      maxBytes?: number;
    }): Promise<{ status: number; body: Buffer }>;
  };
  cache: {
    get<T>(key: string): T | undefined;
    set(key: string, value: unknown, ttlMs?: number): void;
  };
}
