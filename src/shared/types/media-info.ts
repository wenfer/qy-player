/**
 * Media probe contract (QYP2-018, plan §10/§16.4).
 *
 * Shared between the main-process probe service and (from QYP2-019 on) the
 * renderer's detail page. Failure states are explicit enum values — probe
 * problems must be distinguishable and must never block playback.
 */

export type ProbeStatus =
  /** Probe ran and at least one meaningful field is present. */
  | 'ok'
  /** Probe ran but produced no usable fields (all unsupported). */
  | 'unsupported'
  /** Overall deadline exceeded. */
  | 'timeout'
  /** mpv binary missing (spawn ENOENT). */
  | 'no-mpv'
  /** mpv died / IPC broke / spawn failed for another reason. */
  | 'offline'
  /** Caller aborted before the probe produced a result. */
  | 'cancelled';

export interface MediaTrackInfo {
  kind: 'video' | 'audio' | 'subtitle';
  codec?: string;
  language?: string;
  title?: string;
  width?: number;
  height?: number;
  fps?: number;
  channels?: number;
  samplerate?: number;
  external?: boolean;
  isDefault?: boolean;
}

export interface MediaProbeInfo {
  /** mpv-version, or 'unknown' when unreadable. */
  version: string;
  duration?: number;
  container?: string;
  video?: { codec?: string; width?: number; height?: number; fps?: number; aspect?: number };
  audio?: { codec?: string; channels?: number; samplerate?: number };
  tracks: MediaTrackInfo[];
  /** Field keys no candidate property could supply on this mpv version. */
  unsupported: string[];
}

export interface MediaProbeOutcome {
  status: ProbeStatus;
  /** Version fingerprint the probe was keyed against (size:mtime / etag). */
  fingerprint: string;
  /** Epoch ms of the underlying probe (not the cache read). */
  probedAt: number;
  /** True when served from the in-memory cache. */
  fromCache: boolean;
  info?: MediaProbeInfo;
  /** Human-readable reason for non-ok statuses (diagnostics only). */
  message?: string;
}
