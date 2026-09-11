/**
 * Plugin system shared contract (QYP2-026, plan §11).
 *
 * 二期 scope: metadata-provider capability only, built-in plugins only
 * (static registry, shipped with the app). THIS IS NOT A SECURITY SANDBOX —
 * built-ins run in-process with full Node access; the narrow PluginContext
 * is a capability discipline for plugin authors, not a security boundary.
 */

import type {
  MetadataValue,
  NfoActor,
  NfoUniqueId,
} from './metadata-editor';

export { MetadataValue };
export type { NfoActor, NfoUniqueId };

/** Unified plugin error codes (plan §11.1). */
export type PluginErrorCode =
  | 'AUTH_REQUIRED'
  | 'RATE_LIMITED'
  | 'NOT_FOUND'
  | 'UPSTREAM_CHANGED'
  | 'NETWORK_ERROR'
  | 'INVALID_RESPONSE'
  | 'CANCELLED';

/** Thrown by plugins and by the context helpers; safe to surface. */
export class PluginError extends Error {
  readonly code: PluginErrorCode;
  constructor(code: PluginErrorCode, message: string) {
    super(message);
    this.name = 'PluginError';
    this.code = code;
  }
}

export const PLUGIN_API_VERSION = 1;
export type PluginCapability = 'metadata-provider';

/** Manifest contract; validated at registration (plan §11.1). */
export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  apiVersion: number;
  capability: PluginCapability;
}

export interface MetadataSearchInput {
  /** Free-text query as typed by the user (movies) or series title. */
  query: string;
  year?: number;
  kind?: 'movie' | 'series';
  locale?: string;
}

export interface MetadataCandidate {
  /** Provider-specific id, opaque to the host; passed back to getDetails. */
  id: string;
  title: string;
  originalTitle?: string;
  year?: number;
  /** 0..1 — ≥0.92 auto-apply, 0.75–0.92 manual queue, <0.75 rejected (§11.2). */
  score: number;
}

export interface MetadataLookupInput {
  kind?: 'movie' | 'series';
  season?: number;
  episode?: number;
  locale?: string;
}

/**
 * Normalized payload — the SAME shape the NFO merger already consumes, so
 * plugin output flows through applyNfoMetadata + schema validation before
 * touching the ProviderStore (plan §11.1: 输出需 runtime schema 验证).
 */
export interface MetadataPayload {
  kind: 'movie' | 'tvshow' | 'season' | 'episode';
  title?: string;
  originalTitle?: string;
  sortTitle?: string;
  year?: number;
  premiered?: string;
  plot?: string;
  tagline?: string;
  runtime?: number;
  rating?: number;
  contentRating?: string;
  genres: string[];
  studios: string[];
  countries: string[];
  actors: NfoActor[];
  directors: string[];
  season?: number;
  episode?: number;
  uniqueIds: NfoUniqueId[];
  thumbs: string[];
  set?: string;
}

/** Bounded HTTP response from the context client (body pre-read, capped). */
export interface PluginHttpResponse {
  status: number;
  headers: Record<string, string>;
  /** Response body (over-cap responses fail whole, never half-trusted). */
  body: Buffer;
}

export interface PluginHttpRequest {
  url: string;
  method?: 'GET' | 'HEAD';
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined>;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
}

/**
 * The ONLY capability surface a built-in plugin receives (plan §11.1):
 * allowlisted HTTP, per-plugin cache and secret reader, locale/info.
 * Deliberately absent: db, fs, player, Electron, child_process, module
 * loading. Not a security sandbox — a capability contract.
 */
export interface PluginContext {
  readonly pluginId: string;
  readonly locale: string;
  readonly appVersion: string;
  /** Allowlisted, timed, rate-limited, size-capped HTTP with sanitized errors. */
  http: {
    /** Registers the only hosts this plugin may contact (appends). */
    allowHosts(hosts: string[]): void;
    request(req: PluginHttpRequest): Promise<PluginHttpResponse>;
  };
  /** Per-plugin namespaced key/value cache with TTL and quota. */
  cache: {
    get<T>(key: string): T | undefined;
    set(key: string, value: unknown, ttlMs?: number): void;
    delete(key: string): void;
    clear(): void;
  };
  /** Namespaced secret reader (plugin:<id>:<key> in the SecretStore). */
  secrets: {
    get(key: string): string | null;
    has(key: string): boolean;
  };
}

/** The full built-in metadata-provider plugin contract (plan §11.1). */
export interface MetadataProviderPlugin {
  readonly manifest: PluginManifest;
  search(input: MetadataSearchInput, context: PluginContext): Promise<MetadataCandidate[]>;
  getDetails(
    id: string,
    input: MetadataLookupInput,
    context: PluginContext
  ): Promise<MetadataPayload>;
}
