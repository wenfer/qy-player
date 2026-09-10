/**
 * Subtitle attachment contract (QYP2-020, plan §13). Shared between the
 * import service (main) and the detail UI (QYP2-021).
 */

export type SubtitleOrigin = 'sidecar' | 'imported';
export type SubtitleStatus = 'ok' | 'missing' | 'corrupt';

export interface SubtitleAttachmentInfo {
  id: number;
  itemId: number;
  /** Managed copy path (imported) or sidecar path; main-side only. */
  managedPath: string;
  language: string | null;
  title: string | null;
  /** Lowercased extension without the dot: srt/ass/ssa/sub/vtt. */
  format: string;
  origin: SubtitleOrigin;
  isDefault: boolean;
  status: SubtitleStatus;
}

export interface ImportSubtitleRequest {
  itemId: number;
  /** Local subtitle file chosen by the user (≤ 20 MiB, whitelisted ext). */
  sourcePath: string;
  language?: string;
  title?: string;
  isDefault?: boolean;
}

/**
 * Wire-row (snake_case from catalog_subtitles) → camelCase contract.
 * Shared so the renderer (and later metadata UI) never duplicates this.
 */
export function toSubtitleAttachmentInfo(row: {
  id: number;
  item_id: number;
  managed_path: string;
  language: string | null;
  title: string | null;
  format: string;
  origin: string;
  is_default: number;
  status: string;
}): SubtitleAttachmentInfo {
  return {
    id: row.id,
    itemId: row.item_id,
    managedPath: row.managed_path,
    language: row.language,
    title: row.title,
    format: row.format,
    origin: row.origin === 'imported' ? 'imported' : 'sidecar',
    isDefault: row.is_default === 1,
    status: row.status === 'missing' || row.status === 'corrupt' ? row.status : 'ok',
  };
}
