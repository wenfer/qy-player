import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import {
  buildFfmpegArgs,
  decodeToBands,
  makePcmDigester,
} from '../../../src/main/modules/music-spectrum/ffmpeg-decode';
import { SPECTRUM_SAMPLE_RATE } from '../../../src/main/modules/music-spectrum/spectrum-format';

/**
 * ffmpeg 解码层（QYP3-050）。
 * 重点：参数契约、s16le 跨块对齐、以及**硬性约束 3**——spawn 后必须同步消费
 * stdout（否则 64KB 管道写满，子进程卡死）。
 */

interface FakeChild {
  proc: ChildProcess;
  stdout: Readable;
  kill: ReturnType<typeof vi.fn>;
  emit: (event: string, ...args: unknown[]) => boolean;
}

function fakeChild(): FakeChild {
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const emitter = new EventEmitter();
  const kill = vi.fn();
  const proc = {
    stdout,
    stderr,
    kill,
    exitCode: null as number | null,
    signalCode: null as string | null,
    on: (event: string, cb: (...a: unknown[]) => void) => {
      emitter.on(event, cb);
      return proc;
    },
  } as unknown as ChildProcess;
  return { proc, stdout, kill, emit: (e, ...a) => emitter.emit(e, ...a) };
}

/** 等 stdout 里已推入的字节全部被消费（flowing 模式下是多轮 nextTick）。 */
function drain(stream: Readable): Promise<void> {
  return new Promise((resolve) => {
    const check = (): void => {
      if (stream.readableLength === 0) resolve();
      else setImmediate(check);
    };
    setImmediate(check);
  });
}

/** 1 秒 1kHz 正弦的 s16le 字节。 */
function pcmBytes(seconds = 1): Buffer {
  const n = Math.round(SPECTRUM_SAMPLE_RATE * seconds);
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i += 1) {
    pcm[i] = Math.round(Math.sin((2 * Math.PI * 1000 * i) / SPECTRUM_SAMPLE_RATE) * 32767);
  }
  return Buffer.from(pcm.buffer.slice(0));
}

describe('buildFfmpegArgs (QYP3-050)', () => {
  it('decodes a local file to mono s16le on stdout', () => {
    const args = buildFfmpegArgs({ url: '/m/a.ape' });
    expect(args).toContain('-nostdin'); // 无人看管的 stdin
    expect(args.slice(-1)).toEqual(['-']);
    expect(args).toContain('-i');
    expect(args[args.indexOf('-i') + 1]).toBe('/m/a.ape');
    expect(args.join(' ')).toContain('-f s16le -acodec pcm_s16le -ac 1 -ar 24000 -');
    expect(args).not.toContain('-headers'); // 本地文件不带认证头
  });

  it('passes auth headers before -i and honours start/duration', () => {
    const args = buildFfmpegArgs({
      url: 'http://s:8096/Audio/x/stream',
      headers: 'X-Emby-Token: t\r\n',
      startSec: 12,
      durationSec: 300,
    });
    expect(args[args.indexOf('-headers') + 1]).toBe('X-Emby-Token: t\r\n');
    expect(args.indexOf('-headers')).toBeLessThan(args.indexOf('-i'));
    expect(args[args.indexOf('-ss') + 1]).toBe('12');
    expect(args[args.indexOf('-t') + 1]).toBe('300');
  });
});

describe('makePcmDigester (QYP3-050)', () => {
  it('carries an odd trailing byte to the next chunk', () => {
    const digest = makePcmDigester();
    const first = digest(Buffer.from([1, 0, 2]));
    expect(first).not.toBeNull();
    expect(Array.from(first!)).toEqual([1]); // 第三个字节留到下一块
    const second = digest(Buffer.from([0, 3, 0]));
    expect(Array.from(second!)).toEqual([2, 3]);
  });

  it('returns null for a single dangling byte', () => {
    const digest = makePcmDigester();
    expect(digest(Buffer.from([7]))).toBeNull();
  });
});

describe('decodeToBands (QYP3-050)', () => {
  it('drains stdout synchronously and produces one frame per 1/12 s', async () => {
    const fake = fakeChild();
    const pending = decodeToBands('ffmpeg', { url: '/m/a.ape' }, { spawnFn: () => fake.proc });
    // 硬性约束 3：spawn 后必须立刻进入 flowing 模式（否则管道 64KB 写满就卡死）
    expect(fake.stdout.readableFlowing).toBe(true);

    fake.stdout.push(pcmBytes(1));
    await drain(fake.stdout);
    fake.emit('close', 0);
    const outcome = await pending;
    expect(outcome.status).toBe('ok');
    expect(outcome.status === 'ok' && outcome.frames.length).toBe(12);
    expect(outcome.status === 'ok' && outcome.frames[0].length).toBe(48);
  });

  it('keeps consuming a stream far larger than the 64KB pipe buffer', async () => {
    const fake = fakeChild();
    const pending = decodeToBands('ffmpeg', { url: '/m/a.ape' }, { spawnFn: () => fake.proc });
    const big = pcmBytes(30); // 30 秒 mono s16le @24k ≈ 1.4MB
    for (let off = 0; off < big.length; off += 8192) {
      fake.stdout.push(big.subarray(off, Math.min(big.length, off + 8192)));
    }
    await drain(fake.stdout);
    fake.emit('close', 0);
    const outcome = await pending;
    expect(outcome.status).toBe('ok');
    // 一秒 12 帧：30 秒 → 360 帧；少一帧都说明有块没被消费
    expect(outcome.status === 'ok' && outcome.frames.length).toBe(360);
  });

  it('maps ENOENT to no-ffmpeg (silent degradation)', async () => {
    const fake = fakeChild();
    const pending = decodeToBands('ffmpeg', { url: '/m/a.ape' }, { spawnFn: () => fake.proc });
    const err = Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' });
    fake.emit('error', err);
    expect((await pending).status).toBe('no-ffmpeg');
  });

  it('fails on a non-zero exit', async () => {
    const fake = fakeChild();
    const pending = decodeToBands('ffmpeg', { url: '/m/a.ape' }, { spawnFn: () => fake.proc });
    fake.emit('close', 1);
    expect((await pending).status).toBe('failed');
  });

  it('kills the child when aborted (switch track / quit)', async () => {
    const fake = fakeChild();
    const ac = new AbortController();
    const pending = decodeToBands('ffmpeg', { url: '/m/a.ape' }, { spawnFn: () => fake.proc, signal: ac.signal });
    ac.abort();
    expect((await pending).status).toBe('aborted');
    expect(fake.kill).toHaveBeenCalled();
  });

  it('kills the child on timeout', async () => {
    const fake = fakeChild();
    const outcome = await decodeToBands(
      'ffmpeg',
      { url: '/m/a.ape' },
      { spawnFn: () => fake.proc, timeoutMs: 5 }
    );
    expect(outcome.status).toBe('timeout');
    expect(fake.kill).toHaveBeenCalled();
  });

  it('never throws when spawn itself throws', async () => {
    const outcome = await decodeToBands('ffmpeg', { url: '/m/a.ape' }, {
      spawnFn: (() => {
        throw new Error('boom');
      }) as never,
    });
    expect(outcome.status).toBe('no-ffmpeg');
  });
});
