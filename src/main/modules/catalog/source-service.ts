import { basename } from 'node:path';
import type Database from 'better-sqlite3';
import { createCatalogRepository } from '../catalog/repository';
import { LocalSourceAdapter } from '../library-sources/local-source';
import type { SourceAdapter } from '../library-sources/types';

/**
 * Source lifecycle service (plan §7, QYP2-007).
 *
 * The renderer may only hand over a path obtained from the Electron
 * directory picker. Everything else (canonicalization, validation,
 * containment) happens here, in the main process.
 */

export interface CreatedSource {
  sourceId: number;
  /** Canonical root actually stored (may differ from the picked path). */
  root: string;
  name: string;
}

/** Create a local source from a picker-provided directory. */
export function createLocalSourceFromSelection(
  db: Database.Database,
  selectedPath: string,
  options: { name?: string } = {}
): CreatedSource {
  const root = LocalSourceAdapter.canonicalizeRoot(selectedPath);
  const repo = createCatalogRepository(db);
  const sourceId = repo.createSource({
    kind: 'local',
    name: options.name?.trim() || basename(root),
    root,
    readOnly: true, // plan §14.2: deletion stays disabled by default
  });
  return { sourceId, root, name: options.name?.trim() || basename(root) };
}

/**
 * Remove a source and its index. The underlying media is NEVER touched:
 * catalog rows go away through FK cascades, files stay on disk.
 */
export function removeSource(db: Database.Database, sourceId: number): void {
  const repo = createCatalogRepository(db);
  const source = repo.getSource(sourceId);
  if (!source) throw new Error('来源不存在');
  repo.deleteSource(sourceId);
}

/** Build the adapter for a stored source; throws if the kind is unknown. */
export function getAdapterForSource(
  db: Database.Database,
  sourceId: number
): { adapter: SourceAdapter; root: string } {
  const repo = createCatalogRepository(db);
  const source = repo.getSource(sourceId);
  if (!source) throw new Error('来源不存在');
  if (source.kind !== 'local') {
    throw new Error(`暂不支持该来源类型: ${source.kind}`);
  }
  return {
    adapter: LocalSourceAdapter.fromSource(sourceId, source.root),
    root: source.root,
  };
}

/** Cheap health probe used by the settings UI and home health summary. */
export async function checkSourceHealth(
  db: Database.Database,
  sourceId: number,
  signal: AbortSignal = new AbortController().signal
): Promise<'ok' | 'degraded' | 'offline' | 'auth-required' | 'unscanned'> {
  const { adapter } = getAdapterForSource(db, sourceId);
  try {
    await adapter.testConnection(signal);
    return 'ok';
  } catch {
    return 'offline';
  }
}
