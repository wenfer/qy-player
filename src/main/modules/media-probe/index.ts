import { runMpvProbe, type MpvRunnerDeps } from './mpv-probe';
import type {
  MediaProbeInfo,
  MediaProbeOutcome,
  ProbeStatus,
} from '../../../shared/types/media-info';

/**
 * MediaProbe service (QYP2-018, plan §16.4).
 *
 * - Concurrency 1: probes run strictly one at a time (microtask-chained
 *   queue; a completion always hands off to the next queued entry).
 * - Versioned cache: entries are keyed by target + content fingerprint
 *   (local size:mtime / WebDAV etag); any fingerprint change is a miss.
 * - LRU + TTL quota so the cache cannot grow without bound.
 * - Cancellable: queued requests dequeue; a running probe's result is
 *   discarded for the caller (the bounded 15s spike finishes on its own).
 * - Failures are never cached and never block playback (plan §16.4).
 */

export interface ProbeRequest {
  /** mpv-loadable target: local path or stream URL. */
  target: string;
  /** Content version fingerprint; a change invalidates the cache entry. */
  fingerprint: string;
  /** Raw 'Key: Value' header lines (main-side only, never logged). */
  httpHeaders?: string[];
  signal?: AbortSignal;
}

interface QueueEntry {
  key: string;
  request: ProbeRequest;
  resolve: (outcome: MediaProbeOutcome) => void;
  cancelled: boolean;
}

interface CacheEntry {
  status: ProbeStatus;
  fingerprint: string;
  probedAt: number;
  info: MediaProbeInfo;
}

export interface MediaProbeOptions {
  /** LRU quota (entries); default 256. */
  maxEntries?: number;
  /** Cache TTL in ms; default 6h. */
  ttlMs?: number;
  now?: () => number;
  runner?: MpvRunnerDeps;
}

const DEFAULT_MAX_ENTRIES = 256;
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;

export class MediaProbeService {
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly runnerDeps: MpvRunnerDeps;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<MediaProbeOutcome>>();
  private readonly pending: QueueEntry[] = [];
  private readonly waiters = new Map<string, number>();
  private running: QueueEntry | null = null;
  private active = false;

  constructor(options: MediaProbeOptions = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? Date.now;
    this.runnerDeps = options.runner ?? {};
  }

  /** Probe requests not yet finished, coalesced per key (telemetry/tests). */
  get busyCount(): number {
    return this.inFlight.size;
  }

  /** Current cache size (tests/telemetry). */
  get size(): number {
    return this.cache.size;
  }

  async probe(request: ProbeRequest): Promise<MediaProbeOutcome> {
    // An already-aborted caller never reaches the queue or the runner.
    if (request.signal?.aborted) return this.cancelledOutcome();
    const key = `${request.target}|${request.fingerprint}`;
    const cached = this.readCache(key, request.fingerprint);
    if (cached) return { ...cached, fromCache: true };

    const existing = this.inFlight.get(key);
    if (existing) {
      return this.attachCancellation(existing, request.signal, key);
    }

    const promise = new Promise<MediaProbeOutcome>((resolve) => {
      this.pending.push({ key, request, resolve, cancelled: false });
    });
    this.inFlight.set(key, promise);
    this.schedule();
    return this.attachCancellation(promise, request.signal, key);
  }

  // -------------------------------------------------------------------------
  // Per-caller cancellation
  //
  // An abort must only discard the aborting caller's await. The shared
  // flight keeps running for every other coalesced caller; the entry
  // itself (queue slot or running flag) is torn down only when the
  // aborting caller was the LAST waiter on that key. (A coalesced caller
  // aborting must never hang the original waiter.)
  // -------------------------------------------------------------------------

  private addWaiter(key: string): void {
    this.waiters.set(key, (this.waiters.get(key) ?? 0) + 1);
  }

  private removeWaiter(key: string): void {
    const count = (this.waiters.get(key) ?? 0) - 1;
    if (count <= 0) this.waiters.delete(key);
    else this.waiters.set(key, count);
  }

  /** Drop every cache entry (tests, explicit user refresh). */
  clear(): void {
    this.cache.clear();
  }

  // -------------------------------------------------------------------------
  // Concurrency-1 queue
  // -------------------------------------------------------------------------

  /** Start the next queued entry unless one is already running. */
  private schedule(): void {
    if (this.active) return;
    const index = this.pending.findIndex((entry) => !entry.cancelled);
    if (index === -1) return;
    const [entry] = this.pending.splice(index, 1);
    if (entry.cancelled) return;
    this.active = true;
    this.running = entry;
    void this.processEntry(entry);
  }

  private async processEntry(entry: QueueEntry): Promise<void> {
    try {
      await this.runEntry(entry);
    } finally {
      if (this.running === entry) this.running = null;
      this.inFlight.delete(entry.key);
      this.active = false;
      // Hand off in a fresh microtask so queued producers (and consumer
      // continuations) settle before the next probe starts.
      queueMicrotask(() => this.schedule());
    }
  }

  private async runEntry(entry: QueueEntry): Promise<void> {
    if (entry.cancelled) return;
    const { status, info, message } = await runMpvProbe(entry.request.target, {
      ...this.runnerDeps,
      ...(entry.request.httpHeaders ? { httpHeaders: entry.request.httpHeaders } : {}),
    });
    if (entry.cancelled) return; // caller aborted mid-run: discard entirely
    const outcome: MediaProbeOutcome = {
      status,
      fingerprint: entry.request.fingerprint,
      probedAt: this.now(),
      fromCache: false,
      ...(info !== undefined ? { info } : {}),
      ...(message !== undefined ? { message } : {}),
    };
    // Only usable results are cached; failures stay retryable and must
    // never block playback with a stale error (plan §16.4).
    if ((status === 'ok' || status === 'unsupported') && info) {
      this.writeCache(entry.key, {
        status,
        fingerprint: entry.request.fingerprint,
        probedAt: outcome.probedAt,
        info,
      });
    }
    entry.resolve(outcome);
  }

  private attachCancellation(
    promise: Promise<MediaProbeOutcome>,
    signal: AbortSignal | undefined,
    key: string
  ): Promise<MediaProbeOutcome> {
    this.addWaiter(key);
    if (signal?.aborted) {
      this.abandon(key);
      return Promise.resolve(this.cancelledOutcome());
    }
    return new Promise<MediaProbeOutcome>((resolve) => {
      const onAbort = (): void => {
        signal?.removeEventListener('abort', onAbort);
        this.abandon(key);
        resolve(this.cancelledOutcome());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      promise.then(
        (outcome) => {
          signal?.removeEventListener('abort', onAbort);
          this.removeWaiter(key);
          resolve(outcome);
        },
        () => {
          signal?.removeEventListener('abort', onAbort);
          this.removeWaiter(key);
          resolve(this.cancelledOutcome());
        }
      );
    });
  }

  /** One caller is gone: tear down shared state only if it was the last. */
  private abandon(key: string): void {
    this.removeWaiter(key);
    if ((this.waiters.get(key) ?? 0) > 0) return; // others still waiting
    const queued = this.pending.find((candidate) => candidate.key === key);
    if (queued) {
      this.pending.splice(this.pending.indexOf(queued), 1);
      this.inFlight.delete(key);
      return;
    }
    // Running entry with nobody left to receive it: discard its result.
    if (this.running?.key === key) this.running.cancelled = true;
  }

  private cancelledOutcome(): MediaProbeOutcome {
    return {
      status: 'cancelled',
      fingerprint: '',
      probedAt: this.now(),
      fromCache: false,
      message: '探测已取消',
    };
  }

  // -------------------------------------------------------------------------
  // Versioned LRU cache
  // -------------------------------------------------------------------------

  private readCache(key: string, fingerprint: string): MediaProbeOutcome | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (entry.fingerprint !== fingerprint || this.now() - entry.probedAt > this.ttlMs) {
      this.cache.delete(key);
      return null;
    }
    // LRU refresh: reinsert to move the entry to the back.
    this.cache.delete(key);
    this.cache.set(key, entry);
    return {
      status: entry.status,
      fingerprint: entry.fingerprint,
      probedAt: entry.probedAt,
      fromCache: true,
      info: entry.info,
    };
  }

  private writeCache(key: string, entry: CacheEntry): void {
    this.cache.delete(key);
    this.cache.set(key, entry);
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      this.cache.delete(oldest.value);
    }
  }
}

/** Default singleton for main-process wiring (concurrency 1 is global). */
export const mediaProbeService = new MediaProbeService();
