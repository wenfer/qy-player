import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { MpvIpcClient } from '../player-core/mpv-ipc-client';

/**
 * mpv probe spike (plan §10, QYP2-017).
 *
 * Compares and locks the probing approach for mpv 0.29 (Debian 10 system)
 * and 0.32 (self-built): a throwaway headless mpv owned entirely by the
 * probe (own socket, own process, isolated from the playback instance),
 * queried over JSON IPC with per-property fallbacks per version.
 * See docs/decisions/0005-mpv-probe.md for the locked parameters.
 */

export const PROBE_TIMEOUT_MS = 15_000;
export const PROBE_SETTLE_MS = 3_000;
export const PROBE_STDOUT_CAP = 64 * 1024;

export class ProbeError extends Error {
  readonly code: 'SPAWN' | 'TIMEOUT' | 'CONNECT' | 'UNAVAILABLE';
  constructor(code: ProbeError['code'], message: string) {
    super(message);
    this.name = 'ProbeError';
    this.code = code;
  }
}

/** Resolve the mpv binary the same way playback does (self-built first). */
export function resolveMpvBinary(homeDir?: string): string {
  const home = homeDir ?? process.env.HOME ?? '/home';
  const homeMpv = join(home, '.local', 'bin', 'mpv');
  return existsSync(homeMpv) ? homeMpv : 'mpv';
}

/**
 * Headless, hermetic probe arguments. Never creates a window, never
 * inherits user scripts/config, never enables hardware decoding:
 * - --vo=null --ao=null: no window, no audio device, demux still parses
 * - --idle: stay alive for IPC queries after the file loads
 * - --no-config: no user scripts, no input conf, no mpv.conf
 * - --hwdec=no: software decode only (plan §10 + AGENTS.md)
 */
export function buildProbeArgs(socketPath: string, target: string): string[] {
  return [
    `--input-ipc-server=${socketPath}`,
    '--idle',
    '--no-config',
    '--vo=null',
    '--ao=null',
    '--hwdec=no',
    target,
  ];
}

export interface ProbeTrack {
  kind: 'video' | 'audio' | 'subtitle';
  codec?: string;
  language?: string;
  title?: string;
  width?: number;
  height?: number;
  fps?: number;
  channels?: number;
  samplerate?: number;
  external?: boolean;
  isDefault?: boolean;
}

export interface ProbeResult {
  /** `mpv-version` property, or 'unknown' when unreadable. */
  version: string;
  /** Seconds; absent when the demuxer cannot report it. */
  duration?: number;
  /** Demuxer/container name (file-format), e.g. 'Matroska'. */
  container?: string;
  video?: { codec?: string; width?: number; height?: number; fps?: number; aspect?: number };
  audio?: { codec?: string; channels?: number; samplerate?: number };
  tracks: ProbeTrack[];
  /** Field keys no candidate property could supply on this version. */
  unsupported: string[];
}

/**
 * Candidate property names per field, newest-first. The spike queries each
 * in order and records the field unsupported only when every candidate
 * fails — this is what makes one code path serve 0.29 and 0.32.
 */
export const PROBE_FIELD_CANDIDATES: Record<string, string[]> = {
  duration: ['duration'],
  container: ['file-format'],
  'video.codec': ['video-format', 'video-codec'],
  'video.width': ['video-params/w', 'width'],
  'video.height': ['video-params/h', 'height'],
  'video.fps': ['container-fps', 'fps'],
  'video.aspect': ['video-params/aspect', 'video-aspect'],
  'audio.codec': ['audio-codec'],
  'audio.channels': ['audio-params/channel-count', 'audio-channels'],
  'audio.samplerate': ['audio-params/samplerate', 'audio-samplerate', 'demux-samplerate'],
};

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function pick(props: Map<string, unknown>, field: string): { value?: unknown; supported: boolean } {
  for (const name of PROBE_FIELD_CANDIDATES[field] ?? []) {
    if (props.has(name)) return { value: props.get(name), supported: true };
  }
  return { supported: false };
}

/**
 * Assemble a unified result from raw property values (pure: the same map
 * always yields the same result). track-list is the primary track source
 * on both versions; top-level properties fill the selected-stream summary.
 */
export function assembleProbeResult(version: string, props: Map<string, unknown>): ProbeResult {
  const unsupported: string[] = [];
  const get = (field: string): unknown => {
    const picked = pick(props, field);
    if (!picked.supported) unsupported.push(field);
    return picked.value;
  };

  const duration = num(get('duration'));
  const container = str(get('container'));
  const video = {
    codec: str(get('video.codec')),
    width: num(get('video.width')),
    height: num(get('video.height')),
    fps: num(get('video.fps')),
    aspect: num(get('video.aspect')),
  };
  const audio = {
    codec: str(get('audio.codec')),
    channels: num(get('audio.channels')),
    samplerate: num(get('audio.samplerate')),
  };

  const tracks: ProbeTrack[] = [];
  const rawTracks = props.get('track-list');
  if (Array.isArray(rawTracks)) {
    for (const raw of rawTracks) {
      if (typeof raw !== 'object' || raw === null) continue;
      const entry = raw as Record<string, unknown>;
      const type = entry.type;
      if (type !== 'video' && type !== 'audio' && type !== 'sub') continue;
      const track: ProbeTrack = {
        kind: type === 'sub' ? 'subtitle' : type,
        codec: str(entry.codec),
        language: str(entry.lang),
        title: str(entry.title),
        external: entry.external === true ? true : undefined,
        isDefault: entry.default === true ? true : undefined,
      };
      if (track.kind === 'video') {
        track.width = num(entry['demux-w']);
        track.height = num(entry['demux-h']);
        track.fps = num(entry['demux-fps']);
      }
      if (track.kind === 'audio') {
        track.channels = num(entry['audio-channels']) ?? num(entry['demux-channel-count']);
        track.samplerate = num(entry['demux-samplerate']);
      }
      tracks.push(track);
    }
  }

  const result: ProbeResult = { version, tracks, unsupported };
  if (duration !== undefined) result.duration = duration;
  if (container !== undefined) result.container = container;
  if (video.codec !== undefined || video.width !== undefined || video.height !== undefined) {
    result.video = {
      ...(video.codec !== undefined ? { codec: video.codec } : {}),
      ...(video.width !== undefined ? { width: video.width } : {}),
      ...(video.height !== undefined ? { height: video.height } : {}),
      ...(video.fps !== undefined ? { fps: video.fps } : {}),
      ...(video.aspect !== undefined ? { aspect: video.aspect } : {}),
    };
  }
  if (audio.codec !== undefined || audio.channels !== undefined) {
    result.audio = {
      ...(audio.codec !== undefined ? { codec: audio.codec } : {}),
      ...(audio.channels !== undefined ? { channels: audio.channels } : {}),
      ...(audio.samplerate !== undefined ? { samplerate: audio.samplerate } : {}),
    };
  }
  return result;
}

// ---------------------------------------------------------------------------
// Orchestrator (injectable process + IPC for tests)
// ---------------------------------------------------------------------------

export interface ProbeSpawn {
  binary: string;
  args: string[];
  child: ChildProcess;
  stdoutChunks: Buffer[];
}

export interface ProbeDeps {
  target: string;
  mpvBinary?: string;
  socketDir?: string;
  timeoutMs?: number;
  spawnFn?: (binary: string, args: string[]) => ProbeSpawn;
}

/** Default process plumbing (QYP2-018 reuses this for the probe service). */
export function spawnProbeProcess(binary: string, args: string[]): ProbeSpawn {
  const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const stdoutChunks: Buffer[] = [];
  let stdoutBytes = 0;
  child.stdout?.on('data', (chunk: Buffer) => {
    // Bounded stdout (plan §10): diagnostics only, never unbounded; the
    // final chunk is truncated to the remaining budget, never overruns.
    if (stdoutBytes < PROBE_STDOUT_CAP) {
      const room = PROBE_STDOUT_CAP - stdoutBytes;
      stdoutChunks.push(room < chunk.length ? chunk.subarray(0, room) : chunk);
      stdoutBytes += Math.min(room, chunk.length);
    }
  });
  // Drain stderr silently so the pipe never blocks mpv (AGENTS.md).
  child.stderr?.on('data', () => undefined);
  return { binary, args, child, stdoutChunks };
}

async function waitForSocket(
  socketPath: string,
  timeoutMs: number,
  failed?: () => Error | null
): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (existsSync(socketPath)) return;
    const spawnError = failed?.();
    if (spawnError) {
      throw new ProbeError('SPAWN', `mpv 启动失败: ${spawnError.message}`);
    }
    if (Date.now() - started > timeoutMs) {
      throw new ProbeError('TIMEOUT', 'mpv 探测 socket 超时');
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function killChild(child: ChildProcess): void {
  try {
    child.kill('SIGTERM');
    setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
    }, 1000).unref?.();
  } catch {
    // already gone
  }
}

/**
 * One property query: property errors (unsupported on this version) yield
 * undefined; the orchestrator deadline always wins the race so a hanging
 * property cannot drag the probe past its timeout.
 */
async function queryProperty(
  ipc: MpvIpcClient,
  name: string,
  deadline: number,
  extraRace?: Promise<unknown>[]
): Promise<unknown> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new ProbeError('TIMEOUT', 'mpv 探测超时');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      ipc.getProperty(name).catch(() => undefined as unknown),
      ...(extraRace ?? []),
      new Promise<unknown>((_, reject) => {
        timer = setTimeout(() => reject(new ProbeError('TIMEOUT', 'mpv 探测超时')), remaining);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Reject with a ProbeError once the deadline passes. */
async function raceDeadline<T>(promise: Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new ProbeError('TIMEOUT', 'mpv 探测超时');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ProbeError('TIMEOUT', 'mpv 探测超时')), remaining);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function getPropertyAllowingFailure(
  ipc: MpvIpcClient,
  name: string,
  deadline: number,
  extraRace?: Promise<unknown>[]
): Promise<unknown> {
  try {
    return await queryProperty(ipc, name, deadline, extraRace);
  } catch (err) {
    if (err instanceof ProbeError) throw err;
    return undefined;
  }
}

/**
 * Run one throwaway probe. Owns its process and socket end-to-end; always
 * kills the child and removes the socket, including on timeout.
 */
export async function runProbeSpike(deps: ProbeDeps): Promise<ProbeResult> {
  const timeoutMs = deps.timeoutMs ?? PROBE_TIMEOUT_MS;
  const socketDir = deps.socketDir ?? join(tmpdir(), 'qy-probe');
  try {
    mkdirSync(socketDir, { recursive: true });
  } catch {
    // exists / raced - mpv will surface a real error if binding fails
  }
  const socketPath = join(socketDir, `probe-${process.pid}-${Date.now()}.sock`);
  try {
    rmSync(socketPath, { force: true });
  } catch {
    // ignore
  }
  const binary = deps.mpvBinary ?? resolveMpvBinary();
  const args = buildProbeArgs(socketPath, deps.target);
  const spawnFn = deps.spawnFn ?? spawnProbeProcess;

  let spawned: ProbeSpawn;
  try {
    spawned = spawnFn(binary, args);
  } catch (err) {
    throw new ProbeError('SPAWN', err instanceof Error ? `mpv 启动失败: ${err.message}` : 'mpv 启动失败');
  }
  const deadline = Date.now() + timeoutMs;
  const finish = (): void => {
    killChild(spawned.child);
    try {
      rmSync(socketPath, { force: true });
    } catch {
      // ignore
    }
  };
  let spawnError: Error | null = null;
  let earlyExit: string | null = null;
  spawned.child.once('error', (err) => {
    spawnError = err;
  });
  spawned.child.once('exit', (code, signal) => {
    earlyExit = `code=${code ?? 'null'} signal=${signal ?? 'null'}`;
  });
  try {
    await waitForSocket(socketPath, Math.min(5000, timeoutMs), () => {
      if (spawnError) return spawnError;
      if (earlyExit !== null) {
        return new Error(`mpv 提前退出 (${earlyExit})，无法解析目标`);
      }
      return null;
    });
    const ipc = new MpvIpcClient(socketPath);
    try {
      // connect() resolves on 'connect' and rejects on pre-connect socket
      // errors; the deadline race keeps a hung accept from blocking.
      await raceDeadline(ipc.connect(), deadline);
    } catch (err) {
      if (err instanceof ProbeError) throw err;
      throw new ProbeError('CONNECT', err instanceof Error ? `mpv IPC 连接失败: ${err.message}` : 'mpv IPC 连接失败');
    }
    // A dead mpv must abort the probe as UNAVAILABLE, not degrade into a
    // "success" whose every field is unsupported (plan §10: distinguish
    // timeout / offline / unsupported).
    const disconnected = new Promise<never>((_, reject) => {
      ipc.once('disconnect', () => reject(new ProbeError('UNAVAILABLE', 'mpv IPC 断开（探测进程已退出）')));
    });
    try {
      const versionRaw = await getPropertyAllowingFailure(ipc, 'mpv-version', deadline, [disconnected]);
      const version = typeof versionRaw === 'string' && versionRaw ? versionRaw : 'unknown';

      // Let the demuxer settle: duration appears once the file is parsed.
      const props = new Map<string, unknown>();
      const fields = [...Object.keys(PROBE_FIELD_CANDIDATES), 'track-list'];
      const settleUntil = Date.now() + Math.min(PROBE_SETTLE_MS, Math.max(0, deadline - Date.now()));
      while (Date.now() < settleUntil) {
        const duration = await getPropertyAllowingFailure(ipc, 'duration', deadline, [disconnected]);
        if (typeof duration === 'number' && duration > 0) {
          props.set('duration', duration);
          break;
        }
        // Streams may report duration late or never; still probe the rest.
        if (Date.now() + 200 >= settleUntil) break;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      for (const field of fields) {
        if (field === 'duration' && props.has('duration')) continue;
        if (field === 'track-list') {
          const tracks = await getPropertyAllowingFailure(ipc, 'track-list', deadline, [disconnected]);
          if (tracks !== undefined) props.set('track-list', tracks);
          continue;
        }
        const candidates = PROBE_FIELD_CANDIDATES[field] ?? [];
        for (const name of candidates) {
          const value = await getPropertyAllowingFailure(ipc, name, deadline, [disconnected]);
          if (value !== undefined) {
            props.set(name, value);
            break;
          }
        }
      }
      return assembleProbeResult(version, props);
    } finally {
      ipc.disconnect();
    }
  } finally {
    finish();
  }
}
