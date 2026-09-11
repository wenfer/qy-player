import { createHash } from 'crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';

/**
 * Bounded on-disk cache for plugin scrape responses (QYP2-028, plan §11:
 * 插件响应的有界磁盘缓存; §16.4: 缓存必须有配额和 LRU/过期策略).
 *
 * Entries are JSON files named by content-addressed keys
 * (<sha1(pluginId + kind + key)>.json) with embedded expiry. Eviction is
 * LRU by file mtime: reads refresh the mtime, the quota evicts the least
 * recently touched entries, and already-expired entries are dropped first.
 * Plugin secrets never enter cache keys (callers hash opaque keys).
 */

export interface ScrapeCacheDeps {
  dir: string;
  maxEntries?: number;
  defaultTtlMs?: number;
  now?: () => number;
}

interface CacheEnvelope {
  value: unknown;
  expiresAt: number;
  createdAt: number;
}

const DEFAULT_MAX_ENTRIES = 512;
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export class ScrapeCache {
  private readonly dir: string;
  private readonly maxEntries: number;
  private readonly defaultTtlMs: number;
  private readonly now: () => number;

  constructor(deps: ScrapeCacheDeps) {
    this.dir = deps.dir;
    this.maxEntries = deps.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.defaultTtlMs = deps.defaultTtlMs ?? DEFAULT_TTL_MS;
    this.now = deps.now ?? Date.now;
  }

  /** Content-addressed key: secrets never appear in filenames. */
  static keyFor(pluginId: string, namespace: string, key: string): string {
    return createHash('sha1').update(`${pluginId}|${namespace}|${key}`).digest('hex');
  }

  private pathFor(name: string): string {
    return join(this.dir, `${name}.json`);
  }

  get<T>(pluginId: string, namespace: string, key: string): T | undefined {
    const path = this.pathFor(ScrapeCache.keyFor(pluginId, namespace, key));
    if (!existsSync(path)) return undefined;
    try {
      const envelope = JSON.parse(readFileSync(path, 'utf8')) as CacheEnvelope;
      if (envelope.expiresAt <= this.now()) {
        rmSync(path, { force: true });
        return undefined;
      }
      return envelope.value as T;
    } catch {
      // Corrupt entry: drop it.
      rmSync(path, { force: true });
      return undefined;
    }
  }

  set(pluginId: string, namespace: string, key: string, value: unknown, ttlMs?: number): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      const envelope: CacheEnvelope = {
        value,
        expiresAt: this.now() + (ttlMs ?? this.defaultTtlMs),
        createdAt: this.now(),
      };
      writeFileSync(this.pathFor(ScrapeCache.keyFor(pluginId, namespace, key)), JSON.stringify(envelope));
      this.evictBeyondQuota();
    } catch {
      // Cache writes are best-effort; a failed write must not fail a scrape.
    }
  }

  delete(pluginId: string, namespace: string, key: string): void {
    rmSync(this.pathFor(ScrapeCache.keyFor(pluginId, namespace, key)), { force: true });
  }

  clear(): void {
    if (!existsSync(this.dir)) return;
    for (const file of readdirSync(this.dir)) {
      rmSync(join(this.dir, file), { force: true });
    }
  }

  get size(): number {
    if (!existsSync(this.dir)) return 0;
    return readdirSync(this.dir).filter((f) => f.endsWith('.json')).length;
  }

  /** True LRU: mtime is the last-access time (reads refresh it). Expired
   * entries are evicted first, then the least recently touched beyond the
   * quota. */
  private evictBeyondQuota(): void {
    if (!existsSync(this.dir)) return;
    const now = this.now();
    const files: Array<{ path: string; mtime: number; expired: boolean }> = [];
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith('.json')) continue;
      const path = join(this.dir, f);
      try {
        const stat = statSync(path);
        let expired = false;
        try {
          const envelope = JSON.parse(readFileSync(path, 'utf8')) as { expiresAt?: number };
          expired = (envelope.expiresAt ?? Number.MAX_SAFE_INTEGER) <= now;
        } catch {
          expired = true; // corrupt entry: first out
        }
        files.push({ path, mtime: stat.mtimeMs, expired });
      } catch {
        // raced with a concurrent removal
      }
    }
    files.sort((a, b) => Number(b.expired) - Number(a.expired) || a.mtime - b.mtime);
    let over = files.length - this.maxEntries;
    for (const entry of files) {
      if (over <= 0) break;
      rmSync(entry.path, { force: true });
      over -= 1;
    }
  }
}

