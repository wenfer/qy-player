/**
 * 离线频谱服务（QYP3-050）。
 *
 * 主进程在**音乐以 mpv 引擎起播**时收到一份 `SpectrumJob`（URL + 与 mpv 同一份
 * 认证头），后台用 ffmpeg 解一遍、算成频带矩阵落盘；渲染层按播放进度索引回放。
 * 声音仍由 mpv 播放——这条链路**完全不碰播放路径**。
 *
 * 设计要点：
 * - **并发 1**（`CONCURRENCY_BUDGET.spectrum`）：老机不能被后台解码抢满 CPU。
 * - **懒计算 + 缓存**：只有缓存没命中才开工；同一曲目只算一次，失败/不可用
 *   在本会话内不重试（`failed` 集合 + `noFfmpeg` 标志）。
 * - **换曲目立即取消**正在跑的解码（用户已经走开了，别白烧 CPU）。
 * - 全程静默：任何失败都只体现为"这条曲目还是没有频谱"，不弹窗、不打日志。
 */

import type {
  GetSpectrumResult,
  SpectrumJob,
  SpectrumReadyEvent,
} from '../../../shared/types/music-spectrum';
import { decodeToBands, type DecodeOutcome, type DecodeRequest } from './ffmpeg-decode';
import { createFfmpegLocator, type FfmpegLocator } from './ffmpeg-locator';
import {
  SPECTRUM_MAX_FILE_BYTES,
  readSpectrumFile,
  spectrumKey,
  writeSpectrumFileAtomic,
} from './spectrum-cache';
import { buildSpectrumFile, encodeSpectrum, type SpectrumFile } from './spectrum-format';

/** 起播后等一会儿再开工：先让 mpv 把缓冲稳定下来，别在起播瞬间抢 CPU。 */
export const STARTUP_DELAY_MS = 3000;
/** 超过这个时长的曲目直接跳过（有声书整章解码在老机上太贵）。 */
export const MAX_DURATION_SEC = 2 * 60 * 60;

export interface MusicSpectrumDeps {
  /** 缓存目录 `<userData>/music-spectrum`。 */
  dir: string;
  locator?: FfmpegLocator;
  decodeFn?: typeof decodeToBands;
  /** 缓存超预算时回调（接 `CacheManager.sweep`）。 */
  sweep?: () => void;
  /** 结果定论时通知渲染层（ready / unavailable / failed 都会通知）。 */
  onSettled?: (event: SpectrumReadyEvent) => void;
  startupDelayMs?: number;
  maxDurationSec?: number;
  quotaBytes?: number;
}

type State = 'none' | 'pending' | 'ready' | 'unavailable' | 'failed';

export class MusicSpectrumService {
  private readonly dir: string;
  private readonly locator: FfmpegLocator;
  private readonly decodeFn: typeof decodeToBands;
  private readonly deps: MusicSpectrumDeps;

  private current: SpectrumJob | null = null;
  private currentFile: SpectrumFile | null = null;
  private state: State = 'none';
  private controller: AbortController | null = null;
  private timer: NodeJS.Timeout | null = null;
  /** 本会话没有可用 ffmpeg（连探测都不再做了）。 */
  private noFfmpeg = false;
  private readonly failed = new Set<string>();
  /** 估算的缓存占用：超过配额时触发一次清扫。 */
  private approxBytes = 0;

  constructor(deps: MusicSpectrumDeps) {
    this.deps = deps;
    this.dir = deps.dir;
    this.locator = deps.locator ?? createFfmpegLocator();
    this.decodeFn = deps.decodeFn ?? decodeToBands;
  }

  /**
   * 音乐以 mpv 引擎起播（或结束）时调用；传 null 表示音乐会话结束。
   * 幂等：同一曲目重复调用不会重复开工。
   */
  setCurrent(job: SpectrumJob | null): void {
    if (!job) {
      this.cancelActive();
      this.current = null;
      this.currentFile = null;
      this.state = 'none';
      return;
    }
    if (this.current && this.current.mediaId === job.mediaId && this.state !== 'none') return;

    // 换曲目：立刻停掉上一首的解码（用户已经走开了）
    this.cancelActive();
    this.current = job;
    this.currentFile = null;

    const cached = readSpectrumFile(this.dir, spectrumKey(job));
    if (cached) {
      this.currentFile = cached;
      this.state = 'ready';
      return;
    }
    if (this.noFfmpeg) {
      this.state = 'unavailable';
      return;
    }
    if (this.failed.has(job.mediaId)) {
      this.state = 'failed';
      return;
    }
    if (job.durationSec !== undefined && job.durationSec > (this.deps.maxDurationSec ?? MAX_DURATION_SEC)) {
      this.failed.add(job.mediaId);
      this.state = 'failed';
      return;
    }

    this.state = 'pending';
    const controller = new AbortController();
    this.controller = controller;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run(job, controller);
    }, this.deps.startupDelayMs ?? STARTUP_DELAY_MS);
  }

  /** 渲染层取当前曲目的频谱（非关键路径：永远返回结果，不抛错）。 */
  get(): GetSpectrumResult {
    const mediaId = this.current?.mediaId ?? '';
    switch (this.state) {
      case 'ready':
        if (this.currentFile) {
          const { header, frames } = this.currentFile;
          return {
            status: 'ready',
            mediaId,
            fps: header.fps,
            bands: header.bands,
            frameCount: header.frameCount,
            data: frames,
          };
        }
        return { status: 'pending', mediaId };
      case 'unavailable':
        return { status: 'unavailable', mediaId, reason: 'no-ffmpeg' };
      case 'failed':
        return { status: 'failed', mediaId };
      case 'pending':
        return { status: 'pending', mediaId };
      default:
        return { status: 'none' };
    }
  }

  /** 退出/会话结束时同步取消（Electron 的 will-quit 不 await）。 */
  cancelAll(): void {
    this.cancelActive();
  }

  private cancelActive(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.controller) {
      // abort 是同步的：监听器里直接 SIGKILL 子进程
      this.controller.abort();
      this.controller = null;
    }
  }

  private async run(job: SpectrumJob, controller: AbortController): Promise<void> {
    const bin = await this.locator.detect();
    if (controller.signal.aborted || this.controller !== controller) return;
    if (!bin) {
      this.noFfmpeg = true;
      this.settle(job, 'unavailable');
      return;
    }

    const req: DecodeRequest = {
      url: job.url,
      headers: job.headers,
      startSec: job.startSec,
      // 时长未知时给一个硬上限（ffmpeg 的输入侧 -t）：超长文件不会把 CPU
      // 和磁盘拖垮，正常曲目远短于它、不受影响。
      durationSec: job.durationSec ?? this.deps.maxDurationSec ?? MAX_DURATION_SEC,
    };
    let outcome: DecodeOutcome;
    try {
      outcome = await this.decodeFn(bin, req, { signal: controller.signal });
    } catch {
      outcome = { status: 'failed' }; // decodeToBands 承诺不抛，这里只是兜底
    }
    // 已被切歌/退出抢先：什么都不做（不要用旧结果覆盖新状态）
    if (controller.signal.aborted || this.controller !== controller) return;

    if (outcome.status === 'aborted') return;
    if (outcome.status === 'no-ffmpeg') {
      this.noFfmpeg = true;
      this.settle(job, 'unavailable');
      return;
    }
    if (outcome.status !== 'ok') {
      this.settle(job, 'failed');
      return;
    }

    const file = buildSpectrumFile(outcome.frames);
    const buf = encodeSpectrum(outcome.frames);
    if (buf.length > SPECTRUM_MAX_FILE_BYTES) {
      this.settle(job, 'failed');
      return;
    }
    if (writeSpectrumFileAtomic(this.dir, spectrumKey(job), buf)) {
      this.approxBytes += buf.length;
      const quota = this.deps.quotaBytes ?? 0;
      if (quota > 0 && this.approxBytes > quota) {
        this.deps.sweep?.();
        this.approxBytes = 0;
      }
    }
    // 写盘失败也照样能用：这次会话用内存里的帧，下次播放重算
    this.currentFile = file;
    this.settle(job, 'ready');
  }

  private settle(job: SpectrumJob, status: 'ready' | 'unavailable' | 'failed'): void {
    this.controller = null;
    if (this.current?.mediaId === job.mediaId) {
      this.state = status;
      if (status === 'failed') this.failed.add(job.mediaId);
    }
    this.deps.onSettled?.({ mediaId: job.mediaId, status });
  }
}
