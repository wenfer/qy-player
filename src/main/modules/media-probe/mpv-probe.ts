import {
  ProbeError,
  runProbeSpike,
  type ProbeResult,
} from './mpv-probe-spike';
import type {
  MediaProbeInfo,
  MediaTrackInfo,
  ProbeStatus,
} from '../../../shared/types/media-info';

/**
 * mpv probe runner (QYP2-018): wraps the QYP2-017 spike into a service-
 * friendly API. Transport failures map to explicit ProbeStatus values so
 * the cache layer can distinguish timeout / missing mpv / offline, and
 * "unsupported" stays visible in MediaProbeInfo.unsupported (plan §10:
 * the four states must never blur together).
 */

/** Map a spike ProbeResult onto the shared contract (pure). */
export function toMediaProbeInfo(result: ProbeResult): MediaProbeInfo {
  const tracks: MediaTrackInfo[] = result.tracks.map((track) => ({ ...track }));
  const info: MediaProbeInfo = {
    version: result.version,
    tracks,
    unsupported: [...result.unsupported],
  };
  if (result.duration !== undefined) info.duration = result.duration;
  if (result.container !== undefined) info.container = result.container;
  if (result.video) info.video = { ...result.video };
  if (result.audio) info.audio = { ...result.audio };
  return info;
}

/** An 'ok' probe must carry at least one meaningful field. */
export function hasUsableFields(info: MediaProbeInfo): boolean {
  return (
    info.duration !== undefined ||
    info.container !== undefined ||
    info.video !== undefined ||
    info.audio !== undefined ||
    info.tracks.length > 0
  );
}

export type SpikeFn = typeof runProbeSpike;

export interface MpvRunnerDeps {
  /** Injectable for tests; defaults to the real spike orchestrator. */
  spikeFn?: SpikeFn;
  mpvBinary?: string;
  timeoutMs?: number;
  /** Raw 'Key: Value' header lines; main-side only, never the renderer. */
  httpHeaders?: string[];
}

/**
 * Run one probe and classify the outcome. Never throws — every failure
 * becomes a status the UI can render distinctly.
 */
export async function runMpvProbe(
  target: string,
  deps: MpvRunnerDeps = {}
): Promise<{ status: ProbeStatus; info?: MediaProbeInfo; message?: string }> {
  const spike = deps.spikeFn ?? runProbeSpike;
  try {
    const result = await spike({
      target,
      ...(deps.mpvBinary !== undefined ? { mpvBinary: deps.mpvBinary } : {}),
      ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
      ...(deps.httpHeaders !== undefined ? { httpHeaders: deps.httpHeaders } : {}),
    });
    const info = toMediaProbeInfo(result);
    return hasUsableFields(info)
      ? { status: 'ok', info }
      : { status: 'unsupported', info };
  } catch (err) {
    if (err instanceof ProbeError) {
      switch (err.code) {
        case 'TIMEOUT':
          return { status: 'timeout', message: err.message };
        case 'SPAWN': {
          // ENOENT means the mpv binary itself is missing.
          if (/ENOENT/.test(err.message)) {
            return { status: 'no-mpv', message: err.message };
          }
          return { status: 'offline', message: err.message };
        }
        case 'CONNECT':
        case 'UNAVAILABLE':
          return { status: 'offline', message: err.message };
      }
    }
    return {
      status: 'offline',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
