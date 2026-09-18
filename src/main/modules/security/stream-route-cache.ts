/**
 * qy-stream 代理的路由表（QYP3-037）。
 *
 * 与 `StreamHeaderCache`（单次消费，交给 mpv 的 http header）不同，这里的路由
 * 必须能被**反复读取**：一个 `<audio>` 元素播放一首歌会发出多次 Range 请求
 * （起播一次、每次 seek 一次），每次都要重新查到目标 URL 与认证头。
 *
 * 安全面：渲染层只拿到不透明的 `qy-stream://audio/<id>`（id 由 randomUUID
 * 生成，不可猜测），真实上游 URL 与 token 永不跨 IPC；命中与否对外不区分
 * 「不存在」和「已过期」。
 */

export interface StreamRoute {
  /** 真实上游 URL（含服务器直链的 api_key 或 WebDAV 直链）。 */
  url: string;
  /** 需要注入的认证头（X-Emby-Token / Authorization: Basic）。 */
  headers: Record<string, string>;
  createdAt: number;
}

export interface StreamRouteCache {
  put(id: string, route: { url: string; headers?: Record<string, string> }): void;
  /** 命中即刷新存活时间（滑动 TTL），非消费。 */
  get(id: string): StreamRoute | undefined;
  size(): number;
}

export interface StreamRouteCacheOptions {
  /** 条目上限，超出淘汰最久未用的。 */
  maxEntries?: number;
  /** 单个路由的存活时长；靠 get 滑动续期，需覆盖整首曲目 + 任意 seek。 */
  ttlMs?: number;
  /** 时钟注入（测试用）。 */
  now?: () => number;
}

const DEFAULT_MAX_ENTRIES = 64;
const DEFAULT_TTL_MS = 8 * 60 * 60 * 1000; // 8h：覆盖超长有声书单曲

export function createStreamRouteCache(options: StreamRouteCacheOptions = {}): StreamRouteCache {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? Date.now;
  // Map 保持插入顺序；LRU 用「删除后重插」实现（命中的条目移到末尾）。
  const entries = new Map<string, StreamRoute>();

  const isExpired = (route: StreamRoute): boolean => now() - route.createdAt >= ttlMs;

  return {
    put(id, route) {
      entries.delete(id);
      while (entries.size >= maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
      entries.set(id, {
        url: route.url,
        headers: route.headers ?? {},
        createdAt: now(),
      });
    },

    get(id) {
      const entry = entries.get(id);
      if (!entry) return undefined;
      if (isExpired(entry)) {
        entries.delete(id);
        return undefined;
      }
      // 滑动续期：播放中的长曲目（>ttlMs）不该在播放途中失效
      entry.createdAt = now();
      entries.delete(id);
      entries.set(id, entry);
      return entry;
    },

    size() {
      return entries.size;
    },
  };
}
