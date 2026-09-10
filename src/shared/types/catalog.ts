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
  /** Merged winner rating (manual > nfo > scraper > filename), 0-10. */
  rating?: number;
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

/** Renderer-supplied input for creating a WebDAV source (plan §8.1/8.2). */
export interface CreateWebDavSourceInput {
  kind: 'webdav';
  /** Base URL: origin + root path only; validated main-side again. */
  url: string;
  name?: string;
  username?: string;
  password?: string;
  /**
   * Set by the renderer after the user explicitly confirmed plaintext
   * transport for http:// (plan §8.1). Required for http URLs at save.
   */
  confirmHttpPlaintext?: boolean;
}

export function isCreateWebDavSourceInput(value: unknown): value is CreateWebDavSourceInput {
  if (typeof value !== 'object' || value === null) return false;
  const input = value as Record<string, unknown>;
  if (input.kind !== 'webdav') return false;
  if (typeof input.url !== 'string' || input.url.length === 0 || input.url.length > 2048) return false;
  if (input.name !== undefined && typeof input.name !== 'string') return false;
  if (input.username !== undefined && (typeof input.username !== 'string' || input.username.length > 256)) return false;
  if (input.password !== undefined && (typeof input.password !== 'string' || input.password.length > 1024)) return false;
  if (input.confirmHttpPlaintext !== undefined && typeof input.confirmHttpPlaintext !== 'boolean') return false;
  return true;
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
// Browse / search / detail queries (QYP2-011)
// ---------------------------------------------------------------------------

/** Query for catalog:list — one source, one parent level, optional kind. */
export interface CatalogBrowseQuery {
  sourceId: number;
  /** Null = the source's top level. */
  parentId?: number | null;
  kind?: CatalogKind;
  page?: number;
  pageSize?: number;
}

/** Query for catalog:search — full-text over one or all sources. */
export interface CatalogSearchQuery {
  query: string;
  sourceId?: number;
  page?: number;
  pageSize?: number;
}

/** Winner metadata for one field, as displayed by detail views. */
export interface FieldProvenanceInfo {
  provider: 'manual' | 'nfo' | 'scraper' | 'filename';
  value: unknown;
  revision: number;
}

/** catalog:get payload: summary + merged metadata + children + files. */
export interface CatalogItemDetail {
  item: CatalogItemSummary;
  /** Merged winner metadata (manual > nfo > scraper > filename). */
  metadata: {
    plot?: string;
    tagline?: string;
    rating?: number;
    contentRating?: string;
    premiered?: string;
    runtime?: number;
    genres?: string[];
    studios?: string[];
    countries?: string[];
    directors?: string[];
    actors?: Array<{ name: string; role?: string; thumb?: string }>;
    originalTitle?: string;
    sortTitle?: string;
    set?: string;
  };
  /** Per-field winner provenance, for the UI's 来源 display. */
  fieldProviders: Record<string, FieldProvenanceInfo>;
  files: Array<{ relativePath: string; size?: number; mtime?: number }>;
  /** Children (seasons of a series / episodes of a season), sorted. */
  children: CatalogItemSummary[];
  progress?: CatalogProgress;
}

/** catalog:resolve payload for catalog playback (QYP2-015 unifies this). */
export interface CatalogPlayback {
  /** Absolute, containment-verified filesystem path (local sources). */
  path: string;
  title: string;
  kind: CatalogKind;
  /** Resume position in seconds (catalog_user_state). */
  position: number;
  duration?: number;
  seriesTitle?: string;
  seasonNumber?: number;
  episodeNumber?: number;
  itemId: number;
}

export function isCatalogBrowseQuery(value: unknown): value is CatalogBrowseQuery {
  if (typeof value !== 'object' || value === null) return false;
  const q = value as Record<string, unknown>;
  if (!isPositiveInt(q.sourceId)) return false;
  if (q.parentId !== undefined && q.parentId !== null && !isPositiveInt(q.parentId)) return false;
  if (
    q.kind !== undefined &&
    q.kind !== 'movie' && q.kind !== 'series' && q.kind !== 'season' &&
    q.kind !== 'episode' && q.kind !== 'video'
  ) {
    return false;
  }
  return true;
}

export function isCatalogSearchQuery(value: unknown): value is CatalogSearchQuery {
  if (typeof value !== 'object' || value === null) return false;
  const q = value as Record<string, unknown>;
  if (typeof q.query !== 'string' || q.query.length === 0 || q.query.length > 200) return false;
  if (q.sourceId !== undefined && !isPositiveInt(q.sourceId)) return false;
  return true;
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
