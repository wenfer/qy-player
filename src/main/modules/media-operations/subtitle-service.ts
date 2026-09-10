import { extname, join } from 'path';
import { randomUUID } from 'crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'fs';
import { basename } from 'path';
import { detectLanguage } from '../subtitle-engine/lang-map';
import { isSupportedSubtitleExt } from '../subtitle-engine/scanner';

/**
 * Subtitle import + attachment service (QYP2-020, plan §13).
 *
 * - Imported files live under `<managedRoot>/<itemId>/` (opaque names).
 * - Import = copy to a temp file + atomic rename; the DB row is written
 *   after the file is final, and the file is removed if the insert fails
 *   (no orphans in either direction).
 * - Single file cap: 20 MiB.
 * - The source file is never touched; removing an attachment deletes the
 *   managed copy + DB row only (sidecar rows keep their original file).
 */

export const SUBTITLE_MAX_BYTES = 20 * 1024 * 1024;
const TEMP_PREFIX = '.tmp-';

export interface SubtitleAttachment {
  id: number;
  item_id: number;
  managed_path: string;
  language: string | null;
  title: string | null;
  format: string;
  origin: 'sidecar' | 'imported';
  is_default: number;
  status: 'ok' | 'missing' | 'corrupt';
}

export interface ImportSubtitleInput {
  itemId: number;
  /** Absolute path of the local subtitle file chosen by the user. */
  sourcePath: string;
  /** BCP-47-ish language tag; auto-detected from the filename when absent. */
  language?: string;
  title?: string;
  isDefault?: boolean;
}

export type SubtitleResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: 'ITEM_NOT_FOUND' | 'INVALID_INPUT' | 'TOO_LARGE' | 'IO_ERROR'; message: string } };

export interface SubtitleServiceDeps {
  repo: SubtitleRepo;
  /** Root dir, e.g. `<userData>/subtitles`; override for tests. */
  managedRoot: string;
  maxBytes?: number;
  now?: () => number;
}

/** Minimal structural repo surface (tests may pass a stub with this shape). */
export interface SubtitleRepo {
  getItem(id: number): { id: number } | undefined;
  insertSubtitle(row: {
    item_id: number;
    managed_path: string;
    language: string | null;
    title: string | null;
    format: string;
    origin: 'sidecar' | 'imported';
    is_default: number;
  }): { id: number };
  listSubtitlesByItem(itemId: number): SubtitleAttachment[];
  getSubtitle(itemId: number, rowId: number): SubtitleAttachment | undefined;
  deleteSubtitle(itemId: number, rowId: number): void;
  clearDefaultSubtitles(itemId: number, exceptId?: number): void;
  setDefaultSubtitle(itemId: number, rowId: number): void;
  insertSubtitleAsDefault(row: {
    item_id: number;
    managed_path: string;
    language: string | null;
    title: string | null;
    format: string;
    origin: 'sidecar' | 'imported';
  }): { id: number };
  listAllSubtitlePaths(): string[];
  updateSubtitleStatus(itemId: number, rowId: number, status: 'ok' | 'missing' | 'corrupt'): void;
}

/**
 * Basename hardening: the user may pass a path, but the managed name is
 * derived from the extension only — separators and `..` can never escape
 * the managed directory because no part of the source filename is used.
 */
export function validateSubtitleSource(sourcePath: string, maxBytes: number): { code: 'INVALID_INPUT' | 'TOO_LARGE' | 'IO_ERROR'; message: string } | null {
  if (typeof sourcePath !== 'string' || !sourcePath.trim()) {
    return { code: 'INVALID_INPUT', message: '字幕路径无效' };
  }
  if (sourcePath.includes('\0')) {
    return { code: 'INVALID_INPUT', message: '字幕路径包含非法字符' };
  }
  if (!isSupportedSubtitleExt(extname(sourcePath).toLowerCase())) {
    return { code: 'INVALID_INPUT', message: '仅支持 SRT / ASS / SSA / SUB / VTT 字幕' };
  }
  let stat;
  try {
    stat = statSync(sourcePath);
  } catch {
    return { code: 'IO_ERROR', message: '字幕文件不存在或不可读' };
  }
  if (!stat.isFile()) {
    return { code: 'INVALID_INPUT', message: '字幕路径不是文件' };
  }
  if (stat.size > maxBytes) {
    return { code: 'TOO_LARGE', message: `字幕文件超过 ${Math.round(maxBytes / 1024 / 1024)} MiB 上限` };
  }
  return null;
}

/** Startup recovery: sweep temp files AND final files the DB lost track
 * of (crash between rename and insert). `knownPaths` = all managed_path
 * values still referenced by catalog_subtitles. */
export function cleanupTempFiles(managedRoot: string, knownPaths: Set<string> = new Set()): number {
  if (!existsSync(managedRoot)) return 0;
  let removed = 0;
  for (const entry of readdirSync(managedRoot)) {
    const dir = join(managedRoot, entry);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const file of readdirSync(dir)) {
      const isTemp = file.startsWith(TEMP_PREFIX);
      const fullPath = join(dir, file);
      const isOrphan = !isTemp && !knownPaths.has(fullPath);
      if (!isTemp && !isOrphan) continue;
      try {
        rmSync(fullPath, { force: true });
        removed += 1;
      } catch {
        // best effort; the next startup retries
      }
    }
  }
  return removed;
}

export class SubtitleService {
  private readonly repo: SubtitleServiceDeps['repo'];
  private readonly managedRoot: string;
  private readonly maxBytes: number;
  private readonly now: () => number;

  constructor(deps: SubtitleServiceDeps) {
    this.repo = deps.repo;
    this.managedRoot = deps.managedRoot;
    this.maxBytes = deps.maxBytes ?? SUBTITLE_MAX_BYTES;
    this.now = deps.now ?? Date.now;
  }

  itemDir(itemId: number): string {
    return join(this.managedRoot, String(itemId));
  }

  /** Copy → temp file → fsync-order rename → DB row (rollback file on failure). */
  import(input: ImportSubtitleInput): SubtitleResult<SubtitleAttachment> {
    if (!Number.isInteger(input?.itemId) || (input.itemId as number) <= 0) {
      return { ok: false, error: { code: 'INVALID_INPUT', message: '条目 ID 无效' } };
    }
    const item = this.repo.getItem(input.itemId);
    if (!item) {
      return { ok: false, error: { code: 'ITEM_NOT_FOUND', message: '条目不存在' } };
    }
    const problem = validateSubtitleSource(input.sourcePath, this.maxBytes);
    if (problem) {
      return { ok: false, error: problem };
    }
    const ext = extname(input.sourcePath).toLowerCase();

    const dir = this.itemDir(input.itemId);
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      return { ok: false, error: { code: 'IO_ERROR', message: '创建字幕目录失败' } };
    }

    // Opaque managed name: only the validated extension survives from the
    // source; the source filename never touches the filesystem here.
    const managedName = `${TEMP_PREFIX}${randomUUID().slice(0, 8)}${ext}`;
    const tempPath = join(dir, managedName);
    const finalName = `sub-${this.now().toString(36)}-${randomUUID().slice(0, 6)}${ext}`;
    const finalPath = join(dir, finalName);

    try {
      copyFileSync(input.sourcePath, tempPath);
      // TOCTOU re-check: the source may have grown past the cap between
      // validation and copy; the managed copy is what actually lands.
      if (statSync(tempPath).size > this.maxBytes) {
        rmSync(tempPath, { force: true });
        return { ok: false, error: { code: 'TOO_LARGE', message: `字幕文件超过 ${Math.round(this.maxBytes / 1024 / 1024)} MiB 上限` } };
      }
      // Atomic within the same filesystem; a crash mid-copy leaves only a
      // .tmp- file that cleanupTempFiles removes on the next startup.
      renameAtomic(tempPath, finalPath);
    } catch {
      try {
        rmSync(tempPath, { force: true });
      } catch {
        // nothing to clean
      }
      return { ok: false, error: { code: 'IO_ERROR', message: '字幕复制失败' } };
    }

    // Length caps keep arbitrary renderer input out of the DB/UI.
    const language = (input.language?.trim() || detectLanguage(basename(input.sourcePath)).code || '').slice(0, 32) || null;
    const title = input.title?.trim().slice(0, 200) || null;
    try {
      // insert + default switch are one transaction: no two-defaults or
      // orphan-file states even if interrupted.
      const row = input.isDefault
        ? this.repo.insertSubtitleAsDefault({
            item_id: input.itemId,
            managed_path: finalPath,
            language,
            title,
            format: ext.slice(1),
            origin: 'imported',
          })
        : this.repo.insertSubtitle({
            item_id: input.itemId,
            managed_path: finalPath,
            language,
            title,
            format: ext.slice(1),
            origin: 'imported',
            is_default: 0,
          });
      return {
        ok: true,
        data: {
          id: row.id,
          item_id: input.itemId,
          managed_path: finalPath,
          language,
          title,
          format: ext.slice(1),
          origin: 'imported',
          is_default: input.isDefault ? 1 : 0,
          status: 'ok',
        },
      };
    } catch {
      // No orphan files: the row failed, so the managed copy must go.
      try {
        rmSync(finalPath, { force: true });
      } catch {
        // best effort
      }
      return { ok: false, error: { code: 'IO_ERROR', message: '字幕记录写入失败' } };
    }
  }

  /**
   * List + existence sweep: rows whose managed file vanished (restart,
   * manual cleanup) flip to `missing` instead of silently disappearing.
   * This is the restart-recovery surface.
   */
  list(itemId: number): SubtitleResult<SubtitleAttachment[]> {
    if (!Number.isInteger(itemId) || itemId <= 0) {
      return { ok: false, error: { code: 'INVALID_INPUT', message: '条目 ID 无效' } };
    }
    if (!this.repo.getItem(itemId)) {
      return { ok: false, error: { code: 'ITEM_NOT_FOUND', message: '条目不存在' } };
    }
    for (const row of this.repo.listSubtitlesByItem(itemId)) {
      const exists = existsSync(row.managed_path);
      // Bidirectional sweep: missing must not stick when the file comes
      // back (volume remounted, manual restore); corrupt stays untouched.
      if (!exists && row.status !== 'missing') {
        this.repo.updateSubtitleStatus(itemId, row.id, 'missing');
      } else if (exists && row.status === 'missing') {
        this.repo.updateSubtitleStatus(itemId, row.id, 'ok');
      }
    }
    return { ok: true, data: this.repo.listSubtitlesByItem(itemId) };
  }

  /** Remove one attachment; sidecar originals are never touched. */
  remove(itemId: number, rowId: number): SubtitleResult<{ removed: boolean }> {
    if (!Number.isInteger(itemId) || !Number.isInteger(rowId)) {
      return { ok: false, error: { code: 'INVALID_INPUT', message: '参数无效' } };
    }
    const row = this.repo.getSubtitle(itemId, rowId);
    if (!row) {
      return { ok: false, error: { code: 'ITEM_NOT_FOUND', message: '字幕关联不存在' } };
    }
    this.repo.deleteSubtitle(itemId, rowId);
    // Imported rows own their managed copy; sidecar rows reference files
    // outside our control and must never be deleted. Row goes first: a
    // file-delete failure then self-heals via the list() sweep instead of
    // leaving a dangling row.
    if (row.origin === 'imported' && existsSync(row.managed_path)) {
      try {
        rmSync(row.managed_path, { force: true });
      } catch {
        return { ok: false, error: { code: 'IO_ERROR', message: '字幕文件删除失败，稍后将显示为缺失' } };
      }
    }
    return { ok: true, data: { removed: true } };
  }

  setDefault(itemId: number, rowId: number): SubtitleResult<{ updated: boolean }> {
    const row = this.repo.getSubtitle(itemId, rowId);
    if (!row) {
      return { ok: false, error: { code: 'ITEM_NOT_FOUND', message: '字幕关联不存在' } };
    }
    this.repo.setDefaultSubtitle(itemId, rowId);
    return { ok: true, data: { updated: true } };
  }
}

/** Same-directory rename (temp → final); same filesystem keeps it atomic. */
export function renameAtomic(from: string, to: string): void {
  renameSync(from, to);
}
