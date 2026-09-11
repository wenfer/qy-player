/**
 * Unified cross-source queries (QYP2-036, plan §12 首页统一 / §17 验证).
 *
 * 目标：把四类来源（本地目录 / WebDAV 目录 / Jellyfin / Emby）的
 * 继续观看、最近添加、搜索合并成一张卡列表，同时保留 owner 精确路由
 * ——每张卡都带完整 MediaRef，renderer 播放/跳转永远走既有
 * resolvePlayback 路径（QYP2-015），不裸用 id。
 *
 * 硬性规则（§16.4 / 验收）：
 * - 去重只按完整 MediaRef（provider + owner id + itemId）——两个来源
 *   里的同名电影绝不合并成一张卡（宁可重复，不可错归属）；
 * - 来源局部失败不阻塞其他内容：每个来源独立 try/catch，失败来源
 *   记入 partialFailures，其余照常返回；
 * - 分页 ≤200（clamp，不静默放行超预算请求）。
 */

import type { Database as SqliteDatabase } from 'better-sqlite3';
import type { MediaRef } from '../../../shared/types/catalog';

export const UNIFIED_MAX_PAGE_SIZE = 200;

export interface UnifiedCard {
  ref: MediaRef;
  title: string;
  kind?: string;
  year?: number;
  rating?: number;
  position?: number;
  duration?: number;
  isFinished?: boolean;
  /** 归一化的展示字段；renderer 不做 provider 特化拼接。 */
  poster?: { serverId?: number; tag?: string; itemId?: string } | null;
  updatedAt?: number;
}

/** 完整 MediaRef 键：provider + owner + itemId（+ mediaSourceId 可选域）。 */
export function mediaRefKey(ref: MediaRef): string {
  const owner = ref.provider === 'catalog' ? `s${ref.sourceId}` : `srv${ref.serverId}`;
  return `${ref.provider}:${owner}:${ref.itemId}`;
}

/** 只按完整 MediaRef 去重（首个出现者胜出——调用方决定排序语义）。 */
export function dedupeByMediaRef<T extends { ref: MediaRef }>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const key = mediaRefKey(item.ref);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export function clampPageSize(size: number): number {
  if (!Number.isFinite(size) || size < 1) return 60;
  return Math.min(Math.floor(size), UNIFIED_MAX_PAGE_SIZE);
}

export interface UnifiedPage<T> {
  items: T[];
  page: number;
  total: number;
  hasMore: boolean;
}

export function paginate<T>(items: T[], page: number, pageSize: number): { items: T[]; page: number; total: number } {
  const size = clampPageSize(pageSize);
  const p = Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1;
  const start = (p - 1) * size;
  return { items: items.slice(start, start + size), page: p, total: items.length };
}

/** 单来源尝试：异常折叠为失败结果，绝不向上抛（§16.4: 失败不阻塞）。 */
export async function isolateSource<T>(run: () => Promise<T[]>): Promise<T[]> {
  try {
    const items = await run();
    return Array.isArray(items) ? items : [];
  } catch {
    return []; // 该来源缺席；其余来源照常
  }
}

/** Catalog 侧行 → UnifiedCard 的装配（供 service 与测试共用）。 */
export interface CatalogContinueRow {
  item_id: number;
  source_id: number;
  source_kind: string;
  title: string | null;
  kind: string;
  year: number | null;
  rating_json: string | null;
  position: number;
  duration: number | null;
  updated_at: number | null;
}

export function cardFromCatalogContinue(row: CatalogContinueRow): UnifiedCard {
  let rating: number | undefined;
  try {
    const parsed = row.rating_json != null ? JSON.parse(row.rating_json) : null;
    if (typeof parsed === 'number' && Number.isFinite(parsed)) rating = parsed;
  } catch {
    // rating 缺失/格式异常：跳过，绝不影响卡片
  }
  return {
    ref: { provider: 'catalog', sourceId: row.source_id, itemId: String(row.item_id) },
    title: row.title ?? '未知',
    kind: row.kind,
    ...(row.year != null ? { year: row.year } : {}),
    ...(rating !== undefined ? { rating } : {}),
    position: row.position,
    ...(row.duration != null ? { duration: row.duration } : {}),
    updatedAt: (row.updated_at ?? 0) * 1000,
  };
}

export interface OnlineContinueInput {
  provider: 'jellyfin' | 'emby';
  serverId: number;
  itemId: string;
  title: string;
  kind: string;
  year?: number;
  rating?: number;
  positionTicks?: number;
  runtimeTicks?: number;
  primaryTag?: string;
  updatedAt?: number;
}

export function cardFromOnlineContinue(input: OnlineContinueInput): UnifiedCard {
  return {
    ref: { provider: input.provider, serverId: input.serverId, itemId: input.itemId },
    title: input.title || '未知',
    kind: input.kind,
    ...(input.year != null ? { year: input.year } : {}),
    ...(input.rating != null ? { rating: input.rating } : {}),
    position: input.positionTicks ? input.positionTicks / 10000000 : 0,
    ...(input.runtimeTicks ? { duration: input.runtimeTicks / 10000000 } : {}),
    poster: { serverId: input.serverId, itemId: input.itemId, ...(input.primaryTag ? { tag: input.primaryTag } : {}) },
    ...(input.updatedAt != null ? { updatedAt: input.updatedAt } : {}),
  };
}

export interface UnifiedQueryDeps {
  db: SqliteDatabase;
  /** 各在线服务器的搜索/继续观看（内部独立 try/catch，见 isolateSource）。 */
  onlineContinueWatching: () => Promise<OnlineContinueInput[]>;
  onlineSearch: (query: string) => Promise<OnlineContinueInput[]>;
  /** 在线「最近添加」：按服务器/视图取 DateCreated 最新的条目。 */
  onlineRecent: () => Promise<OnlineContinueInput[]>;
}

export function createUnifiedQueryService(deps: UnifiedQueryDeps) {
  const db = deps.db;

  const catalogContinue = (): UnifiedCard[] => {
    const rows = db
      .prepare(
        `SELECT ci.id AS item_id, ci.source_id, ls.kind AS source_kind, ci.title, ci.kind, ci.year,
                us.position, us.duration, us.is_finished, us.updated_at,
                (SELECT ms.value FROM catalog_metadata_sources ms WHERE ms.item_id = ci.id AND ms.field = 'rating' LIMIT 1) AS rating_json
         FROM catalog_items ci
         JOIN catalog_user_state us ON us.item_id = ci.id
         JOIN library_sources ls ON ls.id = ci.source_id
         WHERE us.is_finished = 0 AND us.position >= 30
         ORDER BY us.updated_at DESC
         LIMIT 200`
      )
      .all() as unknown as CatalogContinueRow[];
    return rows.map(cardFromCatalogContinue);
  };

  const catalogRecent = (limit: number): UnifiedCard[] => {
    const rows = db
      .prepare(
        `SELECT ci.id AS item_id, ci.source_id, ci.title, ci.kind, ci.year, ci.created_at
         FROM catalog_items ci
         WHERE ci.kind IN ('movie', 'series') AND ci.availability = 'online'
         ORDER BY ci.created_at DESC
         LIMIT ?`
      )
      .all(limit) as Array<{ item_id: number; source_id: number; title: string | null; kind: string; year: number | null; created_at: number | null }>;
    return rows.map((row) => ({
      ref: { provider: 'catalog' as const, sourceId: row.source_id, itemId: String(row.item_id) },
      title: row.title ?? '未知',
      kind: row.kind,
      ...(row.year != null ? { year: row.year } : {}),
      updatedAt: (row.created_at ?? 0) * 1000,
    }));
  };

  const catalogSearch = (query: string, limit: number): UnifiedCard[] => {
    const rows = db
      .prepare(
        `SELECT ci.id AS item_id, ci.source_id, ci.title, ci.kind, ci.year,
                (SELECT ms.value FROM catalog_metadata_sources ms WHERE ms.item_id = ci.id AND ms.field = 'rating' LIMIT 1) AS rating_json
         FROM catalog_items ci
         WHERE ci.kind IN ('movie', 'series', 'video')
           AND ci.availability = 'online'
           AND ci.title LIKE '%' || ? || '%'
         ORDER BY ci.title
         LIMIT ?`
      )
      .all(query, limit) as Array<{ item_id: number; source_id: number; title: string | null; kind: string; year: number | null; rating_json: string | null }>;
    return rows.map((row) => {
      let rating: number | undefined;
      try {
        const parsed = row.rating_json != null ? JSON.parse(row.rating_json) : null;
        if (typeof parsed === 'number' && Number.isFinite(parsed)) rating = parsed;
      } catch {
        // ignore
      }
      return {
        ref: { provider: 'catalog' as const, sourceId: row.source_id, itemId: String(row.item_id) },
        title: row.title ?? '未知',
        kind: row.kind,
        ...(row.year != null ? { year: row.year } : {}),
        ...(rating !== undefined ? { rating } : {}),
      };
    });
  };

  return {
    /** 继续观看：目录（local/webdav）+ 在线（Jellyfin/Emby）合并、MediaRef 去重。 */
    async continueWatching(limit = 40): Promise<UnifiedCard[]> {
      const [catalogPart, onlinePart] = await Promise.all([
        isolateSource(async () => catalogContinue()),
        isolateSource(async () => deps.onlineContinueWatching().then((rows) => rows.map(cardFromOnlineContinue))),
      ]);
      const merged = [...onlinePart, ...catalogPart]
        .map((card) => ({ card, sortKey: card.updatedAt ?? 0 }))
        .sort((a, b) => b.sortKey - a.sortKey)
        .map(({ card }) => card);
      return dedupeByMediaRef(merged).slice(0, clampPageSize(limit));
    },

    /** 最近添加：目录（created_at）+ 在线（视图 DateCreated）合并去重。 */
    async recent(limit = 24): Promise<UnifiedCard[]> {
      const [catalogPart, onlinePart] = await Promise.all([
        isolateSource(async () => catalogRecent(clampPageSize(limit))),
        isolateSource(async () => deps.onlineRecent().then((rows) => rows.map(cardFromOnlineContinue))),
      ]);
      const merged = [...onlinePart, ...catalogPart]
        .map((card) => ({ card, sortKey: card.updatedAt ?? 0 }))
        .sort((a, b) => b.sortKey - a.sortKey);
      return dedupeByMediaRef(merged.map(({ card }) => card)).slice(0, clampPageSize(limit));
    },

    /** 统一搜索：目录 + 全部在线服务器，MediaRef 去重 + ≤200 分页。 */
    async search(query: string, page = 1): Promise<{ items: UnifiedCard[]; page: number; total: number }> {
      const clean = query.trim();
      if (!clean) return { items: [], page: 1, total: 0 };
      const [catalogPart, onlinePart] = await Promise.all([
        isolateSource(async () => catalogSearch(clean, UNIFIED_MAX_PAGE_SIZE)),
        isolateSource(async () => deps.onlineSearch(clean).then((rows) => rows.map(cardFromOnlineContinue))),
      ]);
      const merged = dedupeByMediaRef([...catalogPart, ...onlinePart]);
      const pageResult = paginate(merged, page, UNIFIED_MAX_PAGE_SIZE);
      return pageResult;
    },
  };
}
