/**
 * Metadata editor contract (QYP2-023, plan §14.1): the renderer edits
 * manual override patches only; provenance and revisions come from the
 * editor service (QYP2-022).
 */
/** Structural mirror of main's MetadataProvider/MetadataValue (shared must
 * not import from main); keep in sync with src/main/modules/metadata/types. */
export type MetadataProvider = 'manual' | 'nfo' | 'scraper' | 'filename';

export type MetadataValue = string | number | string[] | NfoActor[] | NfoUniqueId[];

/** Structural mirrors of main's metadata types (shared must not import
 * from main; keep in sync with src/main/modules/metadata/types.ts). */
export interface NfoActor {
  name: string;
  role?: string;
  thumb?: string;
}

export interface NfoUniqueId {
  provider: string;
  id: string;
  isDefault?: boolean;
}

export interface MetadataFieldInfo {
  field: string;
  /** Current winner (what the UI displays); null when no provider has it. */
  winner: { provider: MetadataProvider; revision: number; value: MetadataValue } | null;
  /** Every provider slot present for the field (provenance view). */
  providers: Array<{ provider: MetadataProvider; revision: number; value: MetadataValue }>;
}

export interface MetadataItemState {
  itemId: number;
  fields: MetadataFieldInfo[];
}

/** One manual patch; value null restores the source value. */
export interface MetadataSavePatch {
  field: string;
  value: MetadataValue | null;
  expectedRevision: number;
}

export interface MetadataConflict {
  field: string;
  expectedRevision: number;
  current: { provider: MetadataProvider; revision: number; value: MetadataValue } | null;
}

/** Chinese labels for user-visible messages and the editor UI (AGENTS.md:
 * internal field keys must not appear as-is in the UI). */
export const METADATA_FIELD_LABELS: Record<string, string> = {
  title: '标题',
  originalTitle: '原标题',
  sortTitle: '排序标题',
  tagline: '标语',
  contentRating: '分级',
  year: '年份',
  premiered: '首映日期',
  rating: '评分',
  genres: '类型',
  countries: '国家/地区',
  directors: '导演',
  actors: '演员',
  uniqueIds: '外部 ID',
  plot: '剧情简介',
  season: '季号',
  episode: '集号',
  poster: '海报',
  fanart: '背景图',
};
