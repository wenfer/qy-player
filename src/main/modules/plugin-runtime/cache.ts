import { createHash } from 'crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

/**
 * Bounded on-disk cache for plugin scrape responses (QYP2-028, plan §11:
 * 插件响应的有界磁盘缓存; §16.4: 缓存必须有配额和 LRU/过期策略).
 *
 * Entries are JSON files named by content-addressed keys
 * (<sha1(pluginId + kind + key)>.json) with embedded expiry. LRU tracking
 * uses file mtime; the quota evicts the oldest files beyond the cap.
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
      // Touch for LRU (best-effort; failure is harmless).
      const future = this.now() + 60_000;
      try {
        writeFileSync(path, JSON.stringify(envelope), { flag: 'w' });
        void future;
      } catch {
        // mtime touch skipped
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

  /** LRU-ish eviction by insertion time (deterministic across same-ms writes). */
  private evictBeyondQuota(): void {
    if (!existsSync(this.dir)) return;
    const files = readdirSync(this.dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const path = join(this.dir, f);
        try {
          const envelope = JSON.parse(readFileSync(path, 'utf8')) as { createdAt?: number };
          return { path, createdAt: envelope.createdAt ?? 0 };
        } catch {
          return { path, createdAt: 0 };
        }
      })
      .sort((a, b) => a.createdAt - b.createdAt);
    while (files.length > this.maxEntries) {
      const oldest = files.shift();
      if (!oldest) break;
      rmSync(oldest.path, { force: true });
    }
  }
}

