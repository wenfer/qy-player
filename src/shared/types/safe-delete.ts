/**
 * Safe-delete wire contract (QYP2-024, plan §14.2). The renderer only ever
 * sends {sourceId, itemId} / {token, confirmTitle?} - never paths, hrefs
 * or recursion flags.
 */

export type DeleteMethod = 'local-trash' | 'webdav-delete';

export interface MediaDeletionPreview {
  sourceId: number;
  itemId: number;
  itemTitle: string;
  sourceName: string;
  sourceKind: 'local' | 'webdav';
  /** Directory owned by the item, relative to the source root. */
  targetDir: string;
  fileCount: number;
  totalBytes: number;
  method: DeleteMethod;
  /** Opaque, short-lived, single-use execution token. */
  token: string;
  /** WebDAV permanent delete requires typing the real title. */
  requiresTitleConfirmation: boolean;
}

export type MediaDeletionStatus = 'trashed' | 'deleted' | 'unknown';
