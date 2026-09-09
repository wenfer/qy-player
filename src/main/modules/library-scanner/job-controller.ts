import type { ScanProgressEvent } from '../../../shared/types';
import type { CatalogRepository, ScanRunStatus } from '../catalog/repository';
import type { SourceAdapter, SourceEntry, ScanDriver } from '../library-sources/types';

/**
 * Scan job controller (plan §6.1, QYP2-006).
 *
 * Owns the phase state machine, bounded concurrency, persistence of run
 * progress (scan_runs), cancel/interrupt semantics and event throttling
 * (<= 4Hz towards renderers). Source-specific work lives in the injected
 * adapter + ScanDriver, never here.
 */

export const SCAN_EVENT_INTERVAL_MS = 250; // <= 4Hz (plan §16.4)

const NON_TERMINAL_STATUSES: ScanRunStatus[] = ['queued', 'discovering', 'indexing', 'enriching'];

function isTerminal(status: ScanRunStatus): boolean {
  return !NON_TERMINAL_STATUSES.includes(status);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    const err = new Error('Scan cancelled');
    err.name = 'AbortError';
    throw err;
  }
}

/** Replace private details (source root, absolute paths) in error messages. */
export function sanitizeScanError(message: string, root: string): string {
  const flattened = message.replace(/\s+/g, ' ').trim();
  const withoutRoot = root ? flattened.split(root).join('<source>') : flattened;
  return withoutRoot.slice(0, 300);
}

/** Run a worker over all items with at most `concurrency` in flight. */
export async function runBounded<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, signal: AbortSignal) => Promise<void>,
  signal: AbortSignal,
  onProgress?: () => void
): Promise<void> {
  let next = 0;
  let active = 0;
  await new Promise<void>((resolve, reject) => {
    const launch = (): void => {
      if (signal.aborted) {
        if (active === 0) resolve();
        return;
      }
      while (active < concurrency && next < items.length) {
        const item = items[next++];
        active += 1;
        worker(item, signal)
          .then(() => {
            active -= 1;
            onProgress?.();
            launch();
          })
          .catch((err: unknown) => {
            active -= 1;
            reject(err instanceof Error ? err : new Error(String(err)));
          });
      }
      if (next >= items.length && active === 0) resolve();
    };
    launch();
  });
}

export interface ScanJobDeps {
  repo: CatalogRepository;
  adapter: SourceAdapter;
  driver: ScanDriver;
  sourceId: number;
  /** Sanitized in error messages; the source root path. */
  root: string;
  onEvent?: (event: ScanProgressEvent) => void;
  /** Override for tests; defaults to 250ms (4Hz). */
  eventIntervalMs?: number;
  /** Bounded queue width (plan §16.4: local <= 8, webdav <= 4). */
  concurrency?: number;
  /** Hard cap protecting against pathological trees; entries beyond are ignored. */
  maxEntries?: number;
}

export class ScanJobController {
  private readonly repo: CatalogRepository;
  private readonly adapter: SourceAdapter;
  private readonly driver: ScanDriver;
  private readonly sourceId: number;
  private readonly root: string;
  private readonly onEvent?: (event: ScanProgressEvent) => void;
  private readonly eventIntervalMs: number;
  private readonly concurrency: number;
  private readonly maxEntries: number;
  private readonly abortController = new AbortController();

  private runId: number | null = null;
  private started = false;
  private finished = false;
  private lastEmitAt = 0;
  private pendingEvent: ScanProgressEvent | null = null;
  private emitTimer: ReturnType<typeof setTimeout> | null = null;
  private processed = 0;

  constructor(deps: ScanJobDeps) {
    this.repo = deps.repo;
    this.adapter = deps.adapter;
    this.driver = deps.driver;
    this.sourceId = deps.sourceId;
    this.root = deps.root;
    this.onEvent = deps.onEvent;
    this.eventIntervalMs = deps.eventIntervalMs ?? SCAN_EVENT_INTERVAL_MS;
    this.concurrency = deps.concurrency ?? 4;
    this.maxEntries = deps.maxEntries ?? 100_000;
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  /** Request cancellation; the run transitions to `cancelled`. */
  cancel(): void {
    this.abortController.abort();
  }

  /** Graceful-shutdown hook: persist the run as interrupted, no error. */
  markInterrupted(): void {
    if (this.runId !== null && !this.finished) {
      this.transition('interrupted');
    }
  }

  /**
   * Execute the scan. Returns the scan_runs id. `resumeCursor` re-enters
   * traversal at/after that relative path (plan §6.1 recovery).
   */
  async start(resume?: { fromCursor?: string }): Promise<number> {
    if (this.started) throw new Error('Scan job already started');
    this.started = true;

    this.runId = this.repo.createScanRun(this.sourceId);
    this.transition('queued');

    try {
      await this.runPhases(resume?.fromCursor ?? '');
      this.transition('completed');
    } catch (err: unknown) {
      if (!this.finished) {
        if (this.signal.aborted) {
          this.transition('cancelled');
        } else {
          const message = err instanceof Error ? err.message : String(err);
          this.transition('failed', { message: sanitizeScanError(message, this.root) });
        }
      }
    }
    return this.runId;
  }

  private async runPhases(startCursor: string): Promise<void> {
    // Phase 1: discovering (traversal is the adapter's job).
    this.transition('discovering');
    const entries: SourceEntry[] = [];
    let cursor = startCursor || null;
    for await (const entry of this.adapter.list(startCursor, this.signal)) {
      throwIfAborted(this.signal);
      if (entries.length < this.maxEntries) {
        entries.push(entry);
      }
      cursor = entry.relativePath;
      this.processed += 1;
      // Persist the resume cursor every 50 entries so an interrupted run
      // can re-enter traversal close to where it stopped.
      if (this.processed % 50 === 0) {
        this.repo.updateScanRun(this.runId!, { cursor });
        this.emit('discovering', { processed: this.processed });
      }
    }
    this.repo.updateScanRun(this.runId!, {
      cursor,
      processedCount: this.processed,
      totalCount: entries.length,
    });
    this.emit('discovering', { processed: this.processed, total: entries.length });

    // Phase 2: indexing (bounded, per-entry, abort-checked).
    throwIfAborted(this.signal);
    this.transition('indexing');
    let indexed = 0;
    await runBounded(
      entries,
      this.concurrency,
      (entry, signal) => this.driver.index(entry, signal),
      this.signal,
      () => {
        indexed += 1;
        this.emit('indexing', { processed: indexed, total: entries.length });
      }
    );

    // Phase 3: enriching (optional driver hook, same bounds).
    if (this.driver.enrich) {
      throwIfAborted(this.signal);
      this.transition('enriching');
      let enriched = 0;
      await runBounded(
        entries,
        this.concurrency,
        (entry, signal) => this.driver.enrich!(entry, signal),
        this.signal,
        () => {
          enriched += 1;
          this.emit('enriching', { processed: enriched, total: entries.length });
        }
      );
    }
  }

  /**
   * Record a state transition. Phase changes and terminal states flush
   * immediately (they are rare and must be visible); same-phase progress
   * ticks are coalesced to at most one per eventIntervalMs (<= 4Hz).
   */
  private transition(status: ScanRunStatus, extra: { message?: string } = {}): void {
    if (this.runId === null) return;
    const patch: Parameters<CatalogRepository['updateScanRun']>[1] = { status };
    if (status === 'failed' && extra.message) patch.error = extra.message;
    if (isTerminal(status)) patch.finishedAt = Math.floor(Date.now() / 1000);
    this.repo.updateScanRun(this.runId, patch);

    // Drop any pending (throttled) progress event for this state change.
    if (this.emitTimer) {
      clearTimeout(this.emitTimer);
      this.emitTimer = null;
    }
    this.pendingEvent = null;
    this.lastEmitAt = Date.now();
    this.onEvent?.(this.buildEvent(status, extra.message));
    if (isTerminal(status)) this.finished = true;
  }

  private buildEvent(state: ScanRunStatus, message?: string): ScanProgressEvent {
    return {
      sourceId: this.sourceId,
      runId: this.runId!,
      state,
      ...(message ? { message } : {}),
      at: Date.now(),
    };
  }

  private emit(state: ScanRunStatus, progress?: { processed?: number; total?: number }): void {
    const base = this.buildEvent(state, undefined);
    const event: ScanProgressEvent = { ...base, ...(progress ?? {}) };
    this.pendingEvent = event;
    if (this.emitTimer) return; // a flush is already scheduled
    const elapsed = Date.now() - this.lastEmitAt;
    const delay = Math.max(0, this.eventIntervalMs - elapsed);
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      const pending = this.pendingEvent;
      this.pendingEvent = null;
      if (!pending || !this.onEvent) return;
      this.lastEmitAt = Date.now();
      this.onEvent(pending);
    }, delay);
  }
}
