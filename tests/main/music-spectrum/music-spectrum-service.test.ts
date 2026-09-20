import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MusicSpectrumService } from '../../../src/main/modules/music-spectrum';
import { BandFrameEncoder } from '../../../src/main/modules/music-spectrum/pcm-fft';
import { SPECTRUM_SAMPLE_RATE } from '../../../src/main/modules/music-spectrum/spectrum-format';
import type { DecodeRequest } from '../../../src/main/modules/music-spectrum/ffmpeg-decode';
import type { SpectrumJob } from '../../../src/shared/types/music-spectrum';

/**
 * 离线频谱服务（QYP3-050）：懒计算、单曲只算一次、缓存命中不重算、
 * 失败/无 ffmpeg 在本会话不重试、换曲目取消、退出同步取消。
 */

const BANDS = 48;

/** N 秒 1kHz 正弦 → 12×N 帧（每帧非零，便于断言"真的算出东西了"）。 */
function framesFor(seconds = 3): Uint8Array[] {
  const enc = new BandFrameEncoder({ sampleRate: SPECTRUM_SAMPLE_RATE, bands: BANDS });
  const n = Math.round(SPECTRUM_SAMPLE_RATE * seconds);
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i += 1) {
    pcm[i] = Math.round(Math.sin((2 * Math.PI * 1000 * i) / SPECTRUM_SAMPLE_RATE) * 32767);
  }
  enc.push(pcm);
  return enc.frames;
}

function job(overrides: Partial<SpectrumJob> = {}): SpectrumJob {
  return { mediaId: 'local:1:a.ape', url: '/music/a.ape', durationSec: 200, ...overrides };
}

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qysp-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

type ServiceDeps = ConstructorParameters<typeof MusicSpectrumService>[0];
type Overrides = Partial<Omit<ServiceDeps, 'decodeFn'>> & {
  decodeImpl?: (
    bin: string,
    req: DecodeRequest,
    deps: { signal?: AbortSignal }
  ) => Promise<unknown>;
};

/**
 * 默认：探测到假 ffmpeg、解码直接成功。`decodeImpl` 覆写解码结果时，返回的
 * `decodeFn` 仍是**真正被调用**的那个 spy（否则断言会查到一个没人用的替身）。
 */
function makeService(overrides: Overrides = {}) {
  const { decodeImpl, ...rest } = overrides;
  const decodeFn = vi.fn(
    decodeImpl ?? (async () => ({ status: 'ok' as const, frames: framesFor() }))
  );
  const onSettled = vi.fn();
  const service = new MusicSpectrumService({
    dir,
    startupDelayMs: 0,
    locator: { detect: async () => '/fake/ffmpeg', known: () => '/fake/ffmpeg' },
    ...rest,
    decodeFn: decodeFn as never,
    onSettled,
  });
  return { service, decodeFn, onSettled };
}

describe('MusicSpectrumService (QYP3-050)', () => {
  it('computes once, serves frames, and hits the disk cache next time', async () => {
    const { service, decodeFn, onSettled } = makeService();
    service.setCurrent(job());
    expect(service.get().status).toBe('pending');
    await vi.waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1));
    expect(onSettled).toHaveBeenCalledWith({ mediaId: 'local:1:a.ape', status: 'ready' });

    const ready = service.get();
    expect(ready.status).toBe('ready');
    if (ready.status !== 'ready') return;
    expect(ready.mediaId).toBe('local:1:a.ape');
    expect(ready.bands).toBe(BANDS);
    expect(ready.fps).toBe(12);
    expect(ready.frameCount).toBe(36);
    expect(ready.data.length).toBe(36 * BANDS);
    expect(Math.max(...ready.data.subarray(0, BANDS))).toBeGreaterThan(100);
    expect(decodeFn).toHaveBeenCalledTimes(1);
    expect(readdirSync(dir).filter((f) => f.endsWith('.qys'))).toHaveLength(1);

    // 新会话（模拟重启）：同曲目直接命中缓存，不再 spawn 解码
    const second = makeService();
    second.service.setCurrent(job());
    expect(second.service.get().status).toBe('ready');
    expect(second.decodeFn).not.toHaveBeenCalled();
    expect(second.onSettled).not.toHaveBeenCalled(); // 缓存命中无需通知
  });

  it('is idempotent for the same track and cancels the previous decode on switch', async () => {
    let resolveDecode: (v: unknown) => void = () => undefined;
    const { service, decodeFn, onSettled } = makeService({
      decodeImpl: () =>
        new Promise((r) => {
          resolveDecode = r;
        }),
    });
    service.setCurrent(job());
    service.setCurrent(job()); // 幂等
    await vi.waitFor(() => expect(decodeFn).toHaveBeenCalledTimes(1));

    service.setCurrent(job({ mediaId: 'local:1:b.ape', url: '/music/b.ape' }));
    await vi.waitFor(() => expect(decodeFn).toHaveBeenCalledTimes(2));
    // 旧结果到达时不能覆盖新曲目的状态，也不能发通知
    resolveDecode({ status: 'aborted' });
    await Promise.resolve();
    const state = service.get();
    expect(state.status === 'pending' && state.mediaId).toBe('local:1:b.ape');
    expect(onSettled).not.toHaveBeenCalled();
  });

  it('remembers a failure and never retries it in the same session', async () => {
    const { service, decodeFn, onSettled } = makeService({
      decodeImpl: async () => ({ status: 'failed' }),
    });
    service.setCurrent(job());
    await vi.waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1));
    expect(service.get().status).toBe('failed');

    service.setCurrent(job({ durationSec: 201 })); // 同 mediaId 的新 job 对象
    expect(service.get().status).toBe('failed');
    expect(decodeFn).toHaveBeenCalledTimes(1);
  });

  it('degrades to unavailable when no ffmpeg exists (and stops probing)', async () => {
    const detect = vi.fn(async () => null);
    const { service, onSettled } = makeService({ locator: { detect, known: () => null } });
    service.setCurrent(job());
    await vi.waitFor(() => expect(service.get().status).toBe('unavailable'));
    const first = service.get();
    expect(first.status === 'unavailable' && first.reason).toBe('no-ffmpeg');
    expect(onSettled).toHaveBeenCalledWith({ mediaId: 'local:1:a.ape', status: 'unavailable' });

    service.setCurrent(job({ mediaId: 'local:1:c.ape', url: '/music/c.ape' }));
    expect(service.get().status).toBe('unavailable');
    expect(detect).toHaveBeenCalledTimes(1); // 全局不可用：不再探测
  });

  it('skips absurdly long tracks without decoding', async () => {
    const { service, decodeFn } = makeService();
    service.setCurrent(job({ durationSec: 3 * 60 * 60 }));
    expect(service.get().status).toBe('failed');
    expect(decodeFn).not.toHaveBeenCalled();
  });

  it('clears state when the music session ends', async () => {
    const { service, onSettled } = makeService();
    service.setCurrent(job());
    await vi.waitFor(() => expect(onSettled).toHaveBeenCalled());
    service.setCurrent(null);
    expect(service.get().status).toBe('none');
  });

  it('cancels the running decode on cancelAll (app quit)', async () => {
    const aborted = vi.fn();
    const { service, decodeFn } = makeService({
      decodeImpl: (_bin, _req, deps) =>
        new Promise((resolve) => {
          // 解码中途被 abort（真实实现里 decodeToBands 会 SIGKILL 子进程）
          deps.signal?.addEventListener('abort', () => {
            aborted();
            resolve({ status: 'aborted' });
          });
        }),
    });
    service.setCurrent(job());
    await vi.waitFor(() => expect(decodeFn).toHaveBeenCalledTimes(1));
    service.cancelAll();
    expect(aborted).toHaveBeenCalledTimes(1);
  });

  it('sweeps the cache partition once the quota is exceeded', async () => {
    const sweep = vi.fn();
    const { service, onSettled } = makeService({ quotaBytes: 1, sweep });
    service.setCurrent(job());
    await vi.waitFor(() => expect(onSettled).toHaveBeenCalled());
    expect(sweep).toHaveBeenCalledTimes(1);
  });
});
