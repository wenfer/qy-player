/**
 * Uniform action results for all new phase-2 IPC handlers (plan §4.3).
 *
 * Every catalog/source/metadata/delete/plugin handler returns ActionResult;
 * failures carry a structured, sanitized error — never raw exceptions,
 * credentials or private URLs.
 */

export const ERROR_CODES = [
  'AUTH_REQUIRED',
  'RATE_LIMITED',
  'NOT_FOUND',
  'UPSTREAM_CHANGED',
  'NETWORK_ERROR',
  'INVALID_RESPONSE',
  'CANCELLED',
  'TIMEOUT',
  'VALIDATION_FAILED',
  'CONFLICT',
  'UNAVAILABLE',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface StructuredError {
  code: ErrorCode;
  /** Human-readable, sanitized message (safe for toasts and logs). */
  message: string;
  retryable: boolean;
  /** Optional non-sensitive structured context for diagnostics. */
  details?: Record<string, unknown>;
}

export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: StructuredError };

export function ok<T>(data: T): ActionResult<T> {
  return { ok: true, data };
}

export function err<T = never>(
  code: ErrorCode,
  message: string,
  opts: { retryable?: boolean; details?: StructuredError['details'] } = {}
): ActionResult<T> {
  return {
    ok: false,
    error: {
      code,
      message,
      retryable: opts.retryable ?? false,
      ...(opts.details ? { details: opts.details } : {}),
    },
  };
}
