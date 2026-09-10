import {
  applyManualField,
  clearManualField,
  winnerFor,
  type ProviderStore,
} from './metadata-merger';
import { MetadataConflictError } from './metadata-merger';
import type { MetadataProvider, MetadataValue } from './types';

/**
 * Metadata override editor (QYP2-022, plan §14.1).
 *
 * Manual edits are provider slots ('manual') in the same ProviderStore the
 * scanner maintains — re-scans never overwrite them (applyProviderFields
 * skips manual winners), the NFO/scraper originals stay untouched, and
 * nothing is written back to NFO files.
 *
 * Rules from §14.1:
 * - Whitelisted fields only; per-field type/length/range validation.
 * - Save must carry the revision the editor saw; a stale revision is a
 *   conflict carrying the current value so the UI can render a diff.
 * - Per-field restore (clear manual slot) and remove-all-manual.
 */

export interface EditorRepoSurface {
  listMetadataSources(itemId: number): Array<{
    field: string;
    provider: string;
    value: string | null;
    revision: number;
  }>;
  upsertMetadataSource(itemId: number, field: string, provider: string, value: unknown): void;
  deleteMetadataSource(itemId: number, field: string, provider: string): void;
}

/** Whitelisted editable fields with their validation shapes (§14.1). */
export type EditableFieldType =
  | 'shortText'
  | 'longText'
  | 'year'
  | 'date'
  | 'rating'
  | 'number'
  | 'stringList'
  | 'castList'
  | 'idList';

export const EDITABLE_FIELDS: Record<string, EditableFieldType> = {
  title: 'shortText',
  originalTitle: 'shortText',
  sortTitle: 'shortText',
  year: 'year',
  premiered: 'date',
  plot: 'longText',
  tagline: 'shortText',
  rating: 'rating',
  contentRating: 'shortText',
  genres: 'stringList',
  countries: 'stringList',
  actors: 'castList',
  directors: 'stringList',
  season: 'number',
  episode: 'number',
  uniqueIds: 'idList',
};

export const LIMITS = {
  shortText: 300,
  longText: 5000,
  date: 32,
  listItems: 100,
  itemLength: 120,
  castName: 120,
  castRole: 120,
  idLength: 120,
};

export interface ManualPatch {
  field: string;
  /** The new value; `null` restores the source value (clears the slot). */
  value: MetadataValue | null;
  /** Revision the editor saw; stale → conflict (§14.1 forbids silent LWW). */
  expectedRevision?: number;
}

export interface ConflictDiff {
  field: string;
  expectedRevision: number;
  current: { provider: MetadataProvider; revision: number; value: MetadataValue } | null;
}

export type EditorResult =
  | { ok: true; changed: string[]; cleared: string[] }
  | { ok: false; code: 'ITEM_NOT_FOUND' | 'VALIDATION_FAILED' | 'CONFLICT'; message: string; conflicts?: ConflictDiff[] };

// ---------------------------------------------------------------------------
// Store load / persist
// ---------------------------------------------------------------------------

/** Rebuild the ProviderStore from catalog_metadata_sources rows. */
export function loadItemStore(repo: EditorRepoSurface, itemId: number): ProviderStore {
  const store: ProviderStore = {};
  for (const row of repo.listMetadataSources(itemId)) {
    const provider = row.provider as MetadataProvider;
    if (!PROVIDERS.has(provider)) continue;
    if (row.value === null) continue; // null slots carry no value
    let value: MetadataValue;
    try {
      value = JSON.parse(row.value) as MetadataValue;
    } catch {
      continue; // corrupt row: skip instead of crashing the editor
    }
    const slots = (store[row.field] ??= {});
    slots[provider] = { value, revision: row.revision, updatedAt: 0 };
  }
  return store;
}

const PROVIDERS = new Set<string>(['manual', 'nfo', 'scraper', 'filename']);

// ---------------------------------------------------------------------------
// Validation (§14.1: 输入长度/范围校验)
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function validateEditableValue(field: string, value: MetadataValue): string | null {
  const shape = EDITABLE_FIELDS[field];
  if (!shape) return `字段 ${field} 不可编辑`;
  switch (shape) {
    case 'shortText':
    case 'longText': {
      if (typeof value !== 'string' || value.trim().length === 0) return `字段 ${field} 需要非空文本`;
      const cap = shape === 'longText' ? LIMITS.longText : LIMITS.shortText;
      if (value.length > cap) return `字段 ${field} 超过 ${cap} 字上限`;
      return null;
    }
    case 'year':
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 1888 || value > 2100) {
        return `字段 ${field} 需要介于 1888 与 2100 之间的整数`;
      }
      return null;
    case 'number':
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 5000) {
        return `字段 ${field} 需要介于 0 与 5000 之间的整数`;
      }
      return null;
    case 'rating':
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 10) {
        return `字段 ${field} 需要介于 0 与 10 之间的数值`;
      }
      return null;
    case 'date':
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return `字段 ${field} 需要 YYYY-MM-DD 日期`;
      }
      return null;
    case 'stringList':
      if (!Array.isArray(value) || value.length > LIMITS.listItems) {
        return `字段 ${field} 最多 ${LIMITS.listItems} 项`;
      }
      if (value.some((v) => typeof v !== 'string' || v.length === 0 || v.length > LIMITS.itemLength)) {
        return `字段 ${field} 的每项需为 1–${LIMITS.itemLength} 字文本`;
      }
      return null;
    case 'castList':
      if (!Array.isArray(value) || value.length > LIMITS.listItems) {
        return `字段 ${field} 最多 ${LIMITS.listItems} 项`;
      }
      for (const entry of value) {
        if (!isRecord(entry) || typeof entry.name !== 'string' || entry.name.length === 0 || entry.name.length > LIMITS.castName) {
          return `字段 ${field} 的每项需要 name（≤${LIMITS.castName} 字）`;
        }
        if (entry.role !== undefined && typeof entry.role !== 'string') {
          return `字段 ${field} 的 role 需为文本`;
        }
        if (entry.role !== undefined && entry.role.length > LIMITS.castRole) {
          return `字段 ${field} 的 role 超过 ${LIMITS.castRole} 字`;
        }
      }
      return null;
    case 'idList':
      if (!Array.isArray(value) || value.length > 10) return `字段 ${field} 最多 10 项`;
      for (const entry of value) {
        if (!isRecord(entry) || typeof entry.provider !== 'string' || entry.provider.length === 0 || entry.provider.length > LIMITS.itemLength) {
          return `字段 ${field} 的每项需要 provider`;
        }
        if (typeof entry.id !== 'string' || entry.id.length === 0 || entry.id.length > LIMITS.idLength) {
          return `字段 ${field} 的每项需要 id（≤${LIMITS.idLength} 字）`;
        }
      }
      return null;
  }
}

// ---------------------------------------------------------------------------
// Service operations
// ---------------------------------------------------------------------------

/** Stale-revision conflict (§14.1): no silent last-write-wins, ever. */
function applyManualValidated(
  store: ProviderStore,
  patch: ManualPatch
): { store: ProviderStore; changed: boolean; conflict?: ConflictDiff } {
  const winner = winnerFor(store, patch.field);
  const currentRevision = winner?.revision ?? 0;
  if (patch.expectedRevision !== undefined && currentRevision !== patch.expectedRevision) {
    return {
      store,
      changed: false,
      conflict: {
        field: patch.field,
        expectedRevision: patch.expectedRevision,
        current: winner
          ? { provider: winner.provider, revision: winner.revision, value: winner.value }
          : null,
      },
    };
  }
  if (patch.value === null) {
    return { store: clearManualField(store, patch.field), changed: true };
  }
  const outcome = applyManualField(store, patch.field, patch.value, {
    expectedRevision: patch.expectedRevision,
  });
  return { store: outcome.store, changed: outcome.changedFields.length > 0 };
}

/**
 * Apply a batch of manual patches. Validation runs on the whole batch
 * first (an invalid patch writes nothing); revision conflicts are
 * collected so the UI gets every field's diff in one round-trip.
 */
export function saveManualEdits(
  repo: EditorRepoSurface,
  itemId: number,
  patches: ManualPatch[]
): EditorResult {
  if (!Number.isInteger(itemId) || itemId <= 0) {
    return { ok: false, code: 'VALIDATION_FAILED', message: '条目 ID 无效' };
  }
  // Whole-batch validation before any write.
  for (const patch of patches) {
    if (!patch || typeof patch.field !== 'string') {
      return { ok: false, code: 'VALIDATION_FAILED', message: '补丁格式无效' };
    }
    if (patch.value !== null) {
      const problem = validateEditableValue(patch.field, patch.value);
      if (problem) return { ok: false, code: 'VALIDATION_FAILED', message: problem };
    } else if (!EDITABLE_FIELDS[patch.field]) {
      return { ok: false, code: 'VALIDATION_FAILED', message: `字段 ${patch.field} 不可编辑` };
    }
  }

  const store = loadItemStore(repo, itemId);
  let next = store;
  const changed: string[] = [];
  const cleared: string[] = [];
  const conflicts: ConflictDiff[] = [];

  for (const patch of patches) {
    const before = winnerFor(next, patch.field);
    let result;
    try {
      result = applyManualValidated(next, patch);
    } catch (err) {
      if (err instanceof MetadataConflictError) {
        conflicts.push({
          field: patch.field,
          expectedRevision: err.expectedRevision,
          current: err.current
            ? { provider: err.current.provider, revision: err.current.revision, value: err.current.value }
            : null,
        });
        continue;
      }
      throw err;
    }
    if (result.conflict) {
      conflicts.push(result.conflict);
      continue;
    }
    next = result.store;
    if (!result.changed) continue;
    if (patch.value === null && before?.provider === 'manual') cleared.push(patch.field);
    else if (patch.value !== null) changed.push(patch.field);
  }

  if (conflicts.length > 0) {
    return { ok: false, code: 'CONFLICT', message: '字段已被其他修改更新，请刷新后重试', conflicts };
  }

  // Only fields the patch actually touched are persisted (sparse writes
  // never erase sibling provider slots). Cleared manual slots are deleted
  // outright so the source value wins again on the next load.
  for (const field of new Set([...changed, ...cleared])) {
    if (next[field]?.manual) {
      repo.upsertMetadataSource(itemId, field, 'manual', next[field]!.manual!.value);
    } else {
      repo.deleteMetadataSource(itemId, field, 'manual');
    }
  }

  return { ok: true, changed, cleared };
}

/**
 * Per-field restore / remove-all-manual (§14.1: 逐字段恢复和整体移除).
 * Restoring deletes the manual slot so the source value (nfo/scraper/
 * filename) becomes the winner again.
 */
export function restoreManualFields(
  repo: EditorRepoSurface,
  itemId: number,
  fields?: string[]
): { ok: true; cleared: string[] } {
  const known = new Set(
    repo
      .listMetadataSources(itemId)
      .filter((row) => row.provider === 'manual')
      .map((row) => row.field)
  );
  const targets = fields ? fields.filter((f) => known.has(f)) : [...known];
  // Deleting the row restores the source value immediately: the next
  // loadItemStore simply finds nfo/scraper/filename as the winner.
  for (const field of targets) {
    repo.deleteMetadataSource(itemId, field, 'manual');
  }
  return { ok: true, cleared: targets };
}
