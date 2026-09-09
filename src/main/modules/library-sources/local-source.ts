import { createReadStream } from 'node:fs';
import { accessSync, constants, lstatSync, realpathSync, statSync } from 'node:fs';
import { lstat, opendir } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import type { MediaLocator, ReadableResource, SourceAdapter, SourceEntry, SourceStat } from './types';
import type { SourceCapabilities } from '../../../shared/types';

/**
 * Local-filesystem source adapter (plan §7, QYP2-007).
 *
 * - Root is a single canonical absolute directory chosen via the Electron
 *   directory picker; it must exist, be readable, and stay inside itself.
 * - Depth-1 traversal via async opendir; symlinks are NEVER followed
 *   (plan §7: any future "follow" needs its own loop-detection design).
 * - All path resolution goes through resolveInside(), which enforces
 *   containment; renderer-supplied paths are never accepted.
 * - Removal of a source only drops index rows; this adapter has no delete
 *   capability (canDelete stays false until the safe-delete service of
 *   QYP2-024 explicitly enables it per source).
 */

export class LocalSourceAdapter implements SourceAdapter {
  readonly kind = 'local' as const;

  constructor(
    private readonly sourceId: number,
    /** Canonical absolute root (realpath'd at creation time). */
    private readonly root: string
  ) {}

  /** Canonicalize and validate a user-picked directory (plan §7). */
  static canonicalizeRoot(selectedPath: string): string {
    if (!selectedPath || !isAbsolute(selectedPath)) {
      throw new Error('来源目录必须是绝对路径');
    }
    let real: string;
    try {
      real = realpathSync.native(selectedPath);
    } catch {
      throw new Error('目录不存在或无法访问');
    }
    const st = statSync(real);
    if (!st.isDirectory()) {
      throw new Error('所选路径不是目录');
    }
    accessSync(real, constants.R_OK);
    return real;
  }

  /** Build an adapter from a stored source row. */
  static fromSource(sourceId: number, root: string): LocalSourceAdapter {
    return new LocalSourceAdapter(sourceId, root);
  }

  private insideLabel(relPath: string): string {
    return relPath === '' ? '<source>' : `<source>/${relPath}`;
  }

  /**
   * Resolve a relative path strictly inside the root; no escapes, ever.
   * Public: it is the only sanctioned way to turn stored relative paths
   * into absolute ones.
   *
   * Two-layer defense:
   * 1. String-level containment against the canonical root (cheap, catches
   *    every path without I/O).
   * 2. A realpath re-check of the final target: if the root (or an ancestor)
   *    was swapped for a symlink AFTER creation, the real location is
   *    exposed here and rejected (TOCTOU defense). Missing targets fall
   *    back to the string-level result (nothing to follow yet).
   */
  resolveInside(relativePath: string): string {
    if (relativePath.includes('\0')) {
      throw new Error(`非法路径: ${this.insideLabel(relativePath)}`);
    }
    if (isAbsolute(relativePath)) {
      throw new Error(`非法路径（绝对路径不允许）: ${this.insideLabel(relativePath)}`);
    }
    // Root may be "/" (ends with the separator); keep "/" itself intact and
    // strip a trailing sep from longer roots so prefix checks keep working.
    const effectiveRoot = this.root === sep ? sep : this.root.endsWith(sep) ? this.root.slice(0, -1) : this.root;
    const prefixBase = effectiveRoot.endsWith(sep) ? effectiveRoot : effectiveRoot + sep;
    const normalized = resolve(effectiveRoot, relativePath);
    if (normalized !== effectiveRoot && !normalized.startsWith(prefixBase)) {
      throw new Error(`路径越界: ${this.insideLabel(relativePath)}`);
    }
    try {
      const real = realpathSync.native(normalized);
      if (real !== effectiveRoot && !real.startsWith(prefixBase)) {
        throw new Error(`路径越界（symlink 重定向）: ${this.insideLabel(relativePath)}`);
      }
      return real;
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('路径越界')) throw err;
      // ENOENT and friends: the string-level check already passed.
      return normalized;
    }
  }

  async testConnection(_signal: AbortSignal): Promise<SourceCapabilities> {
    try {
      const st = statSync(this.root);
      if (!st.isDirectory()) {
        throw new Error('来源根目录不可用：不是目录');
      }
      accessSync(this.root, constants.R_OK);
    } catch (err) {
      throw new Error(
        `来源根目录不可读: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    // Local files are seekable; deletion stays disabled until QYP2-024.
    return { canSeek: true, canDelete: false, supportsEtag: false, supportsRange: true };
  }

  async *list(relativePath: string, signal: AbortSignal): AsyncIterable<SourceEntry> {
    const abs = this.resolveInside(relativePath);
    const prefix = relativePath === '' ? '' : `${relativePath.replace(/\/+$/, '')}/`;
    // Abort handling is cooperative: checked before opening and between
    // entries (Node 16 opendir does not take a signal). The async iterator
    // closes the handle on normal completion and on early return/throw.
    if (signal.aborted) return;
    const dir = await opendir(abs);

    try {
      for await (const dirent of dir) {
        if (signal.aborted) return;
        // Symlinks are never followed: report them as non-directories so the
        // recursive scanner will not descend through them (plan §7).
        const isDirectory = dirent.isDirectory() && !dirent.isSymbolicLink();
        const entryRelative = `${prefix}${dirent.name}`;
        let size: number | undefined;
        let mtimeMs: number | undefined;
        // Async lstat keeps the event loop free on large dirs (plan §16.4).
        try {
          const st = await lstat(join(abs, dirent.name));
          size = st.size;
          mtimeMs = st.mtimeMs;
        } catch (err) {
          // Entry vanished between readdir and lstat: yield with unknown size.
          const code = (err as { code?: string })?.code;
          console.error(
            '[LOCAL-SOURCE] 条目 lstat 失败（可能已被移动或删除）:',
            entryRelative,
            code ?? (err instanceof Error ? err.message : String(err))
          );
        }
        yield {
          relativePath: entryRelative,
          isDirectory,
          size,
          mtime: mtimeMs,
        };
      }
    } finally {
      // The async iterator closes the handle on normal completion, early
      // return and throws; a defensive close with error swallowing covers
      // Node-version differences in fd handling (review O9).
      await dir.close().catch(() => undefined);
    }
  }

  async stat(locator: MediaLocator, signal: AbortSignal): Promise<SourceStat> {
    this.assertOwnLocator(locator);
    const abs = this.resolveInside(locator.relativePath);
    if (signal.aborted) throw new Error('已取消');
    const st = lstatSync(abs); // throws ENOENT for missing files
    // Live symlinks were already redirected to their real target by
    // resolveInside (and rejected when that escapes the root); broken
    // symlinks land here as-is and must not be opened.
    if (st.isSymbolicLink()) {
      throw new Error('不支持符号链接条目（目标缺失或已损坏）');
    }
    if (st.isDirectory()) {
      throw new Error('不能对目录执行 stat（应为媒体文件）');
    }
    return {
      size: st.size,
      mtime: st.mtimeMs,
      supportsRange: st.isFile(),
    };
  }

  async open(locator: MediaLocator, signal: AbortSignal): Promise<ReadableResource> {
    const st = await this.stat(locator, signal);
    const abs = this.resolveInside(locator.relativePath);
    const stream = createReadStream(abs, { signal });
    return { stream, size: st.size, supportsRange: st.supportsRange };
  }

  private assertOwnLocator(locator: MediaLocator): void {
    if (locator.sourceId !== this.sourceId) {
      throw new Error('locator 不属于当前来源');
    }
    // No '..' / absolute checks here: resolveInside() is the single place
    // that validates path shapes, and it must accept legal segments like
    // 'a/../b' (normalized before the containment check).
    if (!locator.relativePath) {
      throw new Error('locator 缺少有效相对路径');
    }
  }
}
