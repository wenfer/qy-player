import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync, existsSync, rmSync } from 'fs';
import { getGeneratedConfPath } from '../ui-shell/mpv-bindings';

export interface MpvOptions {
  socketPath?: string;
  extraArgs?: string[];
}

export class MpvProcessManager extends EventEmitter {
  private process: ChildProcess | null = null;
  private socketPath: string;
  private sockDir: string;
  private crashed = false;

  constructor() {
    super();
    this.sockDir = join(tmpdir(), 'qy-player');
    if (!existsSync(this.sockDir)) {
      mkdirSync(this.sockDir, { recursive: true });
    }
    this.socketPath = join(this.sockDir, `mpv-${Date.now()}.sock`);
  }

  async start(options?: MpvOptions): Promise<string> {
    if (this.process) {
      await this.quit();
    }

    // Fresh socket path on every start - a leftover socket file from a
    // previous mpv session would pass the existsSync() check before the
    // new mpv has bound it, causing ECONNREFUSED on connect.
    this.socketPath = options?.socketPath || join(this.sockDir, `mpv-${Date.now()}.sock`);
    try {
      rmSync(this.socketPath, { force: true });
    } catch {
      // ignore - file may not exist
    }
    this.crashed = false;

    // Modern UI: uosc 2.17 (replacement for the built-in osc). Verified
    // compatible with mpv 0.32 (no osd-overlay dependency). Requires
    // --osc=no so the two UIs don't fight. Falls back to the built-in
    // bottom-bar OSC when the script is missing.
    // The input conf layers volume-wheel/double-click-fullscreen on top of
    // mpv defaults; only included when the file exists (dev + packaged).
    // Prefer the generated conf (user-customized bindings); fall back to
    // the bundled defaults when it has never been written.
    const bundledInputConf = join(__dirname, '..', 'resources', 'mpv-input.conf');
    const generatedConf = getGeneratedConfPath();
    const inputConfPath = existsSync(generatedConf) ? generatedConf : bundledInputConf;
    const uoscPath = join(__dirname, '..', 'resources', 'uosc.lua');
    const configDir = join(__dirname, '..', 'resources', 'mpv-config');
    const hasUosc = existsSync(uoscPath);
    const scriptOpts = [
      'osc-layout=bottombar',
      'osc-seekbarstyle=bar',
      'osc-deadzonesize=0',
      'osc-hidetimeout=1500',
      'osc-fadeduration=200',
      'osc-title=${media-title}',
      'osc-boxalpha=60',
      'osc-seekrangealpha=200',
    ].join(',');

    // Prefer the self-built mpv (>= 0.32 with modern OSC); fall back to
    // the system mpv. The self-built binary needs our local libs on the
    // loader path (built without rpath).
    const homeMpv = join(process.env.HOME || '/home', '.local', 'bin', 'mpv');
    const mpvBinary = existsSync(homeMpv) ? homeMpv : 'mpv';
    const mpvEnv = existsSync(homeMpv)
      ? {
          ...process.env,
          LD_LIBRARY_PATH: join(process.env.HOME || '/home', '.local', 'lib'),
        }
      : process.env;

    const args = [
      '--input-ipc-server=' + this.socketPath,
      '--idle',
      '--force-window=immediate',
      '--keep-open',
      '--save-position-on-quit=no',
      '--sub-auto=fuzzy',
      '--fs=no',
      // Software decoding only: hwdec on Linux (vaapi/vdpau) is unstable
      // with online streams and commonly freezes after ~30s of playback.
      '--hwdec=no',
      // Network stream buffering: prevents stutter on slow/congested LAN
      '--cache=yes',
      '--cache-secs=30',
      '--demuxer-readahead-secs=30',
      ...(existsSync(configDir) ? [`--config-dir=${configDir}`] : []),
      hasUosc ? '--osc=no' : '--osc',
      ...(hasUosc ? [`--script=${uoscPath}`] : [`--script-opts=${scriptOpts}`]),
      '--osd-font-size=28',
      '--osd-duration=1800',
      '--osd-color=#E6FFFFFF',
      '--osd-border-color=#E6101010',
      '--osd-shadow-color=#80101010',
      '--title=${media-title}',
      '--osd-playing-msg=${media-title}',
      ...(existsSync(inputConfPath) ? [`--input-conf=${inputConfPath}`] : []),
      ...(options?.extraArgs || []),
    ];

    return new Promise((resolve, reject) => {
      this.process = spawn(mpvBinary, args, {
        env: mpvEnv,
        detached: false,
      });

      // Drain stdout/stderr so the pipe buffer never fills and blocks mpv.
      // Silence is intentional: only swallow the output, never log it.
      this.process.stdout?.on('data', () => {});
      this.process.stderr?.on('data', () => {});

      let started = false;

      // Wait for socket file to be created
      const checkSocket = setInterval(() => {
        if (existsSync(this.socketPath)) {
          clearInterval(checkSocket);
          started = true;
          resolve(this.socketPath);
        }
      }, 100);

      // Timeout after 5s
      setTimeout(() => {
        if (!started) {
          clearInterval(checkSocket);
          this.kill();
          reject(new Error('MPV failed to start within 5 seconds'));
        }
      }, 5000);

      this.process.on('error', (err) => {
        clearInterval(checkSocket);
        reject(err);
      });

      this.process.on('exit', (code, signal) => {
        clearInterval(checkSocket);
        this.process = null;
        if (!started) {
          reject(new Error(`MPV exited early with code ${code}, signal ${signal}`));
        } else if (!this.crashed) {
          this.crashed = true;
          this.emit('crashed', code, signal);
        }
      });
    });
  }

  async quit(): Promise<void> {
    if (!this.process) return;

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.kill();
        resolve();
      }, 3000);

      this.process!.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });

      this.process!.kill('SIGTERM');
    });
  }

  kill(): void {
    if (this.process) {
      this.process.kill('SIGKILL');
      this.process = null;
    }
  }

  getSocketPath(): string {
    return this.socketPath;
  }

  isRunning(): boolean {
    return this.process !== null && !this.process.killed;
  }
}
