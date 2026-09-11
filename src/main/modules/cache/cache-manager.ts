/**
 * Unified cache manager (QYP2-037, plan §16.4).
 *
 * 三类缓存（图片 / 技术信息 probe / 插件响应）各自有配额与 LRU/过期
 * 策略——本模块是「注册 + 汇总 + 清扫」的统一入口，不重复实现各家
 * 已有的 LRU 语义：
 * - probe 缓存（media-probe，内存 LRU+TTL）：服务内部自管，注册展示；
 * - 插件响应（plugin-runtime/cache.ts，磁盘 mtime-LRU）：自管，注册展示；
 * - 图片目录（userData/images 等）：按 mtime LRU 配额清扫；
 * - 人工导入字幕（userData/subtitles/<itemId>/）永远受保护——任何
 *   sweep 都不会触碰（§16.4: 缓存不删人工字幕）。
 *
 * 并发预算（§16.4）在这里集中声明为常量，供扫描/probe/scraper 复用与
 * 诊断展示：local≤8、WebDAV≤4、probe≤1、scraper≤2。
 */

import { readdirSync, statSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const CONCURRENCY_BUDGET = {
  localScan: 8,
  webdavScan: 4,
  probe: 1,
  scraper: 2,
} as const;

export const MAX_EVENT_HZ = 4;
export const MAX_PAGE_SIZE = 200;

export interface CachePartition {
  /** 唯一名称（诊断展示 + 去重）。 */
  id: string;
  /** 人类可读说明。 */
  description: string;
  /** 磁盘分区根目录（内存分区为 null）。 */
  rootDir: string | null;
  /** 配额（字节；内存分区为条目数）。 */
  quota: { maxBytes?: number; maxEntries?: number };
  /** sweep 是否允许删除条目（字幕分区 false——保护性注册）。 */
  sweepable: boolean;
}

export interface RegisteredPartition extends CachePartition {
  /** 命中排除清单（目录名白名单，如 subtitles/<itemId> 的人工文件）。 */
  protectedNames: string[];
}

export interface SweepResult {
  partitionId: string;
  deletedFiles: number;
  freedBytes: number;
}

export class CacheManager {
  private readonly partitions = new Map<string, RegisteredPartition>();

  /** 注册一个缓存分区；重复 id 直接覆盖（幂等注册）。 */
  register(partition: CachePartition, protectedNames: string[] = []): void {
    this.partitions.set(partition.id, { ...partition, protectedNames });
  }

  list(): Array<CachePartition & { protectedNames: string[] }> {
    return [...this.partitions.values()];
  }

  /**
   * 按分区清扫到配额内：按 mtime 最旧先删（LRU），配额内/受保护名
   * 一律不动。文件级配额近似：单文件大小计入，直到 freed 足够。
   */
  sweep(partitionId: string, budgetBytes: number): SweepResult {
    const partition = this.partitions.get(partitionId);
    if (!partition) throw new Error(`未注册的缓存分区: ${partitionId}`);
    const result: SweepResult = { partitionId, deletedFiles: 0, freedBytes: 0 };
    if (!partition.sweepable || !partition.rootDir || !existsSync(partition.rootDir)) {
      return result;
    }
    const entries: Array<{ path: string; size: number; mtime: number }> = [];
    this.collectFiles(partition.rootDir, partition.protectedNames, entries);
    // 先删过期语义在此降级为 mtime 最旧优先（各分区自身 TTL 自管）。
    entries.sort((a, b) => a.mtime - b.mtime);
    for (const entry of entries) {
      if (result.freedBytes >= budgetBytes) break;
      try {
        const size = statSync(entry.path).size;
        unlinkSync(entry.path);
        result.deletedFiles += 1;
        result.freedBytes += size;
      } catch {
        // 单文件删除失败不中断清扫（权限/占用）；下一个文件继续。
      }
    }
    return result;
  }

  private collectFiles(
    dir: string,
    protectedNames: string[],
    out: Array<{ path: string; size: number; mtime: number }>
  ): void {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const full = join(dir, name);
      // 受保护名（人工字幕所在目录）绝不进入删除候选。
      if (protectedNames.some((p) => name === p)) continue;
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        this.collectFiles(full, protectedNames, out);
      } else {
        out.push({ path: full, size: stat.size, mtime: stat.mtimeMs });
      }
    }
  }
}
