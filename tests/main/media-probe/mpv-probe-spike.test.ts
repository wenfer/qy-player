import { createServer, type Server, type Socket } from 'node:net';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assembleProbeResult,
  buildProbeArgs,
  PROBE_STDOUT_CAP,
  resolveMpvBinary,
  runProbeSpike,
  spawnProbeProcess,
  type ProbeSpawn,
} from '../../../src/main/modules/media-probe/mpv-probe-spike';

// ---------------------------------------------------------------------------
// Fake mpv: a unix-socket server speaking mpv's JSON IPC, with version-
// shaped canned properties. No mpv binary needed.
// ---------------------------------------------------------------------------

type PropMap = Record<string, unknown>;

const TRACKS_032 = [
  { type: 'video', codec: 'h264', 'demux-w': 1920, 'demux-h': 1080, 'demux-fps': 23.976 },
  { type: 'audio', codec: 'aac', lang: 'eng', 'audio-channels': 6, 'demux-samplerate': 48000 },
  { type: 'sub', codec: 'subrip', lang: 'chi', title: '中文', external: false, default: true },
];

const PROPS_032: PropMap = {
  'mpv-version': '0.32.0',
  duration: 3600.5,
  'file-format': 'Matroska',
  'video-format': 'h264',
  'video-params/w': 1920,
  'video-params/h': 1080,
  'container-fps': 23.976,
  'audio-codec': 'aac',
  'audio-params/channel-count': 6,
  'track-list': TRACKS_032,
};

const PROPS_029: PropMap = {
  'mpv-version': '0.29.1',
  duration: 120,
  'file-format': 'avi',
  'video-format': 'mpeg4',
  width: 1280,
  height: 720,
  'container-fps': 25,
  'audio-codec': 'ac3',
  'audio-channels': 2,
  'track-list': [
    { type: 'video', codec: 'mpeg4', 'demux-w': 1280, 'demux-h': 720, 'demux-fps': 25 },
    { type: 'audio', codec: 'ac3', lang: 'eng', 'audio-channels': 2, 'demux-samplerate': 44100 },
  ],
};

interface FakeMpvHandle {
  closeAll: () => Promise<void>;
  requests: string[];
  lastSpawn: { binary: string; args: string[] } | null;
}

/**
 * spawnFn factory: serves the fake mpv AT the socket path the orchestrator
 * computed (parsed from --input-ipc-server=). listen() completes within
 * milliseconds; the orchestrator's 50ms socket poll absorbs the race.
 */
function fakeSpawnFactory(props: PropMap | 'hang'): {
  spawnFn: (binary: string, args: string[]) => ProbeSpawn;
  handle: FakeMpvHandle;
} {
  const requests: string[] = [];
  const servers: Server[] = [];
  const handle: FakeMpvHandle = { closeAll: async () => {}, requests, lastSpawn: null };
  const spawnFn = (binary: string, args: string[]): ProbeSpawn => {
    handle.lastSpawn = { binary, args };
    const socketPath = args
      .find((a) => a.startsWith('--input-ipc-server='))
      ?.slice('--input-ipc-server='.length);
    if (!socketPath) throw new Error('fake mpv: no socket path in args');
    const server: Server = createServer((socket: Socket) => {
      let buffer = '';
      socket.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line) as { request_id: number; command: unknown[] };
            const [cmd, name] = msg.command as [string, string];
            requests.push(`${cmd}:${name ?? ''}`);
            if (props === 'hang') continue; // never answer: timeout path
            if (cmd === 'get_property') {
              const value = (props as PropMap)[name];
              if (value === undefined) {
                socket.write(JSON.stringify({ request_id: msg.request_id, error: 'property unavailable' }) + '\n');
              } else {
                socket.write(JSON.stringify({ request_id: msg.request_id, data: value, error: 'success' }) + '\n');
              }
            } else {
              socket.write(JSON.stringify({ request_id: msg.request_id, error: 'success' }) + '\n');
            }
          } catch {
            // ignore malformed lines
          }
        }
      });
    });
    servers.push(server);
    server.listen(socketPath);
    const child = {
      kill: () => true,
      once: () => child,
      stdout: null,
      stderr: null,
    } as unknown as ProbeSpawn['child'];
    return { binary, args, child, stdoutChunks: [] };
  };
  handle.closeAll = () =>
    Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve())))).then(() => undefined);
  return { spawnFn, handle };
}

let sockDir: string;
let handle: FakeMpvHandle | null = null;

beforeEach(() => {
  sockDir = mkdtempSync(join(tmpdir(), 'qy-probe-test-'));
});

afterEach(async () => {
  if (handle) {
    await handle.closeAll();
    handle = null;
  }
  rmSync(sockDir, { recursive: true, force: true });
});

describe('probe args (plan §10 locks)', () => {
  it('builds a headless, hermetic, software-decode command line', () => {
    const args = buildProbeArgs('/tmp/p.sock', '/media/a.mkv');
    expect(args).toContain('--vo=null');
    expect(args).toContain('--ao=null');
    expect(args).toContain('--hwdec=no');
    expect(args).toContain('--no-config');
    expect(args).toContain('--idle');
    expect(args).toContain('--input-ipc-server=/tmp/p.sock');
    expect(args[args.length - 1]).toBe('/media/a.mkv');
    expect(args.some((a) => a.startsWith('--force-window'))).toBe(false);
    expect(args.some((a) => a.startsWith('--script'))).toBe(false);
    expect(args.some((a) => a.startsWith('--config-dir'))).toBe(false);
  });

  it('prefers the self-built binary, falls back to PATH mpv', () => {
    expect(resolveMpvBinary('/nonexistent-home-xyz')).toBe('mpv');
  });
});

describe('assembleProbeResult', () => {
  it('maps the 0.32 shape to the unified result', () => {
    const props = new Map(Object.entries(PROPS_032));
    const result = assembleProbeResult('0.32.0', props);
    expect(result.version).toBe('0.32.0');
    expect(result.duration).toBeCloseTo(3600.5);
    expect(result.container).toBe('Matroska');
    expect(result.video).toMatchObject({ codec: 'h264', width: 1920, height: 1080, fps: 23.976 });
    expect(result.audio).toMatchObject({ codec: 'aac', channels: 6 });
    expect(result.tracks).toHaveLength(3);
    expect(result.tracks.find((t) => t.kind === 'subtitle')).toMatchObject({
      codec: 'subrip',
      language: 'chi',
      isDefault: true,
    });
    expect(result.unsupported).not.toContain('video.width');
  });

  it('maps the 0.29 shape through the fallback names', () => {
    const props = new Map(Object.entries(PROPS_029));
    const result = assembleProbeResult('0.29.1', props);
    expect(result.video).toMatchObject({ codec: 'mpeg4', width: 1280, height: 720, fps: 25 });
    expect(result.audio).toMatchObject({ codec: 'ac3', channels: 2 });
    expect(result.tracks).toHaveLength(2);
    expect(result.unsupported).not.toContain('audio.channels');
  });

  it('records unsupported fields instead of throwing', () => {
    const result = assembleProbeResult('unknown', new Map([['duration', 10]]));
    expect(result.duration).toBe(10);
    expect(result.video).toBeUndefined();
    expect(result.unsupported).toContain('video.codec');
    expect(result.unsupported).toContain('container');
  });

  it('skips malformed track entries', () => {
    const result = assembleProbeResult('x', new Map([['track-list', [null, 42, { type: 'weird' }]]]));
    expect(result.tracks).toEqual([]);
  });
});

describe('runProbeSpike against the fake mpv', () => {
  it('completes a full probe on the 0.32 shape', async () => {
    const faked = fakeSpawnFactory(PROPS_032);
    handle = faked.handle;
    const result = await runProbeSpike({
      target: '/media/a.mkv',
      mpvBinary: 'fake-mpv',
      socketDir: sockDir,
      spawnFn: faked.spawnFn,
    });
    expect(result.version).toBe('0.32.0');
    expect(result.duration).toBeCloseTo(3600.5);
    expect(result.video?.width).toBe(1920);
    expect(result.tracks).toHaveLength(3);
    // Socket cleanup: the orchestrator removes its own socket file.
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(sockDir).some((f) => f.startsWith('probe-'))).toBe(false);
  });

  it('uses fallbacks on the 0.29 shape', async () => {
    const faked = fakeSpawnFactory(PROPS_029);
    handle = faked.handle;
    const result = await runProbeSpike({
      target: '/media/b.avi',
      mpvBinary: 'fake-mpv',
      socketDir: sockDir,
      spawnFn: faked.spawnFn,
    });
    expect(result.version).toBe('0.29.1');
    expect(result.video).toMatchObject({ width: 1280, height: 720 });
    expect(result.audio).toMatchObject({ channels: 2 });
  });

  it('times out against a hanging mpv and reports TIMEOUT', async () => {
    const faked = fakeSpawnFactory('hang');
    handle = faked.handle;
    await expect(
      runProbeSpike({
        target: '/media/c.mkv',
        mpvBinary: 'fake-mpv',
        socketDir: sockDir,
        timeoutMs: 800,
        spawnFn: faked.spawnFn,
      })
    ).rejects.toMatchObject({ name: 'ProbeError', code: 'TIMEOUT' });
  }, 10000);

  it('surfaces spawn failures as SPAWN', async () => {
    await expect(
      runProbeSpike({
        target: '/media/d.mkv',
        mpvBinary: 'fake-mpv',
        socketDir: sockDir,
        spawnFn: () => {
          throw new Error('ENOENT');
        },
      })
    ).rejects.toMatchObject({ code: 'SPAWN' });
  });
});

describe('probe process plumbing (spawnProbeProcess)', () => {
  it('caps stdout collection', async () => {
    const spawned = spawnProbeProcess(process.execPath, [
      '-e',
      `process.stdout.write('x'.repeat(300 * 1024));`,
    ]);
    await new Promise<void>((resolve) => {
      spawned.child.once('exit', () => resolve());
      setTimeout(resolve, 5000);
    });
    const total = spawned.stdoutChunks.reduce((n, c) => n + c.length, 0);
    expect(total).toBeLessThanOrEqual(PROBE_STDOUT_CAP + 65536);
    expect(total).toBeGreaterThan(0);
  });

  it('drains stderr without deadlocking', async () => {
    const spawned = spawnProbeProcess(process.execPath, [
      '-e',
      `process.stderr.write('e'.repeat(300 * 1024)); process.exit(0);`,
    ]);
    const code = await new Promise<number | null>((resolve) => {
      spawned.child.once('exit', (c) => resolve(c));
      setTimeout(() => resolve('timeout' as unknown as number), 5000);
    });
    expect(code).toBe(0);
  });
});
