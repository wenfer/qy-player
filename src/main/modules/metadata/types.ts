/**
 * Shared metadata types (plan §9, QYP2-010).
 *
 * Pure data contracts only — no I/O, no parser logic. The provider store is
 * JSON-serializable so it can be persisted in catalog_metadata_sources /
 * catalog_metadata_overrides without a translation layer.
 */

/** Fixed field priority (plan §9.2): high → low. */
export const PROVIDER_PRIORITY = ['manual', 'nfo', 'scraper', 'filename'] as const;
export type MetadataProvider = (typeof PROVIDER_PRIORITY)[number];

export interface NfoActor {
  name: string;
  role?: string;
  /** Reference only — external URLs are never fetched (plan §9.1). */
  thumb?: string;
}

export interface NfoUniqueId {
  provider: string;
  id: string;
  isDefault?: boolean;
}

/** Parsed NFO payload (Kodi-style tags, normalized field names). */
export interface NfoMetadata {
  kind: 'movie' | 'tvshow' | 'season' | 'episode';
  title?: string;
  originalTitle?: string;
  sortTitle?: string;
  year?: number;
  premiered?: string;
  plot?: string;
  tagline?: string;
  runtime?: number;
  rating?: number;
  contentRating?: string;
  genres: string[];
  studios: string[];
  countries: string[];
  actors: NfoActor[];
  directors: string[];
  season?: number;
  episode?: number;
  uniqueIds: NfoUniqueId[];
  /** Thumbnail/poster references from <thumb>; values only, never fetched. */
  thumbs: string[];
  set?: string;
}

/** A single field value as stored per provider. */
export type MetadataValue = string | number | string[] | NfoActor[] | NfoUniqueId[];

export interface ProviderValue {
  value: MetadataValue;
  revision: number;
  /** Unix ms. */
  updatedAt: number;
}

/**
 * field → provider → value. The displayed value of a field is always the
 * highest-priority provider slot present (see metadata-merger winnerFor).
 */
export type ProviderStore = Record<string, Partial<Record<MetadataProvider, ProviderValue>>>;

export interface FieldWinner {
  field: string;
  value: MetadataValue;
  provider: MetadataProvider;
  revision: number;
  updatedAt: number;
}

export interface MergeOutcome {
  store: ProviderStore;
  changedFields: string[];
  /** Fields whose winner is a manual override — incoming values skipped. */
  skippedLockedFields: string[];
}
