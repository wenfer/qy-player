import { describe, expect, it } from 'vitest';
import { hasUsableFields, runMpvProbe, toMediaProbeInfo } from '../../../src/main/modules/media-probe/mpv-probe';
import { ProbeError, type ProbeResult } from '../../../src/main/modules/media-probe/mpv-probe-spike';
import { MediaProbeService } from '../../../src/main/modules/media-probe';
import type { MediaProbeOutcome } from '../../../src/shared/types/media-info';

// ---------------------------------------------------------------------------
// mpv-probe mapping (pure)
// ---------------------------------------------------------------------------

const SPIKE_OK: ProbeResult = {
  version: '0.32.0',
  duration: 3600.5,
  container: 'Matroska',
  video: { codec: 'h264', width: 1920, height: 1080, fps: 23.976, aspect: 1.7778 },
  audio: { codec: 'aac', channels: 6, samplerate: 48000 },
  tracks: [
    { kind: 'video', codec: 'h264', width: 1920, height: 1080, fps: 23.976 },
    { kind: 'audio', codec: 'aac', language: 'eng', channels: 6, samplerate: 48000 },
    { kind: 'subtitle', codec: 'subrip', language: 'chi', title: '中文', isDefault: true },
  ],
  unsupported: [],
};

describe('mpv-probe mapping', () => {
  it('maps the full multi-track spike result onto the shared contract', () => {
    const info = toMediaProbeInfo(SPIKE_OK);
    expect(info.version).toBe('0.32.0');
    expect(info.duration).toBeCloseTo(3600.5);
    expect(info.video).toMatchObject({ codec: 'h264', width: 1920, aspect: 1.7778 });
    expect(info.audio).toMatchObject({ codec: 'aac', channels: 6, samplerate: 48000 });
    expect(info.tracks.map((t) => t.kind)).toEqual(['video', 'audio', 'subtitle']);
    expect(info.tracks[2]).toMatchObject({ language: 'chi', isDefault: true });
    expect(hasUsableFields(info)).toBe(true);
  });

  it('classifies an all-unsupported probe as unsupported', () => {
    const info = toMediaProbeInfo({ version: 'unknown', tracks: [], unsupported: ['duration', 'video.codec'] });
    expect(hasUsableFields(info)).toBe(false);
  });

  it('distinguishes timeout from missing mpv from offline', async () => {
    const timeout = await runMpvProbe('/x.mkv', {
      spikeFn: () => Promise.reject(new ProbeError('TIMEOUT', 'mpv 探测超时')),
    });
    expect(timeout.status).toBe('timeout');

    const noMpv = await runMpvProbe('/x.mkv', {
      spikeFn: () => Promise.reject(new ProbeError('SPAWN', 'mpv 启动失败: spawn mpv ENOENT')),
    });
    expect(noMpv.status).toBe('no-mpv');

    const offline = await runMpvProbe('/x.mkv', {
      spikeFn: () => Promise.reject(new ProbeError('UNAVAILABLE', 'mpv IPC 断开')),
    });
    expect(offline.status).toBe('offline');

    const connectFail = await runMpvProbe('/x.mkv', {
      spikeFn: () => Promise.reject(new ProbeError('CONNECT', 'mpv IPC 连接失败')),
    });
    expect(connectFail.status).toBe('offline');
  });

  it('maps unexpected runner crashes to offline, never throws', async () => {
    const boom = await runMpvProbe('/x.mkv', {
      spikeFn: () => Promise.reject(new Error('unexpected')),
    });
    expect(boom.status).toBe('offline');
  });
});

// ---------------------------------------------------------------------------
// MediaProbeService (fake runner; no real mpv)
// ---------------------------------------------------------------------------

interface Deferred {
  resolve: (result: ProbeResult) => void;
  reject: (err: Error) => void;
}

/** Runner factory whose probes complete only when the test releases them. */
function manualRunner() {
  const deferreds: Array<Deferred & { done: boolean }> = [];
  const calls: string[] = [];
  const spikeFn = (deps: { target: string }): Promise<ProbeResult> => {
    calls.push(deps.target);
    return new Promise<ProbeResult>((resolve, reject) => {
      deferreds.push({ resolve, reject, done: false });
    });
  };
  return {
    spikeFn,
    calls,
    count: () => calls.length,
    settle: (index: number, result: ProbeResult): void => {
      deferreds[index].done = true;
      deferreds[index].resolve(result);
    },
    fail: (index: number, err: Error): void => {
      deferreds[index].done = true;
      deferreds[index].reject(err);
    },
    /** Deferreds created but not yet settled = probes in flight. */
    pending: () => deferreds.filter((d) => !d.done).length,
  };
}

const OK_RESULT = (): ProbeResult => ({ ...SPIKE_OK, tracks: SPIKE_OK.tracks.map((t) => ({ ...t })) });

/**
 * Drain microtasks/macrotasks so the queue's hand-off chain settles before
 * the test settles the next deferred (async coordination is not synchronous).
 */
const drain = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function extractInfo(outcome: MediaProbeOutcome) {
  expect(outcome.info).toBeDefined();
  return outcome.info as NonNullable<MediaProbeOutcome['info']>;
}

describe('MediaProbeService cache', () => {
  it('serves repeat requests from cache and calls the runner once', async () => {
    const runner = manualRunner();
    const service = new MediaProbeService({ runner: { spikeFn: runner.spikeFn } });
    const first = service.probe({ target: '/a.mkv', fingerprint: '100:200' });
    expect(runner.pending()).toBe(1);
    runner.settle(0, OK_RESULT());
    const firstOutcome = await first;
    expect(firstOutcome.status).toBe('ok');
    expect(firstOutcome.fromCache).toBe(false);

    const second = await service.probe({ target: '/a.mkv', fingerprint: '100:200' });
    expect(second.fromCache).toBe(true);
    expect(second.status).toBe('ok');
    expect(runner.count()).toBe(1);
  });

  it('invalidates when the fingerprint changes (size/mtime/etag)', async () => {
    const runner = manualRunner();
    const service = new MediaProbeService({ runner: { spikeFn: runner.spikeFn } });
    const first = service.probe({ target: '/a.mkv', fingerprint: '100:200' });
    runner.settle(0, OK_RESULT());
    await first;

    const second = service.probe({ target: '/a.mkv', fingerprint: '101:200' });
    await drain();
    runner.settle(1, OK_RESULT());
    const secondOutcome = await second;
    expect(secondOutcome.fromCache).toBe(false);
    expect(secondOutcome.fingerprint).toBe('101:200');
    expect(runner.count()).toBe(2);
  });

  it('honours the TTL before expiry and misses after', async () => {
    let now = 1_000_000;
    const runner = manualRunner();
    const service = new MediaProbeService({
      ttlMs: 60_000,
      now: () => now,
      runner: { spikeFn: runner.spikeFn },
    });
    const first = service.probe({ target: '/a.mkv', fingerprint: 'f1' });
    runner.settle(0, OK_RESULT());
    const outcome = await first;
    expect(outcome.probedAt).toBe(1_000_000);

    now += 30_000;
    const fresh = await service.probe({ target: '/a.mkv', fingerprint: 'f1' });
    expect(fresh.fromCache).toBe(true);

    now += 61_000;
    const stale = service.probe({ target: '/a.mkv', fingerprint: 'f1' });
    await drain();
    runner.settle(1, OK_RESULT());
    const staleOutcome = await stale;
    expect(staleOutcome.fromCache).toBe(false);
    expect(runner.count()).toBe(2);
  });

  it('evicts the LRU tail beyond the quota', async () => {
    const runner = manualRunner();
    const service = new MediaProbeService({
      maxEntries: 2,
      runner: { spikeFn: runner.spikeFn },
    });
    for (const [i, target] of ['/1.mkv', '/2.mkv', '/3.mkv'].entries()) {
      const pending = service.probe({ target, fingerprint: 'f' });
      runner.settle(i, OK_RESULT());
      await pending;
    }
    expect(service.size).toBe(2);
    // '/1.mkv' was evicted; probing it again hits the runner.
    const again = service.probe({ target: '/1.mkv', fingerprint: 'f' });
    await drain();
    runner.settle(3, OK_RESULT());
    const outcome = await again;
    expect(outcome.fromCache).toBe(false);
    expect(runner.count()).toBe(4);
  });

  it('never caches failures (timeout stays retryable)', async () => {
    const runner = manualRunner();
    const service = new MediaProbeService({ runner: { spikeFn: runner.spikeFn } });
    const first = service.probe({ target: '/a.mkv', fingerprint: 'f1' });
    runner.fail(0, new ProbeError('TIMEOUT', '超时'));
    expect((await first).status).toBe('timeout');
    expect(service.size).toBe(0);

    const second = service.probe({ target: '/a.mkv', fingerprint: 'f1' });
    await drain();
    runner.settle(1, OK_RESULT());
    expect((await second).status).toBe('ok');
    expect(runner.count()).toBe(2);
  });

  it('caches the unsupported verdict but not no-mpv/offline', async () => {
    const runner = manualRunner();
    const service = new MediaProbeService({ runner: { spikeFn: runner.spikeFn } });
    const unsupported = service.probe({ target: '/a.mkv', fingerprint: 'f1' });
    runner.settle(0, { version: 'unknown', tracks: [], unsupported: ['duration'] });
    const outcome = await unsupported;
    expect(outcome.status).toBe('unsupported');
    expect(extractInfo(outcome).unsupported).toContain('duration');
    expect(service.size).toBe(1);

    const offline = service.probe({ target: '/b.mkv', fingerprint: 'f1' });
    runner.fail(1, new ProbeError('SPAWN', 'mpv 启动失败: spawn mpv ENOENT'));
    expect((await offline).status).toBe('no-mpv');
    expect(service.size).toBe(1);
  });
});

describe('MediaProbeService queue and cancellation', () => {
  it('runs strictly one probe at a time (plan §16.4)', async () => {
    const runner = manualRunner();
    const service = new MediaProbeService({ runner: { spikeFn: runner.spikeFn } });
    const p1 = service.probe({ target: '/1.mkv', fingerprint: 'f' });
    const p2 = service.probe({ target: '/2.mkv', fingerprint: 'f' });
    const p3 = service.probe({ target: '/3.mkv', fingerprint: 'f' });
    expect(service.busyCount).toBe(3);
    expect(runner.pending()).toBe(1); // only the head is running
    runner.settle(0, OK_RESULT());
    await p1;
    await drain();
    expect(runner.pending()).toBe(1); // second starts only now
    runner.settle(1, OK_RESULT());
    await p2;
    await drain();
    runner.settle(2, OK_RESULT());
    await p3;
    expect(runner.calls).toEqual(['/1.mkv', '/2.mkv', '/3.mkv']);
    expect(service.busyCount).toBe(0);
  });

  it('coalesces identical requests into a single flight', async () => {
    const runner = manualRunner();
    const service = new MediaProbeService({ runner: { spikeFn: runner.spikeFn } });
    const p1 = service.probe({ target: '/a.mkv', fingerprint: 'f1' });
    const p2 = service.probe({ target: '/a.mkv', fingerprint: 'f1' });
    expect(runner.pending()).toBe(1);
    runner.settle(0, OK_RESULT());
    const [o1, o2] = await Promise.all([p1, p2]);
    expect(o1.status).toBe('ok');
    expect(o2.fromCache).toBe(false);
    expect(o2.status).toBe('ok');
    expect(runner.count()).toBe(1);
  });

  it('cancels a queued request without running it', async () => {
    const runner = manualRunner();
    const service = new MediaProbeService({ runner: { spikeFn: runner.spikeFn } });
    const controller = new AbortController();
    const p1 = service.probe({ target: '/1.mkv', fingerprint: 'f' });
    const p2 = service.probe({ target: '/2.mkv', fingerprint: 'f', signal: controller.signal });
    controller.abort();
    const cancelled = await p2;
    expect(cancelled.status).toBe('cancelled');
    runner.settle(0, OK_RESULT());
    await p1;
    expect(runner.calls).toEqual(['/1.mkv']);
  });

  it('resolves cancelled for an already-aborted signal', async () => {
    const runner = manualRunner();
    const service = new MediaProbeService({ runner: { spikeFn: runner.spikeFn } });
    const controller = new AbortController();
    controller.abort();
    const outcome = await service.probe({
      target: '/a.mkv',
      fingerprint: 'f',
      signal: controller.signal,
    });
    expect(outcome.status).toBe('cancelled');
    expect(runner.count()).toBe(0);
  });

  it('discards a running probe result when aborted mid-flight', async () => {
    const runner = manualRunner();
    const service = new MediaProbeService({ runner: { spikeFn: runner.spikeFn } });
    const controller = new AbortController();
    const p1 = service.probe({ target: '/a.mkv', fingerprint: 'f', signal: controller.signal });
    controller.abort();
    expect((await p1).status).toBe('cancelled');
    // The spike still finishes in the background (bounded), the result is
    // discarded and NOT cached.
    runner.settle(0, OK_RESULT());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(service.size).toBe(0);
  });

  it('passes the fingerprint through to every outcome', async () => {
    const runner = manualRunner();
    const service = new MediaProbeService({ runner: { spikeFn: runner.spikeFn } });
    const pending = service.probe({ target: '/a.mkv', fingerprint: 'etag:v2' });
    runner.settle(0, OK_RESULT());
    expect((await pending).fingerprint).toBe('etag:v2');
  });
});
