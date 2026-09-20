/**
 * 用外部 ffmpeg 把一首曲目解成频带矩阵（QYP3-050）。
 *
 * 解到 **stdout**（单声道 s16le @ 24000Hz，48 KB/s），不落中间 WAV：
 * 边到边喂 `BandFrameEncoder`，IO 与内存都最省。
 *
 * 硬性约束（AGENTS.md 第 3 条）：spawn 后必须**同步**挂上 stdout/stderr 的
 * `data` 监听——管道写满 64KB 而无人读，子进程会卡死。stderr 按同一约束
 * 只吞不转发（ffmpeg 日志静默）。
 *
 * 认证：服务器/WebDAV 的 URL 与头由主进程从播放路径原样递进来（`-headers`
 * 用的就是喂给 mpv 的同一份字符串）；**URL 与头绝不进日志**。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { BandFrameEncoder } from './pcm-fft';
import { SPECTRUM_SAMPLE_RATE } from './spectrum-format';

export interface DecodeRequest {
  /** 本地绝对路径，或服务器/WebDAV 的上游 URL。 */
  url: string;
  /** `Header: value\r\n` 形式（与 mpv 的 http-header-fields 同格式）。 */
  headers?: string;
  /** 只解这一段（秒）；CUE 分轨预留。 */
  startSec?: number;
  durationSec?: number;
}

export type DecodeOutcome =
  | { status: 'ok'; frames: Uint8Array[] }
  | { status: 'no-ffmpeg' }
  | { status: 'aborted' }
  | { status: 'timeout' }
  | { status: 'failed' };

/**
 * 只用到 spawn 的一小部分：注入假实现（测试）时不必伪造整个
 * `ChildProcessWithoutNullStreams`。
 */
export type SpawnLike = (
  command: string,
  args: string[],
  options: { stdio: ['ignore', 'pipe', 'pipe'] }
) => ChildProcess;

export interface DecodeDeps {
  /** 默认真实 spawn；测试注入假实现。 */
  spawnFn?: SpawnLike;
  /** 硬超时（默认 90s，老机解长曲目给足时间）。 */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export const DECODE_TIMEOUT_MS = 90_000;

/** ffmpeg 参数（纯函数，便于锁住契约）。 */
export function buildFfmpegArgs(req: DecodeRequest): string[] {
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error'];
  if (req.headers) args.push('-headers', req.headers);
  if (req.startSec && req.startSec > 0) args.push('-ss', String(req.startSec));
  if (req.durationSec && req.durationSec > 0) args.push('-t', String(req.durationSec));
  args.push(
    '-i',
    req.url,
    '-vn',
    '-map',
    'a:0',
    '-f',
    's16le',
    '-acodec',
    'pcm_s16le',
    '-ac',
    '1',
    '-ar',
    String(SPECTRUM_SAMPLE_RATE),
    '-'
  );
  return args;
}

/** s16le 字节 → Int16Array（保证 2 字节对齐；跨块不齐的部分留给下一次）。 */
export function makePcmDigester(): (chunk: Buffer) => Int16Array | null {
  let carry = Buffer.alloc(0);
  return (chunk: Buffer): Int16Array | null => {
    const merged = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
    const usable = merged.length - (merged.length % 2);
    carry = usable === merged.length ? Buffer.alloc(0) : merged.subarray(usable);
    if (usable === 0) return null;
    // 自己开 ArrayBuffer：Buffer 池的 byteOffset 不保证 2 对齐
    const ab = new ArrayBuffer(usable);
    new Uint8Array(ab).set(merged.subarray(0, usable));
    return new Int16Array(ab);
  };
}

/**
 * 解码并算频带。**永不 throw**：一切异常都映射成上面的 outcome，调用方只需
 * 静默降级。
 */
export function decodeToBands(
  bin: string,
  req: DecodeRequest,
  deps: DecodeDeps = {}
): Promise<DecodeOutcome> {
  const spawnFn: SpawnLike = deps.spawnFn ?? (spawn as unknown as SpawnLike);
  const timeoutMs = deps.timeoutMs ?? DECODE_TIMEOUT_MS;

  return new Promise<DecodeOutcome>((resolve) => {
    if (deps.signal?.aborted) {
      resolve({ status: 'aborted' });
      return;
    }
    const encoder = new BandFrameEncoder();
    let settled = false;
    let child: ChildProcess | null = null;
    let hardTimer: NodeJS.Timeout | null = null;

    const finish = (outcome: DecodeOutcome): void => {
      if (settled) return;
      settled = true;
      if (hardTimer) clearTimeout(hardTimer);
      deps.signal?.removeEventListener('abort', onAbort);
      if (child && child.exitCode === null && child.signalCode === null) {
        try {
          child.kill('SIGKILL');
        } catch {
          // 已退出
        }
      }
      resolve(outcome);
    };
    function onAbort(): void {
      finish({ status: 'aborted' });
    }
    deps.signal?.addEventListener('abort', onAbort, { once: true });
    hardTimer = setTimeout(() => finish({ status: 'timeout' }), timeoutMs);

    try {
      child = spawnFn(bin, buildFfmpegArgs(req), { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      finish({ status: 'no-ffmpeg' });
      return;
    }
    const proc = child;

    // 同步挂上 data（硬性约束 3）：PCM 立刻消费，stderr 只吞不转发
    const digest = makePcmDigester();
    proc.stdout?.on('data', (chunk: Buffer) => {
      const pcm = digest(chunk);
      if (pcm) encoder.push(pcm);
    });
    proc.stderr?.on('data', () => {
      // 有意静默：ffmpeg 日志不进主进程控制台
    });

    proc.on('error', (e: NodeJS.ErrnoException) => {
      finish(e?.code === 'ENOENT' ? { status: 'no-ffmpeg' } : { status: 'failed' });
    });
    proc.on('close', (code: number | null) => {
      if (settled) return;
      if (code !== 0) {
        finish({ status: 'failed' });
        return;
      }
      finish({ status: 'ok', frames: encoder.frames });
    });
  });
}
