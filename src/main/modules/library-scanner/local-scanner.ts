import type { SourceAdapter, SourceEntry, ScanDriver } from '../library-sources/types';
import type { CatalogFileRow, CatalogRepository } from '../catalog/repository';
import { classifyPath, normalizeNameKey, type Classification } from './classifier';
import { decodeNfoBuffer, parseNfoXml, NfoParseError } from '../metadata/nfo-parser';
import { applyNfoMetadata } from '../metadata/metadata-merger';
import type { MetadataValue, NfoMetadata, ProviderStore } from '../metadata/types';

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

async function* walkDirOnce(
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
      yield* walkDirOnce(adapter, entry.relativePath, depth + 1, state, opts, signal);
    }
  }
}

async function* walkDir(
  adapter: SourceAdapter,
  state: WalkState,
  opts: Required<WalkOptions>,
  signal: AbortSignal
): AsyncGenerator<SourceEntry> {
  yield* walkDirOnce(adapter, '', 0, state, opts, signal);
  if (state.resuming) {
    // Cursor vanished (path deleted/renamed since the interrupted run):
    // a skipped-everything walk must not be mistaken for an empty source.
    // Restart from the root with resume disabled — full coverage is the
    // safe outcome; the duplicate work is bounded by the entry cap.
    state.resuming = false;
    state.cursor = '';
    state.count = 0;
    yield* walkDirOnce(adapter, '', 0, state, opts, signal);
  }
}

/**
 * Recursive traversal over any adapter, always starting at the source root.
 * The controller passes the resume cursor as `startPath` (plan §6.1): when
 * non-empty, entries up to and including that exact path are skipped; if
 * the cursor no longer exists the walk restarts from the beginning (a
 * partially-skipped walk must never masquerade as a complete one).
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
  yield* walkDir(adapter, state, opts, signal);
}

interface BufferedCandidate {
  entry: SourceEntry;
  parsed: Classification;
}

export interface LocalScanDriver extends ScanDriver {
  /** Video files seen in this run (for availability finalization). */
  readonly seen: ReadonlySet<string>;
}

/** filename without extension, lowercased (episode/video NFO matching). */
function stemOf(relativePath: string): string {
  const fileName = relativePath.split('/').pop() ?? relativePath;
  const dot = fileName.lastIndexOf('.');
  return (dot === -1 ? fileName : fileName.slice(0, dot)).toLowerCase();
}

/** Directory of a relative path ('' at root). */
function dirOf(relativePath: string): string {
  return relativePath.includes('/') ? relativePath.slice(0, relativePath.lastIndexOf('/')) : '';
}

/**
 * The series-level directory for an episode path: strip a trailing season
 * segment ("Season 01", "s1", "Specials"); otherwise the episode dir itself.
 */
function seriesDirOf(episodeDir: string): string {
  if (/\/(?:season[\s._-]?\d{1,2}|s\d{1,2}|specials)$/i.test(episodeDir)) {
    return episodeDir.slice(0, episodeDir.lastIndexOf('/'));
  }
  return episodeDir;
}

/**
 * Persist a parsed NFO payload as per-field provenance rows (plan §9.2).
 * Sparse application: fields the NFO does not carry keep their previous
 * values; a parse failure never erases anything.
 */
function persistNfoMetadata(
  repo: CatalogRepository,
  itemId: number,
  meta: NfoMetadata
): void {
  const existing: ProviderStore = {};
  for (const row of repo.listMetadataSources(itemId)) {
    let decoded: unknown = null;
    try {
      decoded = row.value === null ? null : JSON.parse(row.value);
    } catch {
      decoded = row.value; // non-JSON legacy row: kept as plaintext
    }
    const slot = existing[row.field] ?? (existing[row.field] = {});
    slot[row.provider as keyof (typeof slot)] = {
      value: decoded as MetadataValue,
      revision: row.revision,
      updatedAt: row.updated_at ?? 0,
    };
  }
  const outcome = applyNfoMetadata(existing, meta);
  for (const field of outcome.changedFields) {
    const slot = outcome.store[field]?.nfo;
    if (slot) repo.upsertMetadataSource(itemId, field, 'nfo', slot.value);
  }
}

/**
 * Driver factory. Note `maxEntries` must stay aligned with the job
 * controller's cap so the walker fails the run before the controller
 * silently drops entries (R3).
 */
export function createLocalScanDriver(deps: {
  repo: CatalogRepository;
  sourceId: number;
  /**
   * Containment-checked NFO content reader (wired by the IPC layer through
   * the source adapter). When absent, NFO files are skipped silently.
   */
  readNfo?: (relativePath: string, signal: AbortSignal) => Promise<Buffer>;
  /**
   * Fingerprint hook (QYP2-014): WebDAV prefers `etag:<etag>` and falls
   * back to the local size:mtime format. Defaults to local behavior.
   */
  fingerprintOf?: (entry: SourceEntry) => string | undefined;
}): LocalScanDriver {
  const { repo, sourceId } = deps;
  // Existing files snapshot: cheap in-driver change detection without extra
  // repository queries per entry.
  const filesIndex = new Map<string, Pick<CatalogFileRow, 'fingerprint'>>(
    repo.listFilesBySource(sourceId).map((f) => [f.relative_path, { fingerprint: f.fingerprint }])
  );
  const seen = new Set<string>();
  // NFO enrichment state (per run): "<dir>:<stem>" → itemId (dir-qualified:
  // same-named videos in different directories must never cross-match);
  // dir-keyed payloads for movie.nfo / tvshow.nfo / season.nfo; dir → item
  // registrations so late-arriving NFOs (DFS sort order) still find their
  // series/season items.
  const stemItem = new Map<string, number>();
  const seriesItemByDir = new Map<string, number>();
  const seasonItemByDir = new Map<string, number>();
  const dirMovieNfo = new Map<string, NfoMetadata>();
  const dirShowNfo = new Map<string, NfoMetadata>();
  const dirSeasonNfo = new Map<string, NfoMetadata>();
  // Stem-keyed NFOs whose video item does not exist yet (movie groups flush
  // on directory change, so "intro.nfo" can precede "intro.mkv"'s item).
  const pendingStemNfo = new Map<string, NfoMetadata>();

  async function enrichFromNfo(relativePath: string, signal: AbortSignal): Promise<void> {
    if (!deps.readNfo) return;
    const fileName = relativePath.split('/').pop() ?? relativePath;
    const dir = relativePath.includes('/') ? relativePath.slice(0, relativePath.lastIndexOf('/')) : '';
    const stem = fileName.replace(/\.nfo$/i, '').toLowerCase();
    try {
      const meta = parseNfoXml(decodeNfoBuffer(await deps.readNfo(relativePath, signal)));
      let target: number | undefined;
      if (meta.kind === 'tvshow') {
        target = seriesItemByDir.get(dir);
        if (target === undefined) dirShowNfo.set(dir, meta);
      } else if (meta.kind === 'season') {
        target = seasonItemByDir.get(dir);
        if (target === undefined) dirSeasonNfo.set(dir, meta);
      } else if (stem === 'movie') {
        // Applied to the movie group at flush time (same dir).
        dirMovieNfo.set(dir, meta);
      } else {
        target = stemItem.get(`${dir}:${stem}`);
        if (target === undefined) pendingStemNfo.set(`${dir}:${stem}`, meta);
      }
      if (target !== undefined) persistNfoMetadata(repo, target, meta);
    } catch (err) {
      // Plan §9.2: a bad NFO never erases metadata; record and continue.
      console.error(
        '[NFO] 解析失败（保留旧值）:', relativePath,
        err instanceof NfoParseError ? err.message : err instanceof Error ? err.message : err
      );
    }
  }

  const fingerprintFor = (entry: SourceEntry): string | undefined =>
    deps.fingerprintOf
      ? deps.fingerprintOf(entry)
      : entry.size !== undefined && entry.mtime !== undefined
        ? `${entry.size}:${Math.floor(entry.mtime)}`
        : undefined;

  const driver: LocalScanDriver = {
    seen,

    async index(entry, signal) {
      throwIfAborted(signal);
      if (entry.isDirectory) return;
      const parsed = classifyPath(entry.relativePath);
      if (parsed.fileClass === 'nfo') {
        await enrichFromNfo(entry.relativePath, signal);
        return;
      }
      // Other sidecar/ignored files are recognized but not indexed; image
      // sidecar display is a later task.
      if (parsed.fileClass !== 'video' || parsed.isSample) return;

      seen.add(entry.relativePath);
      // Default fingerprint is size + mtime (ms). mtime is floored to an
      // integer for stability; if an adapter ever reports seconds the
      // format must be bumped so old fingerprints do not silently match.
      // WebDAV overrides this with the etag-preferring hook (plan §6.1).
      const fingerprint = fingerprintFor(entry);
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
        // Register for tvshow.nfo lookups (series dir = parent of the
        // season dir, or the episode's own dir when there is none).
        const episodeDir = dirOf(entry.relativePath);
        const seriesDir = seriesDirOf(episodeDir);
        seriesItemByDir.set(seriesDir, seriesId);
        const pendingShow = dirShowNfo.get(seriesDir);
        if (pendingShow) {
          dirShowNfo.delete(seriesDir);
          persistNfoMetadata(repo, seriesId, pendingShow);
        }
        const seasonKey = `${seriesKey}:s${e.season}`;
        const seasonId = repo.upsertItem({
          sourceId,
          sourceKey: seasonKey,
          parentId: seriesId,
          kind: 'season',
          seasonNumber: e.season,
          title: e.season === 0 ? '特别篇' : `第 ${e.season} 季`,
        });
        seasonItemByDir.set(episodeDir, seasonId);
        const pendingSeason = dirSeasonNfo.get(episodeDir);
        if (pendingSeason) {
          dirSeasonNfo.delete(episodeDir);
          persistNfoMetadata(repo, seasonId, pendingSeason);
        }
        const episodeId = repo.upsertItem({
          sourceId,
          sourceKey: `${seriesKey}:s${e.season}e${e.episode}`,
          parentId: seasonId,
          kind: 'episode',
          seasonNumber: e.season,
          episodeNumber: e.episode,
          ...(e.episodeTitle ? { title: e.episodeTitle } : {}),
        });
        stemItem.set(`${dirOf(entry.relativePath)}:${stemOf(entry.relativePath)}`, episodeId);
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
    // the trailing movie group; the idempotent guard keeps the per-entry
    // call pattern cheap (first call finalizes, the rest are no-ops).
    // When NFO enrichment lands (QYP2-010) this grows into the real
    // enrichment pass; unchanged files still skip it thanks to the
    // fingerprint gate in `index`.
    async enrich() {
      finalizeGroups();
    },
  };

  let bufferedDir: string | null = null;
  let buffer: BufferedCandidate[] = [];
  let finalized = false;

  /** End-of-scan finalize: idempotent, runs at most once. */
  function finalizeGroups(): void {
    if (finalized) return;
    finalized = true;
    flushGroup();
  }

  function flushGroup(): void {
    const groupDir = bufferedDir;
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
    // Grouping (main-file selection + extras attach) only applies when the
    // main candidate is a high-confidence movie. Unrelated low-confidence
    // videos must stay separate items (QYP2-011: five root files are five
    // videos, not one), per-file identity by path (plan §6.2 低置信).
    const isMovieGroup = main.parsed.confidence === 'high' && main.parsed.movie;
    const title = main.parsed.movie?.title ?? main.parsed.videoTitle ?? '';
    const year = main.parsed.movie?.year;

    const attach = (c: BufferedCandidate, targetItem: number): void => {
      const fp = fingerprintFor(c.entry);
      repo.upsertFile({
        sourceId,
        itemId: targetItem,
        relativePath: c.entry.relativePath,
        size: c.entry.size,
        mtime: c.entry.mtime,
        fingerprint: fp,
      });
      // Every attached file's stem can own a matching NFO (dir-qualified).
      const key = `${dirOf(c.entry.relativePath)}:${stemOf(c.entry.relativePath)}`;
      stemItem.set(key, targetItem);
      const pending = pendingStemNfo.get(key);
      if (pending) {
        pendingStemNfo.delete(key);
        persistNfoMetadata(repo, targetItem, pending);
      }
    };

    let primaryItem: number;
    if (isMovieGroup) {
      primaryItem = repo.upsertItem({
        sourceId,
        sourceKey: `movie:${normalizeNameKey(title)}${year ? `:${year}` : ''}`,
        kind: 'movie',
        title,
        year,
      });
      for (const c of [...candidates, ...extras]) attach(c, primaryItem);
    } else {
      // Low-confidence content keeps per-file path-based identity; it can
      // be reclassified manually later (plan §6.2). Extras are dropped.
      primaryItem = repo.upsertItem({
        sourceId,
        sourceKey: `video:${main.entry.relativePath}`,
        kind: 'video',
        title,
      });
      for (const c of candidates) {
        if (c === main) {
          attach(c, primaryItem);
          continue;
        }
        const own = repo.upsertItem({
          sourceId,
          sourceKey: `video:${c.entry.relativePath}`,
          kind: 'video',
          title: c.parsed.videoTitle ?? stemOf(c.entry.relativePath),
        });
        attach(c, own);
      }
    }
    const movieNfo = dirMovieNfo.get(groupDir ?? '');
    if (movieNfo) {
      dirMovieNfo.delete(groupDir ?? '');
      persistNfoMetadata(repo, primaryItem, movieNfo);
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
  // One transaction: a crash mid-pass must not leave a mixed online/missing
  // catalog (plan §6.1 — missing marking is only ever all-or-nothing).
  repo.setAvailabilityBulk(
    items.map((item) => ({ id: item.id, availability: online.has(item.id) ? 'online' : 'missing' }))
  );
}
