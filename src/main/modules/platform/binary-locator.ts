import { existsSync } from 'fs';
import { join as posixJoin, win32 } from 'path';

/**
 * 候选路径构造按注入的平台选 join 语义——真实 win32 上与 path.join 等价，
 * 同时让 POSIX 主机上的单测可以确定性地断言 win32 路径形态。
 */
function joinFor(platform: NodeJS.Platform): (p: string, ...segs: string[]) => string {
  return platform === 'win32' ? win32.join : posixJoin;
}

/**
 * 外部二进制定位（QYP3-061）：mpv / ffmpeg 的跨平台候选序列。
 *
 * 解析优先级：
 *   1. 环境变量覆盖（QY_MPV_PATH / QY_FFMPEG_PATH）——开发与排障逃生口
 *   2. 打包内置（extraResources → process.resourcesPath/mpv/）——仅 win/mac
 *      的安装包会携带；开发态 resourcesPath 指向 node_modules/electron/dist，
 *      exists 必然失败，自然落到后续候选
 *   3. 平台常规位置（PATH 裸名兜底）
 *
 * Linux 兼容纪律：linux 分支的输出与历史行为逐字节一致
 * （~/.local/bin/mpv + LD_LIBRARY_PATH=~/.local/lib，否则裸 'mpv'）。
 */

export interface BinaryResolution {
  path: string;
  env: NodeJS.ProcessEnv;
}

export interface LocatorDeps {
  /** 默认 process.platform；测试注入。 */
  platform?: NodeJS.Platform;
  /** Linux 家目录（历史行为用）；默认 process.env.HOME ?? '/home'。 */
  homeDir?: string;
  /** 打包资源目录；默认 process.resourcesPath（仅打包后有意义）。 */
  resourcesPath?: string;
  /** 进程环境（读 QY_* 覆盖与透传）；默认 process.env。 */
  env?: NodeJS.ProcessEnv;
  /** 存在性探测；默认 existsSync，测试注入。 */
  exists?: (p: string) => boolean;
}

function firstExisting(candidates: string[], exists: (p: string) => boolean): string | null {
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }
  return null;
}

/** mpv 解析。Linux 分支与历史行为逐字节一致（含 LD_LIBRARY_PATH 注入）。 */
export function resolveMpvBinary(deps?: LocatorDeps): BinaryResolution {
  const platform = deps?.platform ?? process.platform;
  const env = deps?.env ?? process.env;
  const homeDir = deps?.homeDir ?? env.HOME ?? '/home';
  const resourcesPath = deps?.resourcesPath ?? '';
  const exists = deps?.exists ?? ((p: string) => existsSync(p));
  const join = joinFor(platform);

  // 1. 显式覆盖
  const override = env.QY_MPV_PATH;
  if (override && exists(override)) {
    return { path: override, env: { ...env } };
  }

  // 2. 打包内置（extraResources → resources/mpv/）
  const bundledMpv = join(resourcesPath, 'mpv', platform === 'win32' ? 'mpv.exe' : 'mpv');
  if (resourcesPath && exists(bundledMpv)) {
    return { path: bundledMpv, env: { ...env } };
  }

  // 3. 平台常规位置
  if (platform === 'linux') {
    // 历史行为：自编译 mpv（无 rpath）需要本地库目录进 loader 路径
    const homeMpv = join(homeDir, '.local', 'bin', 'mpv');
    if (exists(homeMpv)) {
      return { path: homeMpv, env: { ...env, LD_LIBRARY_PATH: join(homeDir, '.local', 'lib') } };
    }
    return { path: 'mpv', env: { ...env } };
  }
  if (platform === 'win32') {
    // 环境变量缺失时跳过对应候选（join('') 会产出相对路径垃圾）
    const candidates: string[] = [];
    if (env.LOCALAPPDATA) candidates.push(join(env.LOCALAPPDATA, 'mpv', 'mpv.exe'));
    if (env.USERPROFILE) candidates.push(join(env.USERPROFILE, 'scoop', 'shims', 'mpv.exe'));
    if (env.PROGRAMFILES) candidates.push(join(env.PROGRAMFILES, 'mpv', 'mpv.exe'));
    candidates.push('mpv.exe');
    const found = firstExisting(candidates, exists);
    return { path: found ?? 'mpv.exe', env: { ...env } };
  }
  // darwin 与其它 unix
  const found = firstExisting(['/opt/homebrew/bin/mpv', '/usr/local/bin/mpv'], exists);
  return { path: found ?? 'mpv', env: { ...env } };
}

/**
 * ffmpeg 候选序列（可选依赖，缺席静默降级——离线频谱功能用）。
 * 返回带绝对路径的候选 + PATH 裸名兜底；探测逻辑在 ffmpeg-locator。
 */
export function ffmpegCandidates(deps?: LocatorDeps): string[] {
  const platform = deps?.platform ?? process.platform;
  const env = deps?.env ?? process.env;
  const homeDir = deps?.homeDir ?? env.HOME ?? '/home';
  const join = joinFor(platform);

  const override = env.QY_FFMPEG_PATH;
  if (override) return [override];

  if (platform === 'win32') {
    const candidates: string[] = [];
    if (env.LOCALAPPDATA) candidates.push(join(env.LOCALAPPDATA, 'ffmpeg', 'bin', 'ffmpeg.exe'));
    candidates.push('ffmpeg.exe');
    return candidates;
  }
  if (platform === 'darwin') {
    return ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', 'ffmpeg'];
  }
  // linux：历史行为不变
  return [join(homeDir, '.local', 'bin', 'ffmpeg'), 'ffmpeg'];
}
