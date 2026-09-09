import { realpathSync } from 'node:fs';
import { join, normalize } from 'path';
import type Database from 'better-sqlite3';
import { createCatalogRepository } from './repository';

/**
 * Idempotent migration of phase-1 local playback progress into the unified
 * catalog (ADR-0001 D4, plan §5).
 *
 * - Runs only for a mounted source (library_sources row), after the scanner
 *   has created catalog_files entries.
 * - Matches legacy local_media paths against catalog files by normalized path
 *   and realpath (the latter wins when the file is reachable).
 * - Conflicts resolve toward the record with the newer updated_at; invalid
 *   legacy rows (position 0 and not finished) are skipped.
 * - Legacy rows are NEVER deleted: the old tables remain the rollback path
 *   until a migration has been verified in production.
 */

export interface LegacyProgressResult {
  /** Legacy playback_progress rows (global local rows) considered for matching. */
  scanned: number;
  /** Legacy rows linked to at least one catalog item in this source. */
  matched: number;
  /** Rows written into catalog_user_state. */
  migrated: number;
  /** Rows intentionally not applied (invalid or older than catalog state). */
  skipped: number;
}

interface LegacyRow {
  local_media_id: number;
  path: string | null;
  position: number;
  duration: number | null;
  is_finished: number;
  updated_at: number | null;
  file_size: number | null;
}

function pathKeys(absPath: string): Set<string> {
  const keys = new Set<string>();
  if (!absPath) return keys;
  const normalized = normalize(absPath);
  keys.add(normalized);
  try {
    // Realpath wins when reachable: it survives symlinked roots and case
    // differences that normalize() alone cannot resolve.
    keys.add(realpathSync.native(normalized));
  } catch {
    // Offline file: normalized-path matching still applies.
  }
  return keys;
}

/** A stored relative_path must stay inside its source root (plan §8.2). */
function isSafeRelativePath(relativePath: string): boolean {
  if (!relativePath || relativePath.includes('\0')) return false;
  const segments = normalize(relativePath).split('/');
  return !segments.includes('..') && !segments.includes('');
}

function isLegacyValid(row: LegacyRow): boolean {
  return row.is_finished === 1 || row.position > 0;
}

function betterLegacy(candidate: LegacyRow, incumbent: LegacyRow, fileSize: number | null): boolean {
  if (fileSize !== null && candidate.file_size !== null) {
    const candidateSizeMatch = candidate.file_size === fileSize;
    const incumbentSizeMatch = incumbent.file_size === fileSize;
    if (candidateSizeMatch !== incumbentSizeMatch) return candidateSizeMatch;
  }
  if ((candidate.updated_at ?? 0) !== (incumbent.updated_at ?? 0)) {
    return (candidate.updated_at ?? 0) > (incumbent.updated_at ?? 0);
  }
  // Fully tied (same size class and same second): pick the lower legacy id so
  // the result never depends on map iteration order.
  return candidate.local_media_id < incumbent.local_media_id;
}

export function migrateLegacyProgressForSource(
  db: Database.Database,
  sourceId: number
): LegacyProgressResult {
  const source = db.prepare('SELECT root FROM library_sources WHERE id = ?').get(sourceId) as
    | { root: string }
    | undefined;
  if (!source) return { scanned: 0, matched: 0, migrated: 0, skipped: 0 };

  const repo = createCatalogRepository(db);
  const legacyRows = db
    .prepare(
      `SELECT p.local_media_id, lm.path, p.position, p.duration, p.is_finished, p.updated_at, lm.file_size
       FROM playback_progress p
       JOIN local_media lm ON p.local_media_id = lm.id
       WHERE p.media_type = 'local'`
    )
    .all() as LegacyRow[];
  const scanned = legacyRows.filter((row) => row.path).length;

  // Keep ALL rows per path key; the best one is chosen per file later, when
  // the file's size is known (size match outranks recency).
  const legacyByKey = new Map<string, LegacyRow[]>();
  for (const row of legacyRows) {
    if (!row.path) continue;
    for (const key of pathKeys(row.path)) {
      const bucket = legacyByKey.get(key);
      if (bucket) bucket.push(row);
      else legacyByKey.set(key, [row]);
    }
  }

  // One user state per item: pick the best legacy row across all files of
  // the item (files iterate in deterministic relative_path order).
  const bestPerItem = new Map<number, LegacyRow>();
  let skipped = 0;

  for (const file of repo.listFilesBySource(sourceId)) {
    if (!isSafeRelativePath(file.relative_path)) {
      // Data corruption guard (plan §8.2): never resolve outside the root.
      skipped += 1;
      continue;
    }
    const keys = pathKeys(join(source.root, file.relative_path));
    let best: LegacyRow | undefined;
    for (const key of keys) {
      for (const candidate of legacyByKey.get(key) ?? []) {
        if (!best || betterLegacy(candidate, best, file.size)) best = candidate;
      }
    }
    if (!best) continue;
    if (bestPerItem.has(file.item_id)) {
      // An alternate legacy row for an item that already matched.
      skipped += 1;
      continue;
    }
    bestPerItem.set(file.item_id, best);
  }

  let migrated = 0;
  for (const [itemId, best] of bestPerItem) {
    if (!isLegacyValid(best)) {
      skipped += 1;
      continue;
    }

    const existing = repo.getUserState(itemId);
    if (existing) {
      const legacyTime = best.updated_at ?? 0;
      const catalogTime = existing.updated_at ?? 0;
      // Strictly newer wins; ties keep the catalog state so repeated runs
      // converge instead of flip-flopping.
      if (legacyTime <= catalogTime) {
        skipped += 1;
        continue;
      }
    }

    repo.upsertUserState({
      itemId,
      position: best.position,
      duration: best.duration ?? undefined,
      isFinished: best.is_finished === 1,
    });
    migrated += 1;
  }

  return { scanned, matched: bestPerItem.size, migrated, skipped };
}
