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
