/**
 * ffmpeg 探测（QYP3-050）。
 *
 * 离线频谱需要外部 ffmpeg，但**目标机（Deepin 20.9 / Debian 10）不保证有**，
 * 也不能要求用户装（无 sudo / 网络受限）。所以：
 *
 * 1. 先看 `~/.local/bin/ffmpeg`（与 mpv 同一处自建产物，见 docs/BUILD-MPV.md）；
 * 2. 再退回 PATH 上的 `ffmpeg`；
 * 3. 都没有（或 `-version` 跑不起来）→ 返回 null，调用方静默降级：该曲目维持
 *    静音底线，不报错、不阻塞播放、也不再重试（结果在会话内缓存）。
 *
 * 探测只做一次（含否定结果），不参与任何播放路径。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { ffmpegCandidates as platformFfmpegCandidates } from '../platform/binary-locator';

export type FfmpegProbe = (bin: string) => Promise<boolean>;

export interface FfmpegLocatorDeps {
  /** 家目录（默认 process.env.HOME）。 */
  homeDir?: string;
  /** 存在性检查（测试注入）。 */
  exists?: (path: string) => boolean;
  /** 候选可执行性检查（测试注入；默认跑一次 `-version`）。 */
  probe?: FfmpegProbe;
  /** 平台（QYP3-061，测试注入）。 */
  platform?: NodeJS.Platform;
}

export interface FfmpegLocator {
  /** 首次调用会真正探测，之后返回缓存结果（null = 本会话没有可用 ffmpeg）。 */
  detect(): Promise<string | null>;
  /** 已探测到的路径（尚未探测时返回 null）。 */
  known(): string | null;
}

const PROBE_TIMEOUT_MS = 5000;

/** 候选顺序（QYP3-061 起委托平台模块）：linux 自建目录优先 → PATH；win/mac 走各自常规位置。 */
export function ffmpegCandidates(
  homeDir: string,
  deps?: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv }
): string[] {
  return platformFfmpegCandidates({ homeDir, platform: deps?.platform, env: deps?.env });
}

/** 跑一次 `-version`，退出码 0 才算可用（ENOENT/超时/非 0 都算没有）。 */
function probeVersion(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child?.kill('SIGKILL');
      done(false);
    }, PROBE_TIMEOUT_MS);
    let child: ReturnType<typeof spawn> | null = null;
    try {
      child = spawn(bin, ['-version'], { stdio: ['ignore', 'ignore', 'ignore'] });
    } catch {
      done(false);
      return;
    }
    child.on('error', () => done(false));
    child.on('close', (code) => done(code === 0));
  });
}

export function createFfmpegLocator(deps: FfmpegLocatorDeps = {}): FfmpegLocator {
  const homeDir = deps.homeDir ?? process.env.HOME ?? '/home';
  const exists = deps.exists ?? existsSync;
  const probe = deps.probe ?? probeVersion;
  let resolved: string | null = null;
  let detected = false;
  let inflight: Promise<string | null> | null = null;

  return {
    known: () => resolved,
    async detect(): Promise<string | null> {
      if (detected) return resolved;
      if (inflight) return inflight;
      const pending = (async (): Promise<string | null> => {
        for (const candidate of ffmpegCandidates(homeDir, { platform: deps.platform })) {
          // PATH 上的名字不做 existsSync（由 spawn/退出码判定）
          if (candidate.includes('/') && !exists(candidate)) continue;
          // eslint-disable-next-line no-await-in-loop
          if (await probe(candidate)) {
            resolved = candidate;
            break;
          }
        }
        detected = true;
        return resolved;
      })();
      inflight = pending;
      try {
        return await pending;
      } finally {
        inflight = null;
      }
    },
  };
}
