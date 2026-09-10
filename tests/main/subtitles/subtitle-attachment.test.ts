import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabaseAtPath } from '../../../src/main/modules/storage/db';
import { createCatalogRepository, type CatalogRepository } from '../../../src/main/modules/catalog/repository';
import {
  SubtitleService,
  SUBTITLE_MAX_BYTES,
  cleanupTempFiles,
  validateSubtitleSource,
} from '../../../src/main/modules/media-operations/subtitle-service';

let root: string;
let dbPath: string;
let db: ReturnType<typeof openDatabaseAtPath>;
let repo: CatalogRepository;
let managedRoot: string;
let sourceDir: string;
let service: SubtitleService;
let sourceId: number;
let itemId: number;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'qy-subtitles-'));
  dbPath = join(root, 'test.db');
  db = openDatabaseAtPath(dbPath);
  repo = createCatalogRepository(db);
  managedRoot = join(root, 'managed');
  sourceDir = join(root, 'source');
  mkdirSync(sourceDir, { recursive: true });
  service = new SubtitleService({ repo, managedRoot });
  sourceId = repo.createSource({ kind: 'local', name: '库', root: '/media' });
  itemId = repo.upsertItem({ sourceId, sourceKey: 'movie-1', kind: 'movie', title: '电影' });
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function makeSubtitleFile(name: string, sizeBytes?: number, content = '字幕内容'): string {
  const p = join(sourceDir, name);
  if (sizeBytes !== undefined) {
    writeFileSync(p, Buffer.alloc(sizeBytes, 0x61));
  } else {
    writeFileSync(p, content);
  }
  return p;
}

describe('subtitle import (QYP2-020)', () => {
  it('copies into the managed dir via temp+rename and persists the row', () => {
    const src = makeSubtitleFile('movie.chi.srt');
    const result = service.import({ itemId, sourcePath: src, isDefault: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = result.data;
    expect(row.origin).toBe('imported');
    expect(row.format).toBe('srt');
    expect(row.status).toBe('ok');
    expect(row.is_default).toBe(1);
    // Language auto-detected from the filename.
    expect(row.language).toBeTruthy();
    // Managed copy exists under <managedRoot>/<itemId>/ and content matches.
    expect(row.managed_path.startsWith(join(managedRoot, String(itemId)))).toBe(true);
    expect(existsSync(row.managed_path)).toBe(true);
    expect(readFileSync(row.managed_path, 'utf8')).toBe('字幕内容');
    // No temp files left behind.
    const dirFiles = require('fs').readdirSync(join(managedRoot, String(itemId))) as string[];
    expect(dirFiles.every((f) => !f.startsWith('.tmp-'))).toBe(true);
    // Source file untouched.
    expect(existsSync(src)).toBe(true);
  });

  it('rejects files over the 20 MiB cap without leaving traces', () => {
    const src = makeSubtitleFile('huge.srt', SUBTITLE_MAX_BYTES + 1);
    const result = service.import({ itemId, sourcePath: src });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('TOO_LARGE');
    expect(existsSync(managedRoot)).toBe(false);
  });

  it('rejects non-whitelisted extensions', () => {
    const src = makeSubtitleFile('evil.exe');
    const result = service.import({ itemId, sourcePath: src });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_INPUT');
  });

  it('rejects missing/unreadable sources (copy failure, no orphan rows)', () => {
    const result = service.import({ itemId, sourcePath: join(sourceDir, 'ghost.srt') });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('IO_ERROR');
    expect(repo.listSubtitlesByItem(itemId)).toEqual([]);
    expect(existsSync(managedRoot)).toBe(false);
  });

  it('rejects unknown items and invalid ids', () => {
    const src = makeSubtitleFile('a.srt');
    const bad = service.import({ itemId: 999999, sourcePath: src });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe('ITEM_NOT_FOUND');
    const invalid = service.import({ itemId: -1, sourcePath: src });
    expect(invalid.ok).toBe(false);
  });

  it('rejects NUL-byte paths', () => {
    const result = service.import({ itemId, sourcePath: '/data/a\0.srt' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_INPUT');
  });

  it('a new default unsets the previous default', () => {
    const first = service.import({ itemId, sourcePath: makeSubtitleFile('a.chi.srt'), isDefault: true });
    const second = service.import({ itemId, sourcePath: makeSubtitleFile('b.eng.ass'), isDefault: true });
    expect(first.ok && second.ok).toBe(true);
    if (!(first.ok && second.ok)) return;
    const rows = repo.listSubtitlesByItem(itemId);
    const defaults = rows.filter((r) => r.is_default === 1);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].id).toBe(second.data.id);
  });

  it('respects an explicit language over filename detection', () => {
    const result = service.import({ itemId, sourcePath: makeSubtitleFile('movie.chi.srt'), language: 'zh-TW' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.language).toBe('zh-TW');
  });

  it('cleanupTempFiles removes leftovers from interrupted imports', () => {
    const dir = join(managedRoot, String(itemId));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.tmp-aborted.srt'), 'partial');
    writeFileSync(join(dir, 'sub-real.srt'), 'final');
    const removed = cleanupTempFiles(managedRoot);
    expect(removed).toBe(1);
    expect(existsSync(join(dir, '.tmp-aborted.srt'))).toBe(false);
    expect(existsSync(join(dir, 'sub-real.srt'))).toBe(true);
  });
});

describe('subtitle listing and restart recovery', () => {
  it('lists rows and marks missing when the managed file vanished', () => {
    const imported = service.import({ itemId, sourcePath: makeSubtitleFile('a.srt') });
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    // Simulate a restart where the managed file was wiped (e.g. manual clean).
    rmSync(imported.data.managed_path, { force: true });
    const listed = service.list(itemId);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.data[0].status).toBe('missing');
    // Persisted, not just decorated.
    expect(repo.listSubtitlesByItem(itemId)[0].status).toBe('missing');
  });

  it('errors on unknown items when listing', () => {
    const listed = service.list(424242);
    expect(listed.ok).toBe(false);
  });
});

describe('subtitle removal (plan §13: originals untouched)', () => {
  it('removes the managed copy of an imported row', () => {
    const imported = service.import({ itemId, sourcePath: makeSubtitleFile('a.srt') });
    if (!imported.ok) throw new Error('import failed');
    const removed = service.remove(itemId, imported.data.id);
    expect(removed.ok).toBe(true);
    expect(existsSync(imported.data.managed_path)).toBe(false);
    expect(repo.listSubtitlesByItem(itemId)).toEqual([]);
  });

  it('sidecar rows only drop the association - the original file stays', () => {
    const sidecarPath = makeSubtitleFile('movie.chi.srt');
    const before = statSync(sidecarPath);
    repo.insertSubtitle({
      item_id: itemId,
      managed_path: sidecarPath,
      language: 'zh',
      title: null,
      format: 'srt',
      origin: 'sidecar',
      is_default: 0,
    });
    const [row] = repo.listSubtitlesByItem(itemId);
    const removed = service.remove(itemId, row.id);
    expect(removed.ok).toBe(true);
    expect(existsSync(sidecarPath)).toBe(true);
    expect(statSync(sidecarPath).size).toBe(before.size);
  });

  it('returns ITEM_NOT_FOUND for unknown rows', () => {
    const removed = service.remove(itemId, 999);
    expect(removed.ok).toBe(false);
    if (!removed.ok) expect(removed.error.code).toBe('ITEM_NOT_FOUND');
  });

  it('setDefault switches exactly one default', () => {
    const a = service.import({ itemId, sourcePath: makeSubtitleFile('a.srt'), isDefault: true });
    const b = service.import({ itemId, sourcePath: makeSubtitleFile('b.srt') });
    if (!(a.ok && b.ok)) throw new Error('import failed');
    const set = service.setDefault(itemId, b.data.id);
    expect(set.ok).toBe(true);
    const defaults = repo.listSubtitlesByItem(itemId).filter((r) => r.is_default === 1);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].id).toBe(b.data.id);
  });
});

describe('validateSubtitleSource boundaries', () => {
  it('accepts exactly 20 MiB and rejects one byte more', () => {
    const okPath = makeSubtitleFile('ok.vtt', SUBTITLE_MAX_BYTES);
    expect(validateSubtitleSource(okPath, SUBTITLE_MAX_BYTES)).toBeNull();
    const overPath = makeSubtitleFile('over.vtt', SUBTITLE_MAX_BYTES + 1);
    expect(validateSubtitleSource(overPath, SUBTITLE_MAX_BYTES)?.code).toBe('TOO_LARGE');
  });

  it('accepts every whitelisted extension', () => {
    for (const ext of ['srt', 'ass', 'ssa', 'sub', 'vtt']) {
      const p = makeSubtitleFile(`f.${ext}`);
      expect(validateSubtitleSource(p, SUBTITLE_MAX_BYTES)).toBeNull();
    }
  });

  it('rejects directory paths', () => {
    expect(validateSubtitleSource(sourceDir, SUBTITLE_MAX_BYTES)?.code).toBe('INVALID_INPUT');
  });
});
