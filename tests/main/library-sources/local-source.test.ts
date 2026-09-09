import { createReadStream } from 'node:fs';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: (name: string) => join(tmpdir(), 'qy-local-source-test', name) },
}));

import { openDatabaseAtPath } from '../../../src/main/modules/storage/db';
import { createCatalogRepository } from '../../../src/main/modules/catalog/repository';
import {
  createLocalSourceFromSelection,
  getAdapterForSource,
  removeSource,
} from '../../../src/main/modules/catalog/source-service';
import { LocalSourceAdapter } from '../../../src/main/modules/library-sources/local-source';

const tmpRoots: string[] = [];
afterAll(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
});

let db: ReturnType<typeof openDatabaseAtPath>;
let repo: ReturnType<typeof createCatalogRepository>;
let root: string;
let baseDir: string;

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'qy-local-'));
  tmpRoots.push(baseDir);
  root = join(baseDir, 'library');
  mkdirSync(root, { recursive: true });
  db = openDatabaseAtPath(join(baseDir, 'test.db'));
  repo = createCatalogRepository(db);
});

function write(relPath: string, content = 'x'): void {
  const abs = join(root, relPath);
  mkdirSync(abs.slice(0, abs.lastIndexOf('/')), { recursive: true });
  writeFileSync(abs, content);
}

describe('root canonicalization (plan §7)', () => {
  it('canonicalizes a symlinked selection to the real path', () => {
    const target = mkdtempSync(join(tmpdir(), 'qy-real-'));
    tmpRoots.push(target);
    const linkPath = join(baseDir, 'link-to-library');
    symlinkSync(target, linkPath);

    const created = createLocalSourceFromSelection(db, linkPath, { name: 'Movies' });
    expect(created.root).toBe(target); // realpath, not the link path
    const source = repo.getSource(created.sourceId)!;
    expect(source.kind).toBe('local');
    expect(source.read_only).toBe(1); // deletion disabled by default
  });

  it('rejects relative, missing and non-directory paths', () => {
    expect(() => createLocalSourceFromSelection(db, 'relative/path')).toThrow();
    expect(() => createLocalSourceFromSelection(db, join(root, 'missing'))).toThrow();
    write('afile.txt');
    expect(() => createLocalSourceFromSelection(db, join(root, 'afile.txt'))).toThrow(/不是目录/);
  });

  it('rejects empty selection', () => {
    expect(() => createLocalSourceFromSelection(db, '')).toThrow();
  });
});

describe('LocalSourceAdapter.list (depth-1, no symlink follow)', () => {
  it('yields entries with joined relative paths', async () => {
    write('Movies/a.mkv');
    write('Movies/b.mkv');
    mkdirSync(join(root, 'TV'));
    const created = createLocalSourceFromSelection(db, root);
    const { adapter } = getAdapterForSource(db, created.sourceId);

    const listed: string[] = [];
    for await (const entry of adapter.list('', new AbortController().signal)) {
      listed.push(`${entry.relativePath}${entry.isDirectory ? '/' : ''}`);
    }
    expect(listed.sort()).toEqual(['Movies/', 'TV/']);
  });

  it('never reports a symlinked directory as a directory', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'qy-outside-'));
    tmpRoots.push(outside);
    writeFileSync(join(outside, 'secret.mkv'), 'x');

    write('real.mkv');
    symlinkSync(outside, join(root, 'lnk-dir'));
    symlinkSync(join(root, 'real.mkv'), join(root, 'lnk-file.mkv'));

    const created = createLocalSourceFromSelection(db, root);
    const { adapter } = getAdapterForSource(db, created.sourceId);

    const listed = new Map<string, boolean>();
    for await (const entry of adapter.list('', new AbortController().signal)) {
      listed.set(entry.relativePath, entry.isDirectory);
    }
    // Both symlinks are reported as non-directories -> scanner will not
    // descend through lnk-dir, and lnk-file stays a plain file entry.
    expect(listed.get('lnk-dir')).toBe(false);
    expect(listed.get('lnk-file.mkv')).toBe(false);
    // Outside content is never reachable through traversal.
    expect([...listed.keys()].some((p) => p.includes('secret'))).toBe(false);
  });

  it('stops promptly when the signal is aborted mid-traversal', async () => {
    for (let i = 0; i < 50; i++) write(`bulk/f${i}.mkv`);
    const created = createLocalSourceFromSelection(db, root);
    const { adapter } = getAdapterForSource(db, created.sourceId);

    const controller = new AbortController();
    let count = 0;
    for await (const _entry of adapter.list('bulk', controller.signal)) {
      count += 1;
      if (count === 3) controller.abort();
    }
    expect(count).toBeLessThan(50);
  });
});

describe('root containment', () => {
  it('rejects escapes in list/stat/open', async () => {
    write('inside.mkv');
    writeFileSync(join(root, '..', 'outside-secret.mkv'), 'x');
    const created = createLocalSourceFromSelection(db, root);
    const { adapter } = getAdapterForSource(db, created.sourceId);
    const signal = new AbortController().signal;

    // list: the escape is rejected when iteration starts (first next()).
    await expect(async () => {
      for await (const _e of adapter.list('../', signal)) {
        // no-op
      }
    }).rejects.toThrow(/越界/);

    expect(() => LocalSourceAdapter.fromSource(created.sourceId, root).resolveInside('../outside-secret.mkv')).toThrow(/越界/);
    await expect(
      adapter.stat({ sourceId: created.sourceId, relativePath: '../outside-secret.mkv' }, signal)
    ).rejects.toThrow();
    expect(() => LocalSourceAdapter.fromSource(created.sourceId, root).resolveInside('/etc/passwd')).toThrow();
    expect(() => LocalSourceAdapter.fromSource(created.sourceId, root).resolveInside('a\0b')).toThrow();
    expect(() => LocalSourceAdapter.fromSource(created.sourceId, root).resolveInside('ok/../../escape.mkv')).toThrow();
  });

  it('accepts legitimate nested paths', () => {
    const adapter = LocalSourceAdapter.fromSource(1, root);
    expect(adapter.resolveInside('Movies/Season 01/e01.mkv')).toBe(
      join(root, 'Movies', 'Season 01', 'e01.mkv')
    );
    expect(adapter.resolveInside('')).toBe(root);
  });
});

describe('stat/open', () => {
  it('stats regular files and opens readable streams', async () => {
    write('media/movie.mkv', 'FAKE_VIDEO_BYTES');
    const created = createLocalSourceFromSelection(db, root);
    const { adapter } = getAdapterForSource(db, created.sourceId);
    const signal = new AbortController().signal;

    const st = await adapter.stat(
      { sourceId: created.sourceId, relativePath: 'media/movie.mkv' },
      signal
    );
    expect(st.size).toBe('FAKE_VIDEO_BYTES'.length);
    expect(st.supportsRange).toBe(true);

    const resource = await adapter.open(
      { sourceId: created.sourceId, relativePath: 'media/movie.mkv' },
      signal
    );
    expect(resource.supportsRange).toBe(true);
    const chunks: Buffer[] = [];
    const stream = resource.stream as typeof createReadStream.prototype;
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString('utf-8')).toBe('FAKE_VIDEO_BYTES');
  });

  it('rejects foreign locators and missing files', async () => {
    write('movie.mkv');
    const created = createLocalSourceFromSelection(db, root);
    const { adapter } = getAdapterForSource(db, created.sourceId);
    const signal = new AbortController().signal;

    await expect(
      adapter.stat({ sourceId: created.sourceId + 1, relativePath: 'movie.mkv' }, signal)
    ).rejects.toThrow(/不属于当前来源/);
    await expect(
      adapter.stat({ sourceId: created.sourceId, relativePath: 'missing.mkv' }, signal)
    ).rejects.toThrow();
  });
});

describe('source removal never touches media (plan §7)', () => {
  it('drops index rows but keeps files on disk', async () => {
    write('movie.mkv');
    const created = createLocalSourceFromSelection(db, root);
    const sourceId = created.sourceId;
    const itemId = repo.upsertItem({ sourceId, sourceKey: 'movie.mkv', kind: 'movie', title: 'M' });
    repo.upsertFile({ sourceId, itemId, relativePath: 'movie.mkv', size: 1 });

    removeSource(db, sourceId);

    expect(repo.getSource(sourceId)).toBeUndefined();
    expect(repo.getItem(itemId)).toBeUndefined();
    // The real file is untouched.
    expect(() => readFileSync(join(root, 'movie.mkv'))).not.toThrow();
    expect(() => getAdapterForSource(db, sourceId)).toThrow(/来源不存在/);
  });
});

describe('unreadable directories surface errors (plan §7)', () => {
  it('list on an unreadable directory rejects instead of pretending success', async () => {
    write('movie.mkv');
    mkdirSync(join(root, 'locked'));
    const created = createLocalSourceFromSelection(db, root);
    const { adapter } = getAdapterForSource(db, created.sourceId);

    chmodSync(join(root, 'locked'), 0o000);
    try {
      await expect(async () => {
        for await (const _e of adapter.list('locked', new AbortController().signal)) {
          // no-op
        }
      }).rejects.toThrow();
    } finally {
      chmodSync(join(root, 'locked'), 0o755);
    }
  });
});
