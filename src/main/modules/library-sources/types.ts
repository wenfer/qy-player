import type { SourceCapabilities, SourceKind } from '../../../shared/types';

export type { SourceCapabilities, SourceKind };

/**
 * Shared contracts for media source adapters (plan §4.2).
 *
 * Adapters are the ONLY place where source-specific logic lives; scanners,
 * services and UI must stay kind-agnostic. All async work takes an
 * AbortSignal and must honor it promptly.
 */

/** Identifies a resource inside one source; renderer never sees raw paths. */
export interface MediaLocator {
  sourceId: number;
  relativePath: string;
}

/** One entry produced by traversing a source directory. */
export interface SourceEntry {
  /** Path relative to the source root; segments separated by '/'. */
  relativePath: string;
  isDirectory: boolean;
  size?: number;
  /** Unix timestamp (ms). */
  mtime?: number;
  /** Weak identity when the source supports it (WebDAV ETag). */
  etag?: string;
}

export interface SourceStat {
  size?: number;
  mtime?: number;
  etag?: string;
  supportsRange: boolean;
}

/**
 * A readable byte stream for playback/probe. Adapters return one of the two
 * shapes; consumers must not depend on which.
 */
export interface ReadableResource {
  stream: NodeJS.ReadableStream | AsyncIterable<Uint8Array>;
  size?: number;
  supportsRange: boolean;
}

/** Precondition arguments for a protected directory deletion (plan §14.2). */
export interface DeletePrecondition {
  expectedEtag?: string;
  expectedSize?: number;
  /** Short-lived confirmation token issued by the delete service. */
  confirmationToken?: string;
}

export type DeleteOutcome = 'deleted' | 'unknown' | 'rejected';

export interface DeleteResult {
  outcome: DeleteOutcome;
  /** Sanitized detail; must never contain credentials. */
  detail?: string;
}

export interface SourceAdapter {
  readonly kind: SourceKind;
  // Implementation contract: every method must honor the AbortSignal AND
  // enforce its own timeout (network sources abort themselves on timeout,
  // plan §16.4) - the controller does not add timeouts around adapters.
  testConnection(signal: AbortSignal): Promise<SourceCapabilities>;
  /**
   * Traverse one directory level. `relativePath` '' means the source root.
   * When resuming an interrupted scan, callers may pass a non-empty cursor;
   * adapters SHOULD start streaming at/after that path.
   */
  list(relativePath: string, signal: AbortSignal): AsyncIterable<SourceEntry>;
  stat(locator: MediaLocator, signal: AbortSignal): Promise<SourceStat>;
  open(locator: MediaLocator, signal: AbortSignal): Promise<ReadableResource>;
  /** Only for sources whose capabilities allow deletion (plan §14.2). */
  deleteDirectory?(locator: MediaLocator, precondition: DeletePrecondition, signal: AbortSignal): Promise<DeleteResult>;
}

/** Per-entry work the scanner drives through the job controller. */
export interface ScanDriver {
  /** Classification/upsert for one discovered entry (QYP2-009). */
  index(entry: SourceEntry, signal: AbortSignal): Promise<void>;
  /** Optional second pass: NFO/probe/scraper enrichment. */
  enrich?(entry: SourceEntry, signal: AbortSignal): Promise<void>;
}
