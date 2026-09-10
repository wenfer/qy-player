import { createHash } from 'crypto';
import { dirname, join } from 'path';
import { statSync } from 'fs';

/**
 * Two-phase safe delete (QYP2-024, plan §14.2).
 *
 * preview → short-lived single-use token bound to the verified target →
 * execute re-runs every verification before touching anything.
 *
 * Absolute prohibitions implemented here (§14.2):
 * - renderer supplies only {sourceId, itemId} — never paths/href/flags;
 * - the source root, mounts, /, $HOME and out-of-root targets are refused;
 * - containment is realpath-based (adapter.resolveInside), not prefix-only;
 * - the local trash is never silently escalated to a permanent delete;
 * - WebDAV unknown outcomes are reported as unknown, never retried blindly.
 */

export type DeleteMethod = 'local-trash' | 'webdav-delete';

export interface DeletePreview {
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
  /** WebDAV permanent delete requires typing the real title (§14.2.4). */
  requiresTitleConfirmation: boolean;
}

export type DeleteFailureCode =
  | 'ITEM_NOT_FOUND'
  | 'INVALID_INPUT'
  | 'NOT_DELETABLE_KIND'
  | 'NO_OWNERSHIP'
  | 'READ_ONLY'
  | 'OUT_OF_ROOT'
  | 'SYMLINK_CHANGED'
  | 'FINGERPRINT_CHANGED'
  | 'TOKEN_INVALID'
  | 'TOKEN_EXPIRED'
  | 'TITLE_MISMATCH'
  | 'TRASH_FAILED'
  | 'WEBDAV_UNKNOWN'
  | 'WEBDAV_FAILED';

export type DeletePreviewResult =
  | { ok: true; preview: DeletePreview }
  | { ok: false; code: DeleteFailureCode; message: string };

export type DeleteExecuteResult =
  | { ok: true; status: 'trashed' | 'deleted' | 'unknown'; itemId: number }
  | { ok: false; code: DeleteFailureCode; message: string };

/** Structural repo surface (catalog repository satisfies this). */
export interface DeleteRepoSurface {
  getSource(id: number): { id: number; kind: string; root: string; read_only: number; name: string } | undefined;
  getItem(id: number): { id: number; kind: string; title: string | null; source_id: number; source_key: string } | undefined;
  listFilesByItem(itemId: number): Array<{ id: number; relative_path: string; size: number | null; mtime: number | null; fingerprint: string | null }>;
  listFilesBySource(sourceId: number): Array<{ id: number; item_id: number; relative_path: string; size: number | null; mtime: number | null }>;
  setAvailabilityBulk(patches: Array<{ id: number; availability: 'online' | 'offline' | 'missing' }>): void;
}

export interface DeleteServiceDeps {
  repo: DeleteRepoSurface;
  /** Local containment + realpath (LocalSourceAdapter.resolveInside). */
  resolveInside: (sourceId: number, relativePath: string) => string;
  /** Electron shell.trashItem by default; injected for tests. */
  trashFn: (absolutePath: string) => Promise<void>;
  /** WebDAV DELETE on a collection; injected from the adapter. */
  webdavDelete: (args: {
    sourceId: number;
    relativePath: string;
    /** Precondition: only delete while the etag still matches. */
    ifMatch?: string;
  }) => Promise<{ status: 'deleted' | 'unknown' }>;
  /** Managed cache dirs to clean on success (subtitles/images roots). */
  managedCacheRoots: string[];
  removeManagedCache?: (itemId: number) => void;
  tokenTtlMs?: number;
  now?: () => number;
}

const KINDS_DELETABLE = new Set(['movie', 'series', 'video']);
const TOKEN_TTL_MS = 10 * 60 * 1000;

interface TokenPayload {
  sourceId: number;
  itemId: number;
  targetDir: string;
  fingerprint: string;
  method: DeleteMethod;
  itemTitle: string;
  expiresAt: number;
}

/** Files' content fingerprint at preview time (mtime/size/etag sensitive). */
function filesFingerprint(files: Array<{ relative_path: string; size: number | null; mtime: number | null; fingerprint: string | null }>): string {
  const sorted = [...files].sort((a, b) => a.relative_path.localeCompare(b.relative_path));
  const hash = createHash('sha256');
  for (const file of sorted) {
    hash.update(`${file.relative_path}|${file.size ?? ''}|${file.mtime ?? ''}|${file.fingerprint ?? ''}\n`);
  }
  return hash.digest('hex').slice(0, 32);
}

/** Common parent directory of the item's files, '' when root-level. */
function commonDir(paths: string[]): string | null {
  const dirs = paths.map((p) => dirname(p));
  if (dirs.length === 0) return null;
  if (dirs.some((d) => d === '.')) return null; // root-level file
  const first = dirs[0].split('/');
  for (const dir of dirs) {
    const segments = dir.split('/');
    for (let i = 0; i < Math.min(first.length, segments.length); i += 1) {
      if (first[i] !== segments[i]) {
        first.length = i;
        break;
      }
    }
    first.length = Math.min(first.length, segments.length);
  }
  return first.filter(Boolean).join('/');
}

export class SafeDeleteService {
  private readonly repo: DeleteServiceDeps['repo'];
  private readonly deps: DeleteServiceDeps;
  private readonly tokens = new Map<string, TokenPayload>();

  constructor(deps: DeleteServiceDeps) {
    this.deps = deps;
    this.repo = deps.repo;
  }

  /** Bounded token store hygiene (tests / long sessions). */
  get pendingTokenCount(): number {
    this.sweepExpired();
    return this.tokens.size;
  }

  private sweepExpired(): void {
    const now = this.deps.now?.() ?? Date.now();
    for (const [id, payload] of this.tokens) {
      if (payload.expiresAt <= now) this.tokens.delete(id);
    }
  }

  // -------------------------------------------------------------------------
  // Phase 1: preview (plan §14.2.1-3)
  // -------------------------------------------------------------------------

  preview(sourceId: number, itemId: number): DeletePreviewResult {
    if (!Number.isInteger(sourceId) || !Number.isInteger(itemId) || sourceId <= 0 || itemId <= 0) {
      return { ok: false, code: 'INVALID_INPUT', message: '参数无效' };
    }
    const source = this.repo.getSource(sourceId);
    if (!source) return { ok: false, code: 'ITEM_NOT_FOUND', message: '来源不存在' };
    const item = this.repo.getItem(itemId);
    if (!item || item.source_id !== sourceId) {
      return { ok: false, code: 'ITEM_NOT_FOUND', message: '条目不存在' };
    }
    if (!KINDS_DELETABLE.has(item.kind)) {
      return { ok: false, code: 'NOT_DELETABLE_KIND', message: '季和单集不能单独删除（请删除整部作品）' };
    }
    if (source.read_only !== 0) {
      return { ok: false, code: 'READ_ONLY', message: '该来源未启用删除（默认只读）' };
    }
    if (source.kind !== 'local' && source.kind !== 'webdav') {
      return { ok: false, code: 'INVALID_INPUT', message: '来源类型不支持删除' };
    }

    const files = this.repo.listFilesByItem(itemId);
    if (files.length === 0) {
      return { ok: false, code: 'NO_OWNERSHIP', message: '条目没有可删除的媒体文件' };
    }

    // Target directory: the common parent of the item's files.
    const dir = commonDir(files.map((f) => f.relative_path));
    if (dir === null || dir === '') {
      return { ok: false, code: 'NO_OWNERSHIP', message: '文件直接位于来源根目录，没有独立目录可删' };
    }
    // Strictly below the root: the first path segment must exist inside the
    // root ("根目录下一层以上"); the root itself is never a target.
    if (dir.split('/').filter(Boolean).length < 1) {
      return { ok: false, code: 'OUT_OF_ROOT', message: '目标不在允许的根目录内' };
    }

    // Ownership evidence: no OTHER item may own files under this dir —
    // shared directories are not deletable (§14.2 禁止共享文件推导).
    for (const file of this.repo.listFilesBySource(sourceId)) {
      if (file.item_id === itemId) continue;
      if (file.relative_path === dir || file.relative_path.startsWith(`${dir}/`)) {
        return { ok: false, code: 'NO_OWNERSHIP', message: '该目录包含其他条目的文件，不能删除' };
      }
    }

    // Local: realpath containment re-verified here (symlinks rejected by
    // resolveInside; prefix-only checks are forbidden by §14.2).
    if (source.kind === 'local') {
      try {
        const real = this.deps.resolveInside(sourceId, dir);
        if (!statSync(real).isDirectory()) {
          return { ok: false, code: 'NO_OWNERSHIP', message: '目标不是目录' };
        }
      } catch (err) {
        return {
          ok: false,
          code: 'OUT_OF_ROOT',
          message: err instanceof Error && err.message.includes('symlink')
            ? '目标包含符号链接，拒绝删除'
            : '目标目录不可访问',
        };
      }
    }

    const method: DeleteMethod = source.kind === 'local' ? 'local-trash' : 'webdav-delete';
    const totalBytes = files.reduce((sum, f) => sum + (f.size ?? 0), 0);
    const fingerprint = filesFingerprint(files);
    const token = createHash('sha256')
      .update(`${sourceId}:${itemId}:${dir}:${fingerprint}:${Date.now()}:${Math.random()}`)
      .digest('hex')
      .slice(0, 24);

    const ttl = this.deps.tokenTtlMs ?? TOKEN_TTL_MS;
    this.sweepExpired();
    this.tokens.set(token, {
      sourceId,
      itemId,
      targetDir: dir,
      fingerprint,
      method,
      itemTitle: item.title ?? '',
      expiresAt: (this.deps.now?.() ?? Date.now()) + ttl,
    });

    return {
      ok: true,
      preview: {
        sourceId,
        itemId,
        itemTitle: item.title ?? '(未命名)',
        sourceName: source.name,
        sourceKind: source.kind,
        targetDir: dir,
        fileCount: files.length,
        totalBytes,
        method,
        token,
        requiresTitleConfirmation: method === 'webdav-delete',
      },
    };
  }

  // -------------------------------------------------------------------------
  // Phase 2: execute (plan §14.2.5-8) — every check runs again
  // -------------------------------------------------------------------------

  async execute(
    token: string,
    options: { confirmTitle?: string } = {}
  ): Promise<DeleteExecuteResult> {
    // Lookup first (expired tokens must report TOKEN_EXPIRED, not vanish
    // into the generic invalid bucket via the sweep).
    const payload = typeof token === 'string' ? this.tokens.get(token) : undefined;
    if (!payload) {
      return { ok: false, code: 'TOKEN_INVALID', message: '确认令牌无效或已使用，请重新预览' };
    }
    const now = this.deps.now?.() ?? Date.now();
    if (payload.expiresAt <= now) {
      this.tokens.delete(token);
      return { ok: false, code: 'TOKEN_EXPIRED', message: '确认令牌已过期，请重新预览' };
    }
    const source = this.repo.getSource(payload.sourceId);
    const item = this.repo.getItem(payload.itemId);
    if (!source || !item || item.source_id !== payload.sourceId) {
      this.tokens.delete(token);
      return { ok: false, code: 'ITEM_NOT_FOUND', message: '条目或来源已不存在' };
    }

    // Full re-verification: files, fingerprint, ownership.
    const files = this.repo.listFilesByItem(payload.itemId);
    if (files.length === 0) {
      this.tokens.delete(token);
      return { ok: false, code: 'NO_OWNERSHIP', message: '条目已没有媒体文件' };
    }
    const currentDir = commonDir(files.map((f) => f.relative_path));
    if (currentDir !== payload.targetDir) {
      this.tokens.delete(token);
      return { ok: false, code: 'FINGERPRINT_CHANGED', message: '目标已变化（文件集改变），请重新预览' };
    }
    if (filesFingerprint(files) !== payload.fingerprint) {
      this.tokens.delete(token);
      return { ok: false, code: 'FINGERPRINT_CHANGED', message: '目标已变化（文件内容或大小改变），请重新预览' };
    }
    for (const file of this.repo.listFilesBySource(payload.sourceId)) {
      if (file.item_id === payload.itemId) continue;
      if (file.relative_path === payload.targetDir || file.relative_path.startsWith(`${payload.targetDir}/`)) {
        this.tokens.delete(token);
        return { ok: false, code: 'NO_OWNERSHIP', message: '该目录包含其他条目的文件，不能删除' };
      }
    }

    if (source.read_only !== 0) {
      this.tokens.delete(token);
      return { ok: false, code: 'READ_ONLY', message: '该来源未启用删除' };
    }

    let status: 'trashed' | 'deleted' | 'unknown';
    if (payload.method === 'local-trash') {
      // Re-verify realpath containment at execution time: a symlink or
      // ancestor swapped in after the preview aborts here (§14.2).
      let absDir: string;
      try {
        absDir = this.deps.resolveInside(payload.sourceId, payload.targetDir);
        if (!statSync(absDir).isDirectory()) {
          this.tokens.delete(token);
          return { ok: false, code: 'SYMLINK_CHANGED', message: '目标不再是目录，请重新预览' };
        }
      } catch {
        this.tokens.delete(token);
        return { ok: false, code: 'SYMLINK_CHANGED', message: '目标路径校验失败（可能已被替换），请重新预览' };
      }
      try {
        // Trash only — a trash failure never falls back to a real delete.
        await this.deps.trashFn(absDir);
        status = 'trashed';
      } catch {
        return { ok: false, code: 'TRASH_FAILED', message: '移入回收站失败（未做任何永久删除）' };
      }
    } else {
      // WebDAV permanent delete: title confirmation is mandatory (§14.2.4).
      const expectedTitle = item.title ?? '';
      if (options.confirmTitle !== expectedTitle) {
        return { ok: false, code: 'TITLE_MISMATCH', message: '请输入与媒体标题完全一致的标题以确认永久删除' };
      }
      try {
        const result = await this.deps.webdavDelete({ sourceId: payload.sourceId, relativePath: payload.targetDir });
        status = result.status; // 'deleted' or 'unknown' — never pretend
      } catch {
        return { ok: false, code: 'WEBDAV_FAILED', message: 'WebDAV 删除请求失败' };
      }
    }

    this.tokens.delete(token);

    if (status === 'unknown') {
      // §14.2.7: an unknown outcome is marked, never retried or faked.
      this.repo.setAvailabilityBulk([{ id: payload.itemId, availability: 'offline' }]);
      return { ok: true, status: 'unknown', itemId: payload.itemId };
    }

    // Success: mark missing first-class, then clean managed caches.
    this.repo.setAvailabilityBulk([{ id: payload.itemId, availability: 'missing' }]);
    try {
      for (const rootDir of this.deps.managedCacheRoots) {
        rmDirShim(join(rootDir, String(payload.itemId))); // force:true: absent dirs are fine
      }
      this.deps.removeManagedCache?.(payload.itemId);
    } catch {
      // Cache cleanup failures never undo a successful media deletion.
    }
    return { ok: true, status, itemId: payload.itemId };
  }
}

import { rmSync } from 'fs';
function rmDirShim(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}
