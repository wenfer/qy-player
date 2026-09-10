/**
 * Unified catalog domain contract (QYP2-002).
 *
 * See docs/decisions/0001-media-ref-and-catalog-schema.md and
 * tasks/plan.md §4 for the normative background.
 */

// ---------------------------------------------------------------------------
// Media identity
// ---------------------------------------------------------------------------

/**
 * Unambiguous media identity. Every reference crossing the IPC boundary must
 * carry its owner: catalog items by sourceId, online items by serverId.
 * Renderers must never submit raw paths, URLs or delete targets.
 */
export type MediaRef =
  | { provider: 'catalog'; sourceId: number; itemId: string }
  | { provider: 'jellyfin' | 'emby'; serverId: number; itemId: string };

/** Runtime guard for MediaRef; used to validate untrusted IPC input. */
export function isMediaRef(value: unknown): value is MediaRef {
  if (typeof value !== 'object' || value === null) return false;
  const ref = value as Record<string, unknown>;
  // hasOwnProperty.call instead of Object.hasOwn: keeps the check usable on
  // the ES2020 lib target and immune to polluted prototypes (plan §16.3).
  const hasOwn = (key: string): boolean => Object.prototype.hasOwnProperty.call(ref, key);
  if (!hasOwn('itemId') || !isNonEmptyString(ref.itemId)) return false;
  if (!hasOwn('provider')) return false;
  if (ref.provider === 'catalog') {
    return hasOwn('sourceId') && isPositiveInt(ref.sourceId);
  }
  if (ref.provider === 'jellyfin' || ref.provider === 'emby') {
    return hasOwn('serverId') && isPositiveInt(ref.serverId);
  }
  return false;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

// ---------------------------------------------------------------------------
// Catalog items
// ---------------------------------------------------------------------------

export type CatalogKind = 'movie' | 'series' | 'season' | 'episode' | 'video';

export type SourceKind = 'local' | 'webdav';

export type Availability = 'online' | 'offline' | 'missing';

export interface CatalogProgress {
  position: number;
  duration: number;
  isFinished: boolean;
}

/** Unified list item rendered by poster grids across all sources. */
export interface CatalogItemSummary {
  ref: MediaRef;
  kind: CatalogKind;
  title: string;
  year?: number;
  posterUrl?: string;
  availability: Availability;
  progress?: CatalogProgress;
  /** Season/episode position for episode rows and stable sorting. */
  seasonNumber?: number;
  episodeNumber?: number;
  seriesRef?: MediaRef;
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

export interface SourceCapabilities {
  canSeek: boolean;
  canDelete: boolean;
  supportsEtag: boolean;
  supportsRange: boolean;
}

export interface SourceSummary {
  id: number;
  kind: SourceKind;
  name: string;
  /** Root WITHOUT credentials; renderer must never receive secrets. */
  root: string;
  readOnly: boolean;
  capabilities: SourceCapabilities;
  /** True when a usable credential exists in the SecretStore. */
  hasCredential: boolean;
}

export type SourceHealth = 'ok' | 'degraded' | 'offline' | 'auth-required' | 'unscanned';

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

/** Scan state machine per plan §6.1. Terminal states: completed/cancelled/failed/interrupted. */
export type ScanState =
  | 'queued'
  | 'discovering'
  | 'indexing'
  | 'enriching'
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'interrupted';

/** Pushed to renderers at most 4Hz (plan §16.4). */
export interface ScanProgressEvent {
  sourceId: number;
  runId: number;
  state: ScanState;
  processed?: number;
  total?: number;
  /** Sanitized message; must never contain credentials or full private URLs. */
  message?: string;
  /** Unix timestamp in milliseconds. */
  at: number;
}

/** Renderer-supplied input for creating a local source (plan §7). */
export interface CreateLocalSourceInput {
  kind: 'local';
  /** Directory path from the Electron picker; canonicalized main-side. */
  root: string;
  name?: string;
}

export function isCreateLocalSourceInput(value: unknown): value is CreateLocalSourceInput {
  if (typeof value !== 'object' || value === null) return false;
  const input = value as Record<string, unknown>;
  if (input.kind !== 'local') return false;
  if (typeof input.root !== 'string' || input.root.length === 0) return false;
  if (input.name !== undefined && typeof input.name !== 'string') return false;
  return true;
}

/** Last known scan state for a source, for lists that must not re-query. */
export interface SourceListEntry extends SourceSummary {
  lastRun?: {
    status: ScanState;
    processed?: number;
    total?: number;
    /** Sanitized failure message for failed runs. */
    message?: string;
    /** Unix timestamp in milliseconds. */
    at: number;
  };
}

// ---------------------------------------------------------------------------
// Pagination (runtime-checked contract)
// ---------------------------------------------------------------------------

export const DEFAULT_PAGE_SIZE = 60;
export const MAX_PAGE_SIZE = 200;

export interface PageQuery {
  page?: number;
  pageSize?: number;
}

export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  /** Opaque continuation cursor for large libraries; absent on the last page. */
  nextCursor?: string;
}

/** Clamp an untrusted page query to contract bounds. */
export function normalizePageQuery(query: PageQuery | undefined): Required<Pick<PageQuery, 'page' | 'pageSize'>> {
  // Guard against absurd offsets that would break downstream SQL LIMIT math.
  const MAX_PAGE_NUMBER = 1_000_000;
  const rawPage = query?.page;
  const page = isPositiveInt(rawPage) && rawPage <= MAX_PAGE_NUMBER ? rawPage : 1;
  let pageSize = isPositiveInt(query?.pageSize) ? query.pageSize : DEFAULT_PAGE_SIZE;
  if (pageSize > MAX_PAGE_SIZE) pageSize = MAX_PAGE_SIZE;
  return { page, pageSize };
}
