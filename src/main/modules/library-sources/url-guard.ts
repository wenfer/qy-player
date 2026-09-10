/**
 * WebDAV URL security boundary (plan §8.2, QYP2-012).
 *
 * Pure functions, no I/O. Every URL that reaches the WebDAV client is built
 * through this module: base URLs are validated once at save time, hrefs from
 * server responses are decoded/normalized and containment-checked against
 * the source root before any request is issued.
 */

export class WebDavUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebDavUrlError';
  }
}

/** Base URL contract: origin + root path only (plan §8.2). */
export interface ParsedWebDavBase {
  /** Normalized absolute URL string (no trailing slash, no query/fragment). */
  url: string;
  /** Root path, starts with '/', no trailing slash ('' stays ''). */
  basePath: string;
  isHttps: boolean;
}

// Control characters and whitespace never belong in a URL.
const FORBIDDEN_CHARS = /[\u0000-\u0020\u007f]/;

/**
 * Validate and normalize a user-supplied WebDAV base URL.
 * Rejects: non-HTTP(S) schemes, userinfo, query strings, fragments,
 * whitespace/control characters, missing hostname.
 */
export function parseWebDavBaseUrl(input: string): ParsedWebDavBase {
  if (typeof input !== 'string' || input.trim().length === 0) {
    throw new WebDavUrlError('地址不能为空');
  }
  if (FORBIDDEN_CHARS.test(input)) {
    throw new WebDavUrlError('地址包含空格或控制字符');
  }
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new WebDavUrlError('地址格式无效');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new WebDavUrlError('仅支持 http/https 协议');
  }
  if (url.username || url.password) {
    throw new WebDavUrlError('地址不能包含用户名密码（userinfo）');
  }
  if (url.search) {
    throw new WebDavUrlError('地址不能包含查询串（query）');
  }
  if (url.hash) {
    throw new WebDavUrlError('地址不能包含片段（fragment）');
  }
  if (!url.hostname) {
    throw new WebDavUrlError('地址缺少主机名');
  }
  // Normalize: strip trailing slashes so joins produce single slashes.
  let pathname = url.pathname;
  while (pathname.length > 1 && pathname.endsWith('/')) {
    pathname = pathname.slice(0, -1);
  }
  // '/' alone means the host root.
  if (pathname === '/') pathname = '';
  return {
    url: `${url.protocol}//${url.host}${pathname}`,
    basePath: pathname,
    isHttps: url.protocol === 'https:',
  };
}

/** True when two URLs share scheme, hostname and effective port. */
export function isSameOrigin(a: URL, b: URL): boolean {
  return a.protocol === b.protocol && a.host === b.host;
}

/** Reject anything that smells like an encoded traversal before decoding. */
const ENCODED_TRAVERSAL = /%(?:2e|2f|5c)|\.(?:%2e|%2f)|%5c\.|%c0%ae|%e0%80%ae/i;

/**
 * Decode + normalize a server-provided href against the source root.
 *
 * Defense layers (plan §8.2):
 * 1. Raw-level checks: encoded traversal sequences are rejected outright
 *    (covers double-encoding: one decode pass must not resurrect `..`).
 * 2. Strict percent-decode (malformed escapes rejected, not guessed).
 * 3. Absolute hrefs must be same-origin; anything else is rejected.
 * 4. Path normalization: `.`/`..` resolved; escaping the root is fatal.
 *
 * Returns the decoded absolute path (starts with '/').
 */
export function normalizeServerHref(href: string, base: ParsedWebDavBase): string {
  if (typeof href !== 'string' || href.length === 0) {
    throw new WebDavUrlError('空的 href');
  }
  if (href.includes('\u0000')) {
    throw new WebDavUrlError('href 包含空字节');
  }
  if (ENCODED_TRAVERSAL.test(href)) {
    throw new WebDavUrlError(`href 包含编码穿越序列: ${href.slice(0, 60)}`);
  }

  let path: string;
  if (/^\/\//.test(href)) {
    // Protocol-relative hrefs change the origin implicitly.
    throw new WebDavUrlError('不支持协议相对 href');
  }
  if (/^https?:\/\//i.test(href)) {
    let target: URL;
    try {
      target = new URL(href);
    } catch {
      throw new WebDavUrlError('绝对 href 无法解析');
    }
    if (!isSameOrigin(target, new URL(base.url))) {
      throw new WebDavUrlError('绝对 href 跨源，已拒绝');
    }
    path = target.pathname;
  } else if (href.startsWith('/')) {
    path = href;
  } else {
    // Relative to the base path.
    path = `${base.basePath}/${href}`;
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    throw new WebDavUrlError('href 百分号编码无效');
  }
  // Double-encoding tripwire: after one decode there must be no encoded
  // traversal material left (%25 = encoded '%', %2e/%2f/%5c = encoded
  // '.'/'/'/'\\'). A literal '%' in a filename encodes as %25; files whose
  // NAMES themselves contain '%25' are pathological and rejected on
  // purpose — containment trumps name exoticism (plan §8.2).
  if (/%(?:25|2e|2f|5c)/i.test(decoded)) {
    throw new WebDavUrlError('href 存在双重编码，已拒绝');
  }
  if (decoded.includes('\u0000')) {
    throw new WebDavUrlError('href 解码后包含空字节');
  }

  // Normalize slash runs and dot segments against the base path.
  const segments: string[] = [];
  for (const raw of decoded.split('/')) {
    if (raw === '' || raw === '.') continue;
    if (raw === '..') {
      segments.pop();
      if (segments.length < basePathSegments(base).length) {
        throw new WebDavUrlError(`href 逃逸 source root: ${decoded.slice(0, 60)}`);
      }
      continue;
    }
    segments.push(raw);
  }
  const rootSegs = basePathSegments(base);
  for (let i = 0; i < rootSegs.length; i += 1) {
    if (segments[i] !== rootSegs[i]) {
      throw new WebDavUrlError(`href 不在 source root 之下: ${decoded.slice(0, 60)}`);
    }
  }
  // Preserve a trailing slash: it is directory information that the
  // adapter layer relies on alongside the resourcetype flag.
  const trailing = decoded.endsWith('/');
  let normalized = `/${segments.join('/')}`;
  if (trailing && segments.length > 0) normalized += '/';
  return normalized === '//' ? '/' : normalized;
}

function basePathSegments(base: ParsedWebDavBase): string[] {
  return base.basePath.split('/').filter((s) => s.length > 0);
}

/**
 * Relative path (inside the source, no leading slash) → decoded request path
 * for building request URLs. Inverse of the adapter's relativePath contract.
 */
export function relativePathToRequestPath(relativePath: string, base: ParsedWebDavBase): string {
  if (relativePath.includes('\u0000') || /(?:^|\/)\.\.(?:\/|$)/.test(relativePath) || relativePath.includes('\\\\')) {
    throw new WebDavUrlError('非法相对路径');
  }
  if (relativePath === '') return base.basePath || '/';
  const encoded = relativePath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `${base.basePath}/${encoded}`;
}
