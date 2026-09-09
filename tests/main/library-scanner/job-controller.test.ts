import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: (name: string) => join(tmpdir(), 'qy-scanjob-test', name) },
}));

import { openDatabaseAtPath } from '../../../src/main/modules/storage/db';
import { createCatalogRepository } from '../../../src/main/modules/catalog/repository';
import {
  ScanJobController,
  runBounded,
  sanitizeScanError,
} from '../../../src/main/modules/library-scanner/job-controller';
import type { SourceAdapter, SourceEntry } from '../../../src/main/modules/library-sources/types';
import type { ScanDriver } from '../../../src/main/modules/library-sources/types';

const tmpRoots: string[] = [];
afterAll(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
});

function makeEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'qy-scanjob-'));
  tmpRoots.push(dir);
  const db = openDatabaseAtPath(join(dir, 'test.db'));
  const repo = createCatalogRepository(db);
  const sourceId = repo.createSource({ kind: 'local', name: 'Test', root: dir });
  return { db, repo, sourceId, root: dir };
}

function makeAdapter(
  entries: SourceEntry[],
  hooks: { afterFirst?: (signal: AbortSignal) => Promise<void>; onList?: (cursor: string) => void } = {}
): SourceAdapter {
  return {
    kind: 'local',
    async testConnection() {
      return { canSeek: true, canDelete: false, supportsEtag: false, supportsRange: true };
    },
    async *list(relativePath: string, signal: AbortSignal) {
      hooks.onList?.(relativePath);
      for (const entry of entries) {
        if (signal.aborted) return;
        yield entry;
        if (hooks.afterFirst) await hooks.afterFirst(signal);
      }
    },
    async stat() {
      return { supportsRange: true };
    },
    async open() {
      throw new Error('not used in scan tests');
    },
  };
}

function entriesOf(paths: string[]): SourceEntry[] {
  return paths.map((relativePath) => ({ relativePath, isDirectory: false, size: 10 }));
}

describe('scan job controller (QYP2-006)', () => {
  it('runs the full phase machine and persists a completed run', async () => {
    const { repo, sourceId, root } = makeEnv();
    const events: string[] = [];
    let indexed = 0;
    const driver: ScanDriver = {
      index: async () => {
        indexed += 1;
      },
      enrich: async () => {},
    };
    const controller = new ScanJobController({
      repo,
      adapter: makeAdapter(entriesOf(['a.mkv', 'b.mkv', 'c.mkv', 'd.mkv', 'e.mkv'])),
      driver,
      sourceId,
      root,
      onEvent: (e) => events.push(e.state),
      eventIntervalMs: 10,
    });

    const runId = await controller.start();
    expect(indexed).toBe(5);

    const run = repo.getScanRun(runId)!;
    expect(run.status).toBe('completed');
    expect(run.processed_count).toBe(5);
    expect(run.total_count).toBe(5);
    expect(run.finished_at).not.toBeNull();

    // First and last events delivered; states observed in machine order.
    expect(events[0]).toBe('queued');
    expect(events[events.length - 1]).toBe('completed');
    expect(events).toContain('discovering');
    expect(events).toContain('indexing');
    expect(events).toContain('enriching');
  });

  it('coalesces progress events within the throttle window', async () => {
    const { repo, sourceId, root } = makeEnv();
    const events: string[] = [];
    const controller = new ScanJobController({
      repo,
      adapter: makeAdapter(entriesOf(['a.mkv', 'b.mkv'])),
      driver: { index: async () => {}, enrich: async () => {} },
      sourceId,
      root,
      onEvent: (e) => events.push(e.state),
      eventIntervalMs: 60_000, // window longer than the whole run
    });
    await controller.start();

    // Coalescing removes per-item progress spam; phase transitions remain.
    expect(events).toEqual(['queued', 'discovering', 'indexing', 'enriching', 'completed']);
  });

  it('transitions to cancelled and never indexes after abort', async () => {
    const { repo, sourceId, root } = makeEnv();
    let indexCalls = 0;
    const driver: ScanDriver = {
      index: async () => {
        indexCalls += 1;
      },
    };
    const adapter = makeAdapter(entriesOf(['a.mkv', 'b.mkv', 'c.mkv']), {
      afterFirst: (signal) =>
        new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        }),
    });
    const controller = new ScanJobController({
      repo,
      adapter,
      driver,
      sourceId,
      root,
      eventIntervalMs: 10,
    });

    const startPromise = controller.start();
    // Wait until the adapter has yielded the first entry, then cancel.
    await new Promise((r) => setTimeout(r, 20));
    controller.cancel();
    const runId = await startPromise;

    expect(indexCalls).toBe(0);
    const run = repo.getScanRun(runId)!;
    expect(run.status).toBe('cancelled');
    expect(run.finished_at).not.toBeNull();
  });

  it('cancellation and failure never mark items missing', async () => {
    const { db, repo, sourceId, root } = makeEnv();
    void db;
    const itemId = repo.upsertItem({ sourceId, sourceKey: 'keep', kind: 'movie', title: 'Keep' });
    repo.setAvailability(itemId, 'online');

    const driver: ScanDriver = {
      index: async () => {
        throw new Error(`boom at ${root}/secret/file.mkv`);
      },
    };
    const controller = new ScanJobController({
      repo,
      adapter: makeAdapter(entriesOf(['a.mkv'])),
      driver,
      sourceId,
      root,
      eventIntervalMs: 10,
    });
    const runId = await controller.start();

    const run = repo.getScanRun(runId)!;
    expect(run.status).toBe('failed');
    // Error is sanitized: no absolute path leak.
    expect(run.error).not.toContain(root);
    expect(run.error).toContain('<source>');
    // Availability untouched by a failed run.
    expect(repo.getItem(itemId)!.availability).toBe('online');
  });

  it('passes the resume cursor to the adapter', async () => {
    const { repo, sourceId, root } = makeEnv();
    let receivedCursor: string | undefined;
    const controller = new ScanJobController({
      repo,
      adapter: makeAdapter(entriesOf(['z.mkv']), {
        onList: (cursor) => {
          receivedCursor = cursor;
        },
      }),
      driver: { index: async () => {}, enrich: async () => {} },
      sourceId,
      root,
      eventIntervalMs: 10,
    });

    await controller.start({ fromCursor: 'resumed/dir' });
    expect(receivedCursor).toBe('resumed/dir');
  });

  it('persists the traversal cursor for recovery', async () => {
    const { repo, sourceId, root } = makeEnv();
    const many = entriesOf(Array.from({ length: 120 }, (_, i) => `f${i}.mkv`));
    const controller = new ScanJobController({
      repo,
      adapter: makeAdapter(many),
      driver: { index: async () => {} },
      sourceId,
      root,
      eventIntervalMs: 10,
    });
    const runId = await controller.start();
    const run = repo.getScanRun(runId)!;
    expect(run.cursor).toBe('f119.mkv');
  });

  it('recovers non-terminal runs as interrupted on startup', () => {
    const { repo, sourceId } = makeEnv();
    const runId = repo.createScanRun(sourceId);
    repo.updateScanRun(runId, { status: 'indexing' });
    const completedId = repo.createScanRun(sourceId);
    repo.updateScanRun(completedId, { status: 'completed' });

    const recovered = repo.recoverInterruptedScanRuns();
    expect(recovered).toBe(1);
    const interrupted = repo.getScanRun(runId)!;
    expect(interrupted.status).toBe('interrupted');
    expect(interrupted.finished_at).not.toBeNull();
    expect(repo.getScanRun(completedId)!.status).toBe('completed');
  });

  it('marks a running job interrupted on graceful shutdown', async () => {
    const { repo, sourceId, root } = makeEnv();
    let controller!: ScanJobController;
    const adapter = makeAdapter(entriesOf(['a.mkv', 'b.mkv']), {
      // Interrupt synchronously mid-discovery: the strict outcome must be
      // `interrupted`, never overwritten to cancelled/completed (review R6).
      afterFirst: () => {
        controller.markInterrupted();
        return Promise.resolve();
      },
    });
    controller = new ScanJobController({
      repo,
      adapter,
      driver: { index: async () => {} },
      sourceId,
      root,
      eventIntervalMs: 10,
    });
    const runId = await controller.start();
    const run = repo.getScanRun(runId)!;
    expect(run.status).toBe('interrupted');
  });

  it('bounds worker concurrency in runBounded', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const tasks = Array.from({ length: 10 }, (_, i) => i);
    await runBounded(
      tasks,
      2,
      async (_task, signal) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        if (signal.aborted) return;
        inFlight -= 1;
      },
      new AbortController().signal
    );
    expect(maxInFlight).toBeLessThanOrEqual(2);
  });

  it('sanitizes scan errors', () => {
    const sanitized = sanitizeScanError('ENOENT: /media/nas/root/sub/file\n  second line', '/media/nas/root');
    expect(sanitized).not.toContain('/media/nas/root');
    expect(sanitized).toContain('<source>');
    expect(sanitized).not.toContain('\n');
    expect(sanitized.length).toBeLessThanOrEqual(300);
  });
});
