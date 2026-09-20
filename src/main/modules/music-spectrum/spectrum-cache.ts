/**
 * 离线频谱缓存文件的读写（QYP3-050）。
 *
 * 目录：`<userData>/music-spectrum/`（`CacheManager` 里注册为可清扫分区，
 * 删掉了下次播放会重新算）。文件名是内容寻址的 sha1：曲目身份 + 文件指纹 +
 * 分轨范围 + 格式版本——换歌、换文件、升级格式都会自然失效。
 *
 * 写用「临时文件 + rename」：**绝不让半截文件被读到**（读到即当成没有缓存）。
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SPECTRUM_VERSION,
  parseSpectrum,
  type SpectrumFile,
} from './spectrum-format';
import type { SpectrumJob } from '../../../shared/types/music-spectrum';

/** 单文件上限（约 2 小时 @12fps×48 带）——病态长文件直接不写。 */
export const SPECTRUM_MAX_FILE_BYTES = 8 * 1024 * 1024;

/** 本地文件指纹；拿不到就返回空串（此时缓存键只靠路径）。 */
export function fileStamp(url: string): string {
  // 只对看起来像本地绝对路径的输入做 stat（URL 会抛异常，代价高）
  if (!url.startsWith('/')) return '';
  try {
    const st = statSync(url);
    return `${st.size}:${Math.round(st.mtimeMs)}`;
  } catch {
    return '';
  }
}

/** 内容寻址的缓存键。 */
export function spectrumKey(job: SpectrumJob): string {
  const parts = [
    `v${SPECTRUM_VERSION}`,
    job.mediaId,
    job.fileStamp ?? fileStamp(job.url),
    job.startSec ? String(Math.round(job.startSec)) : '0',
    job.durationSec ? String(Math.round(job.durationSec)) : '0',
  ];
  return createHash('sha1').update(parts.join('|')).digest('hex');
}

export function spectrumFilePath(dir: string, key: string): string {
  return join(dir, `${key}.qys`);
}

/** 读缓存；不存在/损坏/超限一律返回 null（调用方按"没有缓存"处理）。 */
export function readSpectrumFile(dir: string, key: string): SpectrumFile | null {
  const path = spectrumFilePath(dir, key);
  try {
    if (statSync(path).size > SPECTRUM_MAX_FILE_BYTES) return null;
    return parseSpectrum(readFileSync(path));
  } catch {
    return null;
  }
}

/**
 * 原子写：临时文件 → rename（同目录 rename 是原子的），返回是否写成功。
 * 写失败不算错——这次会话仍可用内存里的帧，只是下次要重算。
 */
export function writeSpectrumFileAtomic(dir: string, key: string, buf: Buffer): boolean {
  const tmp = join(dir, `.tmp-${key}-${process.pid}`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(tmp, buf);
    renameSync(tmp, spectrumFilePath(dir, key));
    return true;
  } catch {
    try {
      unlinkSync(tmp);
    } catch {
      // 临时文件可能根本没建起来
    }
    return false;
  }
}
