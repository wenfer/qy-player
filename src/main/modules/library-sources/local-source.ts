import { createReadStream } from 'node:fs';
import { accessSync, constants, lstatSync, realpathSync, statSync } from 'node:fs';
import { opendir } from 'node:fs/promises';
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
   */
  resolveInside(relativePath: string): string {
    if (relativePath.includes('\0')) {
      throw new Error(`非法路径: ${this.insideLabel(relativePath)}`);
    }
    if (isAbsolute(relativePath)) {
      throw new Error(`非法路径（绝对路径不允许）: ${this.insideLabel(relativePath)}`);
    }
    const normalized = resolve(this.root, relativePath);
    if (normalized !== this.root && !normalized.startsWith(this.root + sep)) {
      throw new Error(`路径越界: ${this.insideLabel(relativePath)}`);
    }
    return normalized;
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

    for await (const dirent of dir) {
      if (signal.aborted) return;
      // Symlinks are never followed: report them as non-directories so the
      // recursive scanner will not descend through them (plan §7).
      const isDirectory = dirent.isDirectory() && !dirent.isSymbolicLink();
      const entryRelative = `${prefix}${dirent.name}`;
      let size: number | undefined;
      let mtimeMs: number | undefined;
      try {
        const st = lstatSync(join(abs, dirent.name));
        size = st.size;
        mtimeMs = st.mtimeMs;
      } catch {
        // Entry vanished between readdir and lstat: yield with unknown size.
      }
      yield {
        relativePath: entryRelative,
        isDirectory,
        size,
        mtime: mtimeMs,
      };
    }
  }

  async stat(locator: MediaLocator, signal: AbortSignal): Promise<SourceStat> {
    this.assertOwnLocator(locator);
    const abs = this.resolveInside(locator.relativePath);
    if (signal.aborted) throw new Error('已取消');
    const st = lstatSync(abs); // throws ENOENT for missing files
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
    if (!locator.relativePath || locator.relativePath.includes('..')) {
      throw new Error('locator 缺少有效相对路径');
    }
  }
}
