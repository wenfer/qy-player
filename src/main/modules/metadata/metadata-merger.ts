/**
 * Metadata field merger (plan §9.2, QYP2-010).
 *
 * Pure data transforms over a ProviderStore (field → provider → value).
 * Fixed priority: manual > nfo > scraper > filename. Writes never erase:
 * a partial payload only touches the fields it actually carries, and a
 * locked (manual-winner) field is skipped entirely on re-scan.
 */

import type {
  FieldWinner,
  MergeOutcome,
  MetadataProvider,
  MetadataValue,
  NfoMetadata,
  ProviderStore,
  ProviderValue,
} from './types';
import { PROVIDER_PRIORITY } from './types';

export { PROVIDER_PRIORITY };
export type { ProviderStore } from './types';

/** The displayed value of a field: highest-priority provider slot present. */
export function winnerFor(store: ProviderStore, field: string): FieldWinner | null {
  const slots = store[field];
  if (!slots) return null;
  for (const provider of PROVIDER_PRIORITY) {
    const slot = slots[provider];
    if (slot) {
      return { field, value: slot.value, provider, revision: slot.revision, updatedAt: slot.updatedAt };
    }
  }
  return null;
}

function deepEqual(a: MetadataValue, b: MetadataValue): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Apply one provider's field payload. Fields the payload does not carry are
 * left untouched (sparse NFO keeps previous values; parse failures simply
 * never call this). Locked fields (manual winner) are skipped and reported.
 */
export function applyProviderFields(
  store: ProviderStore,
  provider: MetadataProvider,
  fields: Record<string, MetadataValue | undefined>,
  options: { now?: number } = {}
): MergeOutcome {
  const now = options.now ?? Date.now();
  const next: ProviderStore = { ...store };
  const changedFields: string[] = [];
  const skippedLockedFields: string[] = [];

  for (const [field, rawValue] of Object.entries(fields)) {
    if (rawValue === undefined) continue;
    const winner = winnerFor(next, field);
    if (winner?.provider === 'manual') {
      // Plan §9.2: re-scans and scrapes only update non-locked fields.
      // The raw NFO slot is also left frozen so unlocking restores the
      // state the user originally saw.
      skippedLockedFields.push(field);
      continue;
    }
    const slots = { ...next[field] };
    const existing: ProviderValue | undefined = slots[provider];
    if (existing && deepEqual(existing.value, rawValue)) continue;
    slots[provider] = {
      value: rawValue,
      revision: (existing?.revision ?? 0) + 1,
      updatedAt: now,
    };
    next[field] = slots;
    changedFields.push(field);
  }
  return { store: next, changedFields, skippedLockedFields };
}

/** NFO payload → field map, then applied at 'nfo' priority. */
export function applyNfoMetadata(
  store: ProviderStore,
  meta: NfoMetadata,
  options: { now?: number } = {}
): MergeOutcome {
  const fields: Record<string, MetadataValue | undefined> = {
    ...(meta.title ? { title: meta.title } : {}),
    ...(meta.originalTitle ? { originalTitle: meta.originalTitle } : {}),
    ...(meta.sortTitle ? { sortTitle: meta.sortTitle } : {}),
    ...(meta.year !== undefined ? { year: meta.year } : {}),
    ...(meta.premiered ? { premiered: meta.premiered } : {}),
    ...(meta.plot ? { plot: meta.plot } : {}),
    ...(meta.tagline ? { tagline: meta.tagline } : {}),
    ...(meta.runtime !== undefined ? { runtime: meta.runtime } : {}),
    ...(meta.rating !== undefined ? { rating: meta.rating } : {}),
    ...(meta.contentRating ? { contentRating: meta.contentRating } : {}),
    ...(meta.genres.length > 0 ? { genres: meta.genres } : {}),
    ...(meta.studios.length > 0 ? { studios: meta.studios } : {}),
    ...(meta.countries.length > 0 ? { countries: meta.countries } : {}),
    ...(meta.actors.length > 0 ? { actors: meta.actors } : {}),
    ...(meta.directors.length > 0 ? { directors: meta.directors } : {}),
    ...(meta.season !== undefined ? { season: meta.season } : {}),
    ...(meta.episode !== undefined ? { episode: meta.episode } : {}),
    ...(meta.uniqueIds.length > 0 ? { uniqueIds: meta.uniqueIds } : {}),
    ...(meta.thumbs.length > 0 ? { thumbs: meta.thumbs } : {}),
    ...(meta.set ? { set: meta.set } : {}),
  };
  return applyProviderFields(store, 'nfo', fields, options);
}

/** Fields whose winner is a manual override (used to lock UI editing). */
export function manualLockedFields(store: ProviderStore): Set<string> {
  const locked = new Set<string>();
  for (const field of Object.keys(store)) {
    if (winnerFor(store, field)?.provider === 'manual') locked.add(field);
  }
  return locked;
}

/** Thrown when a manual edit loses a revision race (14.1: no silent LWW). */
export class MetadataConflictError extends Error {
  readonly field: string;
  readonly expectedRevision: number;
  readonly current: FieldWinner | null;

  constructor(field: string, expectedRevision: number, current: FieldWinner | null) {
    super(`字段 ${field} 的 revision 已变化（期望 ${expectedRevision}，当前 ${current?.revision ?? '无'}）`);
    this.name = 'MetadataConflictError';
    this.field = field;
    this.expectedRevision = expectedRevision;
    this.current = current;
  }
}

/**
 * Manual override. With `expectedRevision`, the winner's revision must
 * match; otherwise a conflict is thrown carrying both sides so the UI can
 * render a diff (plan §14.1 — last-write-wins is forbidden).
 */
export function applyManualField(
  store: ProviderStore,
  field: string,
  value: MetadataValue,
  options: { expectedRevision?: number; now?: number } = {}
): MergeOutcome {
  const now = options.now ?? Date.now();
  const winner = winnerFor(store, field);
  if (options.expectedRevision !== undefined && winner?.revision !== options.expectedRevision) {
    throw new MetadataConflictError(field, options.expectedRevision, winner);
  }
  const slots = { ...store[field] };
  const existing = slots.manual;
  if (existing && deepEqual(existing.value, value)) {
    return { store, changedFields: [], skippedLockedFields: [] };
  }
  slots.manual = { value, revision: (existing?.revision ?? 0) + 1, updatedAt: now };
  return {
    store: { ...store, [field]: slots },
    changedFields: [field],
    skippedLockedFields: [],
  };
}

/** Remove a manual override entirely (14.1: 恢复来源值). */
export function clearManualField(store: ProviderStore, field: string): ProviderStore {
  const slots = { ...store[field] };
  delete slots.manual;
  const next = { ...store };
  if (Object.keys(slots).length === 0) delete next[field];
  else next[field] = slots;
  return next;
}
