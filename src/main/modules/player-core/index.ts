import { MpvIpcClient } from './mpv-ipc-client';
import { MpvProcessManager, MpvOptions } from './mpv-process';
import { isWin } from '../platform';
import { EventEmitter } from 'events';
import type { ReplayGainChain } from '../playback-engine/replaygain';

export { MpvIpcClient, MpvProcessManager };
export type { MpvOptions };

export interface PlayerState {
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  isMuted: boolean;
  isFullscreen: boolean;
}

/**
 * sub-add argument builder (QYP2-021): only select/auto — both exist on
 * mpv 0.29; 'cached' is 0.33+ and must not be sent (older mpv rejects it).
 */
export function buildSubAddArgs(path: string, flag?: 'select' | 'auto'): string[] {
  return ['sub-add', path, ...(flag ? [flag] : [])];
}

/**
 * Resolve once mpv signals file-loaded (QYP2-021): sub-add before the
 * demuxer is ready fails on older mpv, so injection waits for this event.
 * False on timeout (the caller may still attempt a best-effort injection).
 */
export async function waitForFileLoadedEvent(
  ipc: EventEmitter,
  timeoutMs = 5000
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const onEvent = (msg: { event?: string }): void => {
      if (msg.event === 'file-loaded') {
        cleanup();
        resolve(true);
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);
    const cleanup = (): void => {
      clearTimeout(timer);
      ipc.off('event', onEvent);
    };
    ipc.on('event', onEvent);
  });
}

export class PlayerCore extends EventEmitter {
  private processManager: MpvProcessManager;
  private ipc: MpvIpcClient | null = null;
  private state: PlayerState = {
    isPlaying: false,
    currentTime: 0,
    duration: 0,
    volume: 100,
    isMuted: false,
    isFullscreen: false,
  };

  constructor() {
    super();
    this.processManager = new MpvProcessManager();
    this.processManager.on('crashed', () => {
      // MPV process died (user pressed q / window closed) -
      // drop the stale IPC client so isReady() returns false
      // and the next loadFile() restarts a fresh player.
      this.ipc = null;
      this.state.isPlaying = false;
      this.emit('crashed');
    });
  }

  async start(options?: MpvOptions): Promise<void> {
    const socketPath = await this.processManager.start(options);
    this.ipc = new MpvIpcClient(socketPath);
    await this.ipc.connect();

    // Observe key properties
    this.ipc.observeProperty('time-pos');
    this.ipc.observeProperty('duration');
    this.ipc.observeProperty('pause');
    this.ipc.observeProperty('volume');
    this.ipc.observeProperty('mute');
    this.ipc.observeProperty('fullscreen');
    this.ipc.observeProperty('eof-reached');

    this.ipc.on('property-change:time-pos', (data) => {
      // null = no file loaded (initial observe / fired again on unload at
      // quit). Keeping the last real position is critical: the disconnect
      // save fires right after this event, and writing 0 here would
      // overwrite the whole session's progress with 0.
      if (typeof data !== 'number') return;
      this.state.currentTime = data;
      this.emit('time-pos', data);
    });

    this.ipc.on('property-change:duration', (data) => {
      // Same null-on-unload rule as time-pos
      if (typeof data !== 'number' || data <= 0) return;
      this.state.duration = data;
      this.emit('duration', data);
    });

    this.ipc.on('property-change:pause', (data) => {
      this.state.isPlaying = data !== true;
      this.emit('pause', data);
    });

    this.ipc.on('property-change:volume', (data) => {
      this.state.volume = typeof data === 'number' ? data : 100;
      this.emit('volume', this.state.volume);
    });

    this.ipc.on('property-change:mute', (data) => {
      this.state.isMuted = data === true;
      this.emit('mute', this.state.isMuted);
    });

    this.ipc.on('property-change:fullscreen', (data) => {
      this.state.isFullscreen = data === true;
      this.emit('fullscreen', this.state.isFullscreen);
    });

    this.ipc.on('property-change:eof-reached', (data) => {
      if (data === true) {
        this.emit('eof');
      }
    });

    this.ipc.on('disconnect', () => {
      this.ipc = null;
      this.state.isPlaying = false;
      this.emit('disconnect');
    });

    this.emit('ready');
  }

  async quit(): Promise<void> {
    // Windows（QYP3-062）：SIGTERM 会退化为 TerminateProcess，mpv 得不到
    // 优雅退出——先经 IPC 下发 `quit` 命令（限时 1s，掉线/失败走强杀兜底）。
    // unix 沿用信号路径，语义不变。
    if (isWin && this.ipc) {
      try {
        await Promise.race([
          this.ipc.command('quit'),
          new Promise((resolve) => {
            const t = setTimeout(resolve, 1000);
            (t as NodeJS.Timeout).unref?.();
          }),
        ]);
      } catch {
        // IPC 已断开也无妨：processManager.quit() 里的强杀兜底
      }
    }
    if (this.ipc) {
      this.ipc.disconnect();
      this.ipc = null;
    }
    await this.processManager.quit();
  }

  async loadFile(path: string, startPosition?: number, httpHeaders?: string): Promise<void> {
    if (!this.ipc) throw new Error('Player not started');
    // Streaming (transcode HLS) endpoints need auth on EVERY request -
    // segment URLs generated by the server carry no api_key. Passing the
    // token via http-header-fields fixes segment 401/400 errors.
    if (httpHeaders) {
      await this.ipc.setProperty('http-header-fields', httpHeaders).catch(() => {});
    }

    const args: (string | Record<string, unknown>)[] = [path, 'replace'];
    if (startPosition !== undefined && startPosition > 0) {
      // mpv 0.29 (Debian 10) expects options as a string, e.g. "start=120"
      args.push(`start=${Math.floor(startPosition)}`);
    }
    await this.ipc.command('loadfile', ...args);
  }

  /**
   * 音乐音频链（QYP3-012 + P2 ReplayGain 高级）：EQ（af=lavfi equalizer）
   * 与 ReplayGain（模式 + 预增益 + 兜底增益 + 削波保护）。
   * null = 清空（视频加载复位，属性跨 loadfile 持久）。失败静默。
   */
  async applyMusicAudioChain(
    eqFilter: string | null,
    replaygain: ReplayGainChain | null
  ): Promise<void> {
    if (!this.ipc) return;
    if (eqFilter !== null) {
      await this.ipc.setProperty('af', eqFilter).catch(() => {});
    }
    if (replaygain === null) {
      await this.ipc.setProperty('replaygain', 'no').catch(() => {});
      return;
    }
    await this.ipc.setProperty('replaygain', replaygain.mode).catch(() => {});
    await this.ipc.setProperty('replaygain-preamp', replaygain.preamp).catch(() => {});
    await this.ipc.setProperty('replaygain-fallback', replaygain.fallback).catch(() => {});
    await this.ipc.setProperty('replaygain-clip', replaygain.clip ? 'yes' : 'no').catch(() => {});
  }

  async pause(): Promise<void> {
    if (!this.ipc) throw new Error('Player not started');
    await this.ipc.setProperty('pause', true);
  }

  async resume(): Promise<void> {
    if (!this.ipc) throw new Error('Player not started');
    await this.ipc.setProperty('pause', false);
  }

  async togglePause(): Promise<void> {
    if (!this.ipc) throw new Error('Player not started');
    await this.ipc.command('cycle', 'pause');
  }

  async seek(seconds: number, type: 'relative' | 'absolute' = 'absolute'): Promise<void> {
    if (!this.ipc) throw new Error('Player not started');
    const typeFlag = type === 'relative' ? 'relative' : 'absolute';
    await this.ipc.command('seek', seconds, typeFlag);
  }

  async setVolume(volume: number): Promise<void> {
    if (!this.ipc) throw new Error('Player not started');
    await this.ipc.setProperty('volume', Math.max(0, Math.min(100, volume)));
  }

  async setFullscreen(fullscreen: boolean): Promise<void> {
    if (!this.ipc) throw new Error('Player not started');
    await this.ipc.setProperty('fullscreen', fullscreen);
  }

  /**
   * Override the display aspect ratio. Accepted values: 'auto',
   * '16:9', '4:3', '2.35:1', '1:1' or a float like '1.7777'.
   */
  async setAspectRatio(ratio: string): Promise<void> {
    if (!this.ipc) throw new Error('Player not started');
    try {
      // mpv <= 0.32 property name (our self-built player is 0.32)
      await this.ipc.setProperty('video-aspect', ratio);
    } catch {
      // mpv >= 0.33 renamed the property
      await this.ipc.setProperty('video-aspect-override', ratio);
    }
  }

  /**
   * 音乐（音频）播放时隐藏 mpv 窗口（QYP3-032）：经 mpv 解码的音频（服务器 /
   * WebDAV / 冷门格式，以及内置引擎解不开的本地文件兜底到 mpv）若任由 mpv
   * 弹窗，会露出一块黑屏——音频文件常带内嵌封面，mpv 把它当成一条 video
   * 轨道（mjpeg），即便没有 --force-window 也会开窗。故音乐必须关掉视频轨
   * （vid=no）并撤销强制窗口（force-window=no）。视频则恢复。该 mpv 实例是
   * 懒启动的（首次播放才起），即使是 webaudio 引擎的音乐也会顺带启动它，
   * 所以音乐路径一律压窗，不能只压 mpv 直解的那种。
   */
  async setVideoWindowForMusic(isMusic: boolean): Promise<void> {
    if (!this.ipc) return;
    if (isMusic) {
      await this.ipc.setProperty('vid', 'no').catch(() => {});
      await this.ipc.setProperty('force-window', 'no').catch(() => {});
    } else {
      await this.ipc.setProperty('force-window', 'yes').catch(() => {});
      await this.ipc.setProperty('vid', 'auto').catch(() => {});
    }
  }

  /** Show an OSD message on the video (no-op when no media loaded). */
  async showText(text: string, durationMs = 1500): Promise<void> {
    if (!this.ipc) return;
    await this.ipc.command('show-text', text, durationMs).catch(() => {});
  }

  /** Cycle to the next audio track. */
  async cycleAudio(): Promise<void> {
    if (!this.ipc) throw new Error('Player not started');
    await this.ipc.command('cycle', 'audio', 'up');
  }

  /** Cycle to the next subtitle track ('no' included). */
  async cycleSub(): Promise<void> {
    if (!this.ipc) throw new Error('Player not started');
    await this.ipc.command('cycle', 'sub', 'up');
  }

  /** Select a specific track by id. type: aid/sid/vid; id 0 = off (for subs). */
  async setTrack(type: 'aid' | 'sid' | 'vid', id: number): Promise<void> {
    if (!this.ipc) throw new Error('Player not started');
    await this.ipc.setProperty(type, id);
  }

  /** Raw track-list property (audio/sub/video tracks with selection state). */
  async getTracks(): Promise<unknown[]> {
    if (!this.ipc) return [];
    const result = (await this.ipc.command('get_property', 'track-list')) as {
      data?: unknown[];
    };
    return result?.data || [];
  }

  /** Toggle always-on-top (used for the mini/PiP window). */
  async setOntop(ontop: boolean): Promise<void> {
    if (!this.ipc) throw new Error('Player not started');
    await this.ipc.setProperty('ontop', ontop);
  }

  /** Maximize / restore the mpv window (mpv >= 0.31). */
  async setMaximized(max: boolean): Promise<void> {
    if (!this.ipc) throw new Error('Player not started');
    await this.ipc.setProperty('window-maximized', max);
  }

  /** Window scale relative to video size; < 1 shrinks (mini window). */
  async setWindowScale(scale: number): Promise<void> {
    if (!this.ipc) throw new Error('Player not started');
    await this.ipc.setProperty('window-scale', scale);
  }

  async setProperty(name: string, value: string | number | boolean): Promise<void> {
    if (!this.ipc) throw new Error('Player not started');
    await this.ipc.setProperty(name, value);
  }

  async cycleSubtitle(): Promise<void> {
    if (!this.ipc) throw new Error('Player not started');
    await this.ipc.command('cycle', 'sub');
  }

  async addSubtitle(path: string, flag?: 'select' | 'auto'): Promise<void> {
    if (!this.ipc) throw new Error('Player not started');
    await this.ipc.command(...buildSubAddArgs(path, flag));
  }

  /** Wait for mpv's file-loaded event (see waitForFileLoadedEvent). */
  async waitForFileLoaded(timeoutMs?: number): Promise<boolean> {
    if (!this.ipc) return false;
    return waitForFileLoadedEvent(this.ipc, timeoutMs);
  }

  async setSubtitleDelay(delaySeconds: number): Promise<void> {
    if (!this.ipc) throw new Error('Player not started');
    await this.ipc.setProperty('sub-delay', delaySeconds);
  }

  getState(): PlayerState {
    return { ...this.state };
  }

  isReady(): boolean {
    return this.ipc !== null && this.ipc.isConnected();
  }
}
