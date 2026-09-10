import type Database from 'better-sqlite3';
import type {
  CatalogBrowseQuery,
  CatalogItemDetail,
  CatalogItemSummary,
  CatalogKind,
  CatalogSearchQuery,
  FieldProvenanceInfo,
  Page,
} from '../../../shared/types/catalog';
import { normalizePageQuery } from '../../../shared/types/catalog';
import { createCatalogRepository, type CatalogItemRow } from './repository';
import { PROVIDER_PRIORITY } from '../metadata/types';

/**
 * Read-side query service over the phase-2 catalog (QYP2-011).
 *
 * All SQL lives in the repository; this module composes pages, overlays
 * metadata winners (manual > nfo > scraper > filename, plan §9.2) onto
 * filename-derived item fields, and attaches progress. Never returns
 * secrets or raw absolute paths — playback paths are resolved by the
 * dedicated IPC handler through the source adapter's containment check.
 */

/** Escape user input for a LIKE with ESCAPE '\'. */
export function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function decodeValue(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw; // legacy/plaintext rows still display
  }
}

function toSummary(row: CatalogItemRow, sourceId: number): CatalogItemSummary {
  return {
    ref: { provider: 'catalog', sourceId, itemId: String(row.id) },
    kind: row.kind,
    title: row.title ?? row.source_key,
    ...(row.year !== null ? { year: row.year } : {}),
    availability: row.availability,
    ...(row.season_number !== null ? { seasonNumber: row.season_number } : {}),
    ...(row.episode_number !== null ? { episodeNumber: row.episode_number } : {}),
  };
}

interface MetadataRow {
  item_id: number;
  field: string;
  provider: string;
  value: string | null;
  revision: number;
}

/** Winner slot per field across providers (PROVIDER_PRIORITY order). */
function winnerOfField(rows: MetadataRow[], field: string): MetadataRow | undefined {
  let best: MetadataRow | undefined;
  for (const row of rows) {
    if (row.field !== field) continue;
    const rank = PROVIDER_PRIORITY.indexOf(row.provider as typeof PROVIDER_PRIORITY[number]);
    if (rank === -1) continue;
    if (!best || rank < PROVIDER_PRIORITY.indexOf(best.provider as typeof PROVIDER_PRIORITY[number])) {
      best = row;
    }
  }
  return best;
}

function overlaySummaries(
  rows: CatalogItemRow[],
  sourceId: number,
  metaRows: MetadataRow[],
  states: Array<{ item_id: number; position: number; duration: number | null; is_finished: number }>
): CatalogItemSummary[] {
  const statesByItem = new Map(states.map((s) => [s.item_id, s]));
  return rows.map((row) => {
    const summary = toSummary(row, sourceId);
    const own = metaRows.filter((m) => m.item_id === row.id);
    const titleWinner = winnerOfField(own, 'title');
    if (titleWinner) {
      const value = decodeValue(titleWinner.value);
      if (typeof value === 'string' && value) summary.title = value;
    }
    const ratingWinner = winnerOfField(own, 'rating');
    if (ratingWinner) {
      const value = decodeValue(ratingWinner.value);
      if (typeof value === 'number' && Number.isFinite(value)) {
        summary.rating = value;
      }
    }
    const state = statesByItem.get(row.id);
    if (state) {
      summary.progress = {
        position: state.position,
        duration: state.duration ?? 0,
        isFinished: state.is_finished === 1,
      };
    }
    return summary;
  });
}

/** Playback intent without any path: the IPC layer resolves the path
 * through the source adapter's containment check (never this module). */
export interface PlaybackIntent {
  itemId: number;
  relativePath: string;
  title: string;
  kind: CatalogKind;
  position: number;
  duration?: number;
  seriesTitle?: string;
  seasonNumber?: number;
  episodeNumber?: number;
}

export interface CatalogQueryService {
  listPage(query: CatalogBrowseQuery): Page<CatalogItemSummary>;
  search(query: CatalogSearchQuery): Page<CatalogItemSummary>;
  getDetail(sourceId: number, itemId: number): CatalogItemDetail | null;
  getPlayback(sourceId: number, itemId: number): PlaybackIntent | null;
}

export function createCatalogQueryService(db: Database.Database): CatalogQueryService {
  const repo = createCatalogRepository(db);

  return {
    listPage(query: CatalogBrowseQuery): Page<CatalogItemSummary> {
      const { page, pageSize } = normalizePageQuery(query);
      const { rows, total } = repo.listItemsFiltered(
        {
          sourceId: query.sourceId,
          parentId: query.parentId ?? null,
          ...(query.kind ? { kind: query.kind } : {}),
        },
        pageSize,
        (page - 1) * pageSize
      );
      const itemIds = rows.map((r) => r.id);
      const metaRows = repo.listMetadataSourcesForItems(itemIds) as MetadataRow[];
      const states = repo.listUserStatesForItems(itemIds);
      const items = overlaySummaries(rows, query.sourceId, metaRows, states);
      const result: Page<CatalogItemSummary> = { items, page, pageSize };
      if ((page - 1) * pageSize + items.length < total) {
        result.nextCursor = String(page + 1);
      }
      return result;
    },

    search(query: CatalogSearchQuery): Page<CatalogItemSummary> {
      const { page, pageSize } = normalizePageQuery(query);
      const like = `%${escapeLike(query.query)}%`;
      // One source, or a fan-out across all sources (deterministic id order).
      const sourceIds = query.sourceId !== undefined
        ? [query.sourceId]
        : repo.listSources().map((s) => s.id);
      const collected: CatalogItemSummary[] = [];
      let remaining = pageSize;
      let offset = (page - 1) * pageSize;
      for (const sourceId of sourceIds) {
        if (remaining <= 0) break;
        const { rows, total } = repo.listItemsFiltered(
          { sourceId, search: like },
          remaining,
          offset
        );
        const itemIds = rows.map((r) => r.id);
        const metaRows = repo.listMetadataSourcesForItems(itemIds) as MetadataRow[];
        const states = repo.listUserStatesForItems(itemIds);
        collected.push(...overlaySummaries(rows, sourceId, metaRows, states));
        remaining -= rows.length;
        // Fan-out continues on the next source only after earlier sources
        // are fully consumed.
        if (rows.length < remaining + pageSize) offset = Math.max(0, offset - total);
        else break;
      }
      const result: Page<CatalogItemSummary> = { items: collected, page, pageSize };
      // Cursor logic stays coarse for fan-out: expose nextCursor only when
      // this single page is full (renderers treat it as "maybe more").
      if (collected.length >= pageSize) result.nextCursor = String(page + 1);
      return result;
    },

    getDetail(sourceId: number, itemId: number): CatalogItemDetail | null {
      const row = repo.getItem(itemId);
      if (!row || row.source_id !== sourceId) return null;
      const item = toSummary(row, sourceId);
      const metaRows = repo.listMetadataSources(itemId) as unknown as MetadataRow[];

      const metadata: CatalogItemDetail['metadata'] = {};
      const fieldProviders: Record<string, FieldProvenanceInfo> = {};
      const apply = (field: string, guard: (v: unknown) => boolean, assign: (v: unknown) => void): void => {
        const winner = winnerOfField(metaRows, field);
        if (!winner) return;
        const value = decodeValue(winner.value);
        if (!guard(value)) return;
        assign(value);
        fieldProviders[field] = {
          provider: winner.provider as FieldProvenanceInfo['provider'],
          value,
          revision: winner.revision,
        };
      };
      apply('plot', (v) => typeof v === 'string' && v.length > 0, (v) => { metadata.plot = v as string; });
      apply('tagline', (v) => typeof v === 'string' && v.length > 0, (v) => { metadata.tagline = v as string; });
      apply('rating', (v) => typeof v === 'number', (v) => { metadata.rating = v as number; });
      apply('contentRating', (v) => typeof v === 'string', (v) => { metadata.contentRating = v as string; });
      apply('premiered', (v) => typeof v === 'string', (v) => { metadata.premiered = v as string; });
      apply('runtime', (v) => typeof v === 'number', (v) => { metadata.runtime = v as number; });
      apply('genres', Array.isArray, (v) => { metadata.genres = v as string[]; });
      apply('studios', Array.isArray, (v) => { metadata.studios = v as string[]; });
      apply('countries', Array.isArray, (v) => { metadata.countries = v as string[]; });
      apply('directors', Array.isArray, (v) => { metadata.directors = v as string[]; });
      apply('actors', Array.isArray, (v) => { metadata.actors = v as CatalogItemDetail['metadata']['actors']; });
      apply('originalTitle', (v) => typeof v === 'string', (v) => { metadata.originalTitle = v as string; });
      apply('sortTitle', (v) => typeof v === 'string', (v) => { metadata.sortTitle = v as string; });
      apply('set', (v) => typeof v === 'string', (v) => { metadata.set = v as string; });
      // Title/year winners also matter for display consistency.
      apply('title', (v) => typeof v === 'string' && v.length > 0, (v) => { item.title = v as string; });
      apply('year', (v) => typeof v === 'number', (v) => { item.year = v as number; });
      const ratingWinner = winnerOfField(metaRows, 'rating');
      if (ratingWinner) {
        const value = decodeValue(ratingWinner.value);
        if (typeof value === 'number') (item as { rating?: number }).rating = value;
      }

      const childRows = repo.listByParent(itemId, sourceId);
      const childMeta = repo.listMetadataSourcesForItems(
        childRows.map((c) => c.id)
      ) as unknown as MetadataRow[];
      const childStates = repo.listUserStatesForItems(childRows.map((c) => c.id));
      const children = overlaySummaries(childRows, sourceId, childMeta, childStates);

      const state = repo.getUserState(itemId);
      const detail: CatalogItemDetail = {
        item,
        metadata,
        fieldProviders,
        files: repo.listFilesByItem(itemId).map((f) => ({
          relativePath: f.relative_path,
          ...(f.size !== null ? { size: f.size } : {}),
          ...(f.mtime !== null ? { mtime: f.mtime } : {}),
        })),
        children,
        ...(state
          ? {
              progress: {
                position: state.position,
                duration: state.duration ?? 0,
                isFinished: state.is_finished === 1,
              },
            }
          : {}),
      };
      return detail;
    },

    getPlayback(sourceId: number, itemId: number): PlaybackIntent | null {
      const row = repo.getItem(itemId);
      if (!row || row.source_id !== sourceId) return null;
      const files = repo.listFilesByItem(itemId);
      if (files.length === 0) return null;
      const state = repo.getUserState(itemId);
      // Series context for episodes (parent → season → series chain).
      let seriesTitle: string | undefined;
      if (row.kind === 'episode' && row.parent_id !== null) {
        const season = repo.getItem(row.parent_id);
        if (season && season.parent_id !== null) {
          seriesTitle = repo.getItem(season.parent_id)?.title ?? undefined;
        }
      }
      const seasonNumber = row.season_number ?? undefined;
      // First file wins; multi-part part-joining is a later task.
      return {
        itemId,
        relativePath: files[0].relative_path,
        title: row.title ?? row.source_key,
        kind: row.kind,
        position: state?.position ?? 0,
        ...(state?.duration != null ? { duration: state.duration } : {}),
        ...(seriesTitle ? { seriesTitle } : {}),
        ...(seasonNumber !== undefined ? { seasonNumber } : {}),
        ...(row.episode_number !== null ? { episodeNumber: row.episode_number } : {}),
      };
    },
  };
}
