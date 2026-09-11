/**
 * Diagnostics summary (QYP2-037): a REDACTED, user-shareable snapshot of
 * runtime state (plan §16/诊断).
 *
 * 脱敏红线（验收）：
 * - 绝无 API key/token/密码（SecretStore 内容永不进入摘要）；
 * - 无完整私有 URL——服务器地址只保留协议+主机名首段脱敏形态
 *   （如 `http://192.168.x.x:8096` → `http://***.x.x:8096`？不行——
 *   局域网主机名也算隐私，统一 host 整体脱敏为 `***`）；
 * - 无文件系统绝对路径（仅分区名/相对统计）；
 * - 缓存/并发预算展示（§16.4 常量）。
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { CacheManager } from '../cache/cache-manager';
import type { DiagnosticsSummary } from '../../../shared/types/diagnostics';
import { CONCURRENCY_BUDGET, MAX_EVENT_HZ, MAX_PAGE_SIZE } from '../cache/cache-manager';

const SECRET_KEY_PATTERN = /(api[_-]?key|token|secret|password|credential|bearer)/i;

/** 地址脱敏：协议保留，主机名与端口整体打码；路径/查询整段丢弃。 */
export function maskUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return '***';
  }
  return `${url.protocol}//***${url.pathname === '/' ? '' : '/*'}`;
}

/**
 * 任意字符串值脱敏：疑似秘密（键名匹配）整段替换；URL 内嵌凭据
 * （user:pass@ 与 query 里的 token/api_key 变体）整段替换。
 */
export function redactValue(key: string, value: string): string {
  if (SECRET_KEY_PATTERN.test(key)) return '***';
  // 值本身含秘密字样（api_key=… / token=… 等任意分隔）→ 整段打码。
  if (SECRET_KEY_PATTERN.test(value) && /(=|:\s*)/i.test(value)) return '***';
  // 值内嵌 URL（含 userinfo/私有地址）→ 逐个 URL 打码替换。
  if (/https?:\/\//i.test(value)) {
    return value.replace(/https?:\/\/[^\s"'<>]+/gi, (url) => maskUrl(url));
  }
  return value;
}

export interface DiagnosticsInput {
  appVersion: string;
  servers: Array<{ id: number; name: string; type: string; base_url: string; is_active: number; last_ok?: boolean }>;
  cacheManager: CacheManager;
  subsystems?: Array<{ id: string; ok: boolean; detail: string }>;
}

export function buildDiagnosticsSummary(input: DiagnosticsInput): DiagnosticsSummary {
  const servers = input.servers.map((server) => ({
    id: server.id,
    // 用户自起名仍过一遍脱敏（防调用方误传秘密进 name）。
    name: redactValue('server_name', server.name),
    type: server.type,
    addressMasked: redactValue('base_url', maskUrl(server.base_url)),
    ok: server.is_active === 1 && server.last_ok !== false,
  }));

  const caches = input.cacheManager.list().map((partition) => {
    let fileCount: number | undefined;
    let approxBytes: number | undefined;
    if (partition.rootDir && existsSync(partition.rootDir)) {
      fileCount = 0;
      approxBytes = 0;
      const walk = (dir: string): void => {
        let names: string[];
        try {
          names = readdirSync(dir);
        } catch {
          return;
        }
        for (const name of names) {
          const full = join(dir, name);
          let stat;
          try {
            stat = statSync(full);
          } catch {
            continue;
          }
          if (stat.isDirectory()) walk(full);
          else {
            fileCount! += 1;
            approxBytes! += stat.size;
          }
        }
      };
      walk(partition.rootDir);
    }
    return {
      id: partition.id,
      description: partition.description,
      // 根目录绝不出现完整私有路径
      rootDirMasked: partition.rootDir ? `${partition.id}/*` : null,
      maxEntries: partition.quota.maxEntries,
      sweepable: partition.sweepable,
      fileCount,
      approxBytes,
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    appVersion: input.appVersion,
    servers,
    caches,
    budgets: {
      localScan: CONCURRENCY_BUDGET.localScan,
      webdavScan: CONCURRENCY_BUDGET.webdavScan,
      probe: CONCURRENCY_BUDGET.probe,
      scraper: CONCURRENCY_BUDGET.scraper,
      maxEventHz: MAX_EVENT_HZ,
      maxPageSize: MAX_PAGE_SIZE,
    },
    // detail 由调用方生成，但红线在此兜底：疑似秘密/URL 一律打码。
    subsystems: (input.subsystems ?? []).map((sub) => ({
      ...sub,
      detail: redactValue('detail', sub.detail),
    })),
  };
}
