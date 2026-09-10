import type { SourceAdapter, SourceEntry, ScanDriver } from '../library-sources/types';
import type { CatalogFileRow, CatalogRepository } from '../catalog/repository';
import { classifyPath, normalizeNameKey, type Classification } from './classifier';

/**
 * Local media scanner core (plan §6, QYP2-009).
 *
 * - `walkSourceTree` turns a one-level adapter listing into a deterministic
 *   depth-first recursive walk (async iteration only, never readdirSync).
 * - `createLocalScanDriver` classifies + upserts entries with a fingerprint
 *   (size:mtime) so unchanged files skip all rework on later scans.
 * - `markAvailabilityAfterScan` downgrades availability to 'missing' ONLY
 *   after a successful full scan (plan §6.1) — never on failure, cancel,
 *   resume/partial runs, or an empty seen-set.
 */

export const DEFAULT_MAX_ENTRIES = 100_000;
export const DEFAULT_MAX_DEPTH = 32;

export interface WalkOptions {
  maxEntries?: number;
  maxDepth?: number;
}

interface WalkState {
  count: number;
  resuming: boolean;
  cursor: string;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    const err = new Error('Scan cancelled');
    err.name = 'AbortError';
    throw err;
  }
}

async function* walkDir(
  adapter: SourceAdapter,
  dir: string,
  depth: number,
  state: WalkState,
  opts: Required<WalkOptions>,
  signal: AbortSignal
): AsyncGenerator<SourceEntry> {
  if (depth > opts.maxDepth) {
    throw new Error(`目录层级超过上限 ${opts.maxDepth}，扫描终止（不会标记缺失）`);
  }
  const entries: SourceEntry[] = [];
  for await (const entry of adapter.list(dir, signal)) {
    throwIfAborted(signal);
    entries.push(entry);
  }
  // Deterministic order: the resume cursor ("skip until path === cursor")
  // and the movie-group flush-on-dir-change logic both rely on it.
  entries.sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0));
  for (const entry of entries) {
    state.count += 1;
    if (state.count > opts.maxEntries) {
      // Hard failure, not silent truncation: silent truncation could mark
      // the skipped subtree as missing after a "successful" run.
      throw new Error(`扫描条目超过上限 ${opts.maxEntries}，扫描终止（不会标记缺失）`);
    }
    if (state.resuming) {
      if (entry.relativePath === state.cursor) state.resuming = false;
      continue;
    }
    yield entry;
    if (entry.isDirectory) {
      yield* walkDir(adapter, entry.relativePath, depth + 1, state, opts, signal);
    }
  }
}

/**
 * Recursive traversal over any adapter. `startPath` doubles as a resume
 * cursor (plan §6.1): when non-empty, every entry up to and including that
 * exact path is skipped; if the cursor no longer exists the walk restarts
 * from the beginning (safe: full coverage beats a partial walk).
 */
export async function* walkSourceTree(
  adapter: SourceAdapter,
  startPath: string,
  signal: AbortSignal,
  options: WalkOptions = {}
): AsyncGenerator<SourceEntry> {
  const opts: Required<WalkOptions> = {
    maxEntries: options.maxEntries ?? DEFAULT_MAX_ENTRIES,
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
  };
  const state: WalkState = { count: 0, resuming: startPath !== '', cursor: startPath };
  yield* walkDir(adapter, startPath || '', 0, state, opts, signal);
}

interface BufferedCandidate {
  entry: SourceEntry;
  parsed: Classification;
}

export interface LocalScanDriver extends ScanDriver {
  /** Video files seen in this run (for availability finalization). */
  readonly seen: ReadonlySet<string>;
}

/**
 * Driver factory. Note `maxEntries` must stay aligned with the job
 * controller's cap so the walker fails the run before the controller
 * silently drops entries (R3).
 */
export function createLocalScanDriver(deps: {
  repo: CatalogRepository;
  sourceId: number;
}): LocalScanDriver {
  const { repo, sourceId } = deps;
  // Existing files snapshot: cheap in-driver change detection without extra
  // repository queries per entry.
  const filesIndex = new Map<string, Pick<CatalogFileRow, 'fingerprint'>>(
    repo.listFilesBySource(sourceId).map((f) => [f.relative_path, { fingerprint: f.fingerprint }])
  );
  const seen = new Set<string>();
  const driver: LocalScanDriver = {
    seen,

    async index(entry, signal) {
      throwIfAborted(signal);
      if (entry.isDirectory) return;
      const parsed = classifyPath(entry.relativePath);
      // NFO/sidecar/ignored files are recognized but not indexed; NFO and
      // sidecar metadata consumption arrives with QYP2-010.
      if (parsed.fileClass !== 'video' || parsed.isSample) return;

      seen.add(entry.relativePath);
      const fingerprint =
        entry.size !== undefined && entry.mtime !== undefined
          ? `${entry.size}:${Math.round(entry.mtime)}`
          : undefined;
      const existing = filesIndex.get(entry.relativePath);
      // Incremental skip: identical size+mtime means nothing changed, so no
      // re-upsert and (later) no re-enrichment for this file.
      if (existing && fingerprint && existing.fingerprint === fingerprint) return;

      if (parsed.episode) {
        const e = parsed.episode;
        const seriesKey = `series:${normalizeNameKey(e.seriesTitle)}`;
        const seriesId = repo.upsertItem({
          sourceId,
          sourceKey: seriesKey,
          kind: 'series',
          title: e.seriesTitle,
        });
        const seasonKey = `${seriesKey}:s${e.season}`;
        const seasonId = repo.upsertItem({
          sourceId,
          sourceKey: seasonKey,
          parentId: seriesId,
          kind: 'season',
          seasonNumber: e.season,
          title: e.season === 0 ? '特别篇' : `第 ${e.season} 季`,
        });
        const episodeId = repo.upsertItem({
          sourceId,
          sourceKey: `${seriesKey}:s${e.season}e${e.episode}`,
          parentId: seasonId,
          kind: 'episode',
          seasonNumber: e.season,
          episodeNumber: e.episode,
          ...(e.episodeTitle ? { title: e.episodeTitle } : {}),
        });
        repo.upsertFile({
          sourceId,
          itemId: episodeId,
          relativePath: entry.relativePath,
          size: entry.size,
          mtime: entry.mtime,
          fingerprint,
        });
      } else {
        // Movie/video candidate: group per directory, choose the main file
        // by size + extras markers (never "first file"), attach extras,
        // drop samples. DFS order keeps a directory's files contiguous.
        const dir = entry.relativePath.includes('/')
          ? entry.relativePath.slice(0, entry.relativePath.lastIndexOf('/'))
          : '';
        if (dir !== bufferedDir) {
          flushGroup();
          bufferedDir = dir;
        }
        buffer.push({ entry, parsed });
      }
      filesIndex.set(entry.relativePath, { fingerprint: fingerprint ?? null });
    },

    // The controller's enrich phase provides the end-of-indexing hook for
    // the trailing movie group. When NFO enrichment lands (QYP2-010) this
    // grows into the real enrichment pass; unchanged files still skip it
    // thanks to the fingerprint gate in `index`.
    async enrich() {
      flushGroup();
    },
  };

  let bufferedDir: string | null = null;
  let buffer: BufferedCandidate[] = [];

  function flushGroup(): void {
    if (buffer.length === 0) {
      bufferedDir = null;
      return;
    }
    const candidates = buffer.filter((c) => !c.parsed.isExtra);
    const extras = buffer.filter((c) => c.parsed.isExtra);
    buffer = [];
    bufferedDir = null;
    if (candidates.length === 0) return; // extras-only directory: nothing to index
    // Main file: largest non-extra (size unknown counts as 0).
    const main = candidates.reduce((a, b) => ((b.entry.size ?? 0) > (a.entry.size ?? 0) ? b : a));
    const title = main.parsed.movie?.title ?? main.parsed.videoTitle ?? '';
    const year = main.parsed.movie?.year;
    const itemId =
      main.parsed.confidence === 'high' && main.parsed.movie
        ? repo.upsertItem({
            sourceId,
            sourceKey: `movie:${normalizeNameKey(title)}${year ? `:${year}` : ''}`,
            kind: 'movie',
            title,
            year,
          })
        : // Low-confidence content keeps its own path-based identity; it
          // can be reclassified manually later (plan §6.2).
          repo.upsertItem({
            sourceId,
            sourceKey: `video:${main.entry.relativePath}`,
            kind: 'video',
            title,
          });
    for (const c of [...candidates, ...extras]) {
      const fp =
        c.entry.size !== undefined && c.entry.mtime !== undefined
          ? `${c.entry.size}:${Math.round(c.entry.mtime)}`
          : undefined;
      repo.upsertFile({
        sourceId,
        itemId,
        relativePath: c.entry.relativePath,
        size: c.entry.size,
        mtime: c.entry.mtime,
        fingerprint: fp,
      });
    }
  }

  return driver;
}

/**
 * Availability finalization (plan §6.1): only after a *successful full*
 * scan may items be downgraded to 'missing'. Guards:
 * - `fullScan === false` (resumed/partial run): never mark.
 * - `seen.size === 0`: conservative no-op (protects against the
 *   deleted-cursor resume edge producing an empty walk).
 * Missing items are retained (history + manual metadata stay queryable);
 * the 30-day retention sweep is a later task.
 */
export function markAvailabilityAfterScan(
  repo: CatalogRepository,
  sourceId: number,
  seen: ReadonlySet<string>,
  options: { fullScan: boolean }
): void {
  if (!options.fullScan || seen.size === 0) return;
  const items = repo.listItemsBySource(sourceId);
  if (items.length === 0) return;
  const files = repo.listFilesBySource(sourceId);
  const onlineByItem = new Map<number, boolean>();
  for (const file of files) {
    if (seen.has(file.relative_path)) onlineByItem.set(file.item_id, true);
    else if (!onlineByItem.has(file.item_id)) onlineByItem.set(file.item_id, false);
  }
  const itemById = new Map(items.map((item) => [item.id, item]));
  const online = new Set<number>();
  for (const [itemId, isOnline] of onlineByItem) {
    if (!isOnline) continue;
    online.add(itemId);
    let parent: number | null = itemById.get(itemId)?.parent_id ?? null;
    while (parent !== null) {
      online.add(parent);
      parent = itemById.get(parent)?.parent_id ?? null;
    }
  }
  for (const item of items) {
    repo.setAvailability(item.id, online.has(item.id) ? 'online' : 'missing');
  }
}
