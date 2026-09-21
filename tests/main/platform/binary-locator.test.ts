import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { win32 } from 'node:path';
import {
  resolveMpvBinary,
  ffmpegCandidates,
} from '../../../src/main/modules/platform/binary-locator';

/**
 * 外部二进制定位（QYP3-061）：候选序按平台分派，全部经 deps 注入判定，
 * 不碰真实文件系统。**Linux 分支必须与历史行为逐字节一致**（硬约束）。
 */

const NEVER = (): boolean => false;
const ALWAYS = (): boolean => true;
const LINUX_ENV = { HOME: '/root' } as NodeJS.ProcessEnv;

describe('resolveMpvBinary (QYP3-061)', () => {
  it('linux: 逐字节保持历史行为——自建目录优先并注入 LD_LIBRARY_PATH', () => {
    const r = resolveMpvBinary({
      platform: 'linux',
      homeDir: '/root',
      env: LINUX_ENV,
      exists: (p) => p === '/root/.local/bin/mpv',
    });
    expect(r.path).toBe('/root/.local/bin/mpv');
    expect(r.env.LD_LIBRARY_PATH).toBe('/root/.local/lib');
  });

  it('linux: 自建 mpv 不存在时回退裸 mpv（无 LD_LIBRARY_PATH 注入）', () => {
    const r = resolveMpvBinary({
      platform: 'linux',
      homeDir: '/root',
      env: LINUX_ENV,
      exists: NEVER,
    });
    expect(r.path).toBe('mpv');
    expect(r.env.LD_LIBRARY_PATH).toBeUndefined();
  });

  it('win32: 常规安装位置 → PATH 裸名 mpv.exe', () => {
    const env = { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' } as NodeJS.ProcessEnv;
    const local = win32.join(env.LOCALAPPDATA, 'mpv', 'mpv.exe');
    const r = resolveMpvBinary({
      platform: 'win32',
      env,
      exists: (p) => p === local,
    });
    expect(r.path).toBe(local);
    expect(r.path).toBe(resolveMpvBinary({ platform: 'win32', env, exists: ALWAYS }).path);
    // 什么都没装 → PATH 上的 mpv.exe
    expect(resolveMpvBinary({ platform: 'win32', env, exists: NEVER }).path).toBe('mpv.exe');
  });

  it('darwin: homebrew 位置优先', () => {
    const r = resolveMpvBinary({
      platform: 'darwin',
      env: {},
      exists: (p) => p === '/opt/homebrew/bin/mpv',
    });
    expect(r.path).toBe('/opt/homebrew/bin/mpv');
  });

  it('打包内置（resources/mpv/）在 win/mac 优先于平台候选', () => {
    const r = resolveMpvBinary({
      platform: 'win32',
      resourcesPath: 'C:\\app\\resources',
      env: { LOCALAPPDATA: 'C:\\l' } as NodeJS.ProcessEnv,
      exists: (p) => p === win32.join('C:\\app\\resources', 'mpv', 'mpv.exe'),
    });
    expect(r.path).toBe(win32.join('C:\\app\\resources', 'mpv', 'mpv.exe'));
    const mac = resolveMpvBinary({
      platform: 'darwin',
      resourcesPath: '/app/resources',
      env: {},
      exists: (p) => p === '/app/resources/mpv/mpv',
    });
    expect(mac.path).toBe('/app/resources/mpv/mpv');
  });

  it('QY_MPV_PATH 环境变量覆盖一切候选', () => {
    const r = resolveMpvBinary({
      platform: 'win32',
      resourcesPath: 'C:\\app\\resources',
      env: { QY_MPV_PATH: 'D:\\tools\\mpv.exe' } as NodeJS.ProcessEnv,
      exists: ALWAYS,
    });
    expect(r.path).toBe('D:\\tools\\mpv.exe');
  });

  it('开发态（resourcesPath 为空字符串）跳过打包内置候选', () => {
    const r = resolveMpvBinary({
      platform: 'darwin',
      resourcesPath: '',
      env: {},
      exists: (p) => p === '/opt/homebrew/bin/mpv',
    });
    expect(r.path).toBe('/opt/homebrew/bin/mpv');
  });
});

describe('ffmpegCandidates (QYP3-061)', () => {
  it('linux: 与历史行为一致（自建目录 → PATH）', () => {
    expect(ffmpegCandidates({ homeDir: '/root', platform: 'linux', env: LINUX_ENV })).toEqual([
      '/root/.local/bin/ffmpeg',
      'ffmpeg',
    ]);
  });

  it('win32: LOCALAPPDATA 优先 → PATH 上的 ffmpeg.exe；缺环境变量时跳过', () => {
    expect(
      ffmpegCandidates({
        platform: 'win32',
        env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' } as NodeJS.ProcessEnv,
      })
    ).toEqual([win32.join('C:\\Users\\u\\AppData\\Local', 'ffmpeg', 'bin', 'ffmpeg.exe'), 'ffmpeg.exe']);
    expect(ffmpegCandidates({ platform: 'win32', env: {} as NodeJS.ProcessEnv })).toEqual([
      'ffmpeg.exe',
    ]);
  });

  it('darwin: homebrew 双路径 → PATH', () => {
    expect(ffmpegCandidates({ platform: 'darwin', env: {} as NodeJS.ProcessEnv })).toEqual([
      '/opt/homebrew/bin/ffmpeg',
      '/usr/local/bin/ffmpeg',
      'ffmpeg',
    ]);
  });

  it('QY_FFMPEG_PATH 覆盖候选', () => {
    expect(
      ffmpegCandidates({ platform: 'linux', env: { QY_FFMPEG_PATH: '/x/ffmpeg' } as NodeJS.ProcessEnv })
    ).toEqual(['/x/ffmpeg']);
  });
});
