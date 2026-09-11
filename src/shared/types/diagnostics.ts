/**
 * Diagnostics summary contract (QYP2-037).
 *
 * 摘要可被用户导出分享——字段本身就是脱敏红线：类型层面只有脱敏后
 * 形态（addressMasked / rootDirMasked），绝无 secret/token/绝对路径。
 */
export interface DiagnosticsServerInfo {
  id: number;
  /** 服务端显示名（用户自己起的，非秘密）。 */
  name: string;
  /** 'jellyfin' | 'emby'（非秘密）。 */
  type: string;
  /** 永远脱敏后的形态。 */
  addressMasked: string;
  ok: boolean;
}

export interface DiagnosticsPartitionInfo {
  id: string;
  description: string;
  rootDirMasked: string | null;
  maxEntries?: number;
  sweepable: boolean;
  fileCount?: number;
  approxBytes?: number;
}

export interface DiagnosticsSummary {
  generatedAt: string;
  appVersion: string;
  servers: DiagnosticsServerInfo[];
  caches: DiagnosticsPartitionInfo[];
  budgets: {
    localScan: number;
    webdavScan: number;
    probe: number;
    scraper: number;
    maxEventHz: number;
    maxPageSize: number;
  };
  /** 已知子系统就绪状态（无敏感值，只有 ok/失败计数）。 */
  subsystems: Array<{ id: string; ok: boolean; detail: string }>;
}

