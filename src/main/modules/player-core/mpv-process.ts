import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync, existsSync } from 'fs';
import { getGeneratedConfPath } from '../ui-shell/mpv-bindings';
import { resolveMpvBinary } from '../platform/binary-locator';
import { createIpcEndpoint, type IpcEndpoint } from '../platform/ipc-endpoint';

export interface MpvOptions {
  extraArgs?: string[];
}

export class MpvProcessManager extends EventEmitter {
  private process: ChildProcess | null = null;
  private sockDir: string;
  private endpoint: IpcEndpoint;
  private crashed = false;

  constructor() {
    super();
    this.sockDir = join(tmpdir(), 'qy-player');
    if (!existsSync(this.sockDir)) {
      mkdirSync(this.sockDir, { recursive: true });
    }
    // 地址在 start() 时重新生成（构造期的只作占位）
    this.endpoint = createIpcEndpoint(this.sockDir, 'qy-player-mpv');
  }

  async start(options?: MpvOptions): Promise<string> {
    if (this.process) {
      await this.quit();
    }

    // Fresh endpoint on every start - a leftover socket file from a
    // previous mpv session would pass the existsSync() check before the
    // new mpv has bound it, causing ECONNREFUSED on connect.
    this.endpoint = createIpcEndpoint(this.sockDir, 'qy-player-mpv');
    this.endpoint.cleanup();
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

    // Prefer the bundled mpv (win/mac installers), then platform-specific
    // locations, then the self-built mpv (>= 0.32 with modern OSC); fall
    // back to the system mpv. The self-built binary needs our local libs on
    // the loader path (built without rpath). QYP3-061：候选序与平台差异
    // 收敛在 binary-locator，Linux 行为与历史逐字节一致。
    const mpv = resolveMpvBinary();
    const mpvBinary = mpv.path;
    const mpvEnv = mpv.env;

    const args = [
      '--input-ipc-server=' + this.endpoint.address,
      '--idle',
      // 不在启动时强制开窗：音频经 mpv 解码（服务器 / WebDAV / 冷门格式 /
      // 本地兜底）若任由 mpv 开窗会露黑屏（内嵌封面被当成 video 轨）。窗口
      // 由 playerLoadFile 按媒体类型决定（视频=yes，音乐=no，见 QYP3-032）。
      '--force-window=no',
      '--keep-open',
      '--save-position-on-quit=no',
      '--sub-auto=fuzzy',
      // 音乐（QYP3-012）：曲间无爆音衔接；对视频无副作用（仅音频轨道过渡）
      '--gapless-audio=weak',
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
      let settled = false;

      // Wait for the endpoint to accept connections (unix: socket file
      // exists; win32: named pipe connects). QYP3-061
      this.endpoint
        .waitUntilReady(5000)
        .then(() => {
          if (settled) return;
          settled = true;
          started = true;
          resolve(this.endpoint.address);
        })
        .catch(() => {
          if (settled) return;
          settled = true;
          this.kill();
          reject(new Error('MPV failed to start within 5 seconds'));
        });

      this.process.on('error', (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      });

      this.process.on('exit', (code, signal) => {
        this.process = null;
        if (settled) {
          // 已就绪过的意外退出 = 崩溃（沿用历史语义）
          if (started && !this.crashed) {
            this.crashed = true;
            this.emit('crashed', code, signal);
          }
          return;
        }
        settled = true;
        reject(new Error(`MPV exited early with code ${code}, signal ${signal}`));
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
    return this.endpoint.address;
  }

  isRunning(): boolean {
    return this.process !== null && !this.process.killed;
  }
}
