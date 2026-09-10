/**
 * Metadata editor contract (QYP2-023, plan §14.1): the renderer edits
 * manual override patches only; provenance and revisions come from the
 * editor service (QYP2-022).
 */
/** Structural mirror of main's MetadataProvider/MetadataValue (shared must
 * not import from main); keep in sync with src/main/modules/metadata/types. */
export type MetadataProvider = 'manual' | 'nfo' | 'scraper' | 'filename';

export type MetadataValue = string | number | string[] | Array<{ name: string; role?: string; thumb?: string }> | Array<{ provider: string; id: string; isDefault?: boolean }>;

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
