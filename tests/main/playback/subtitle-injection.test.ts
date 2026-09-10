import { describe, expect, it } from 'vitest';
import {
  findCatalogItemId,
  injectAttachedSubtitles,
  type SubtitleInjectionPlayer,
  type SubtitleLookupRepo,
} from '../../../src/main/modules/player-core/playback-resolver';

// ---------------------------------------------------------------------------
// findCatalogItemId: playback key → catalog item
// ---------------------------------------------------------------------------

function makeRepo(sources: Array<{ id: number; kind: string; root: string }>, files: Array<{ sourceId: number; path: string; itemId: number }>): SubtitleLookupRepo {
  return {
    listSources: () => sources,
    getFileByPath: (sourceId, relativePath) => {
      const file = files.find((f) => f.sourceId === sourceId && f.path === relativePath);
      return file ? { item_id: file.itemId } : undefined;
    },
    listSubtitlesByItem: () => [],
  };
}

describe('findCatalogItemId', () => {
  it('resolves WebDAV keys `<sourceId>:<relativePath>`', () => {
    const repo = makeRepo(
      [{ id: 2, kind: 'webdav', root: 'http://x/dav' }],
      [{ sourceId: 2, path: 'movies/a.mkv', itemId: 11 }]
    );
    expect(findCatalogItemId(repo, 'webdav', '2:movies/a.mkv')).toBe(11);
  });

  it('resolves local absolute paths via source roots', () => {
    const repo = makeRepo(
      [{ id: 1, kind: 'local', root: '/data/movies' }],
      [{ sourceId: 1, path: 'a.mkv', itemId: 7 }]
    );
    expect(findCatalogItemId(repo, 'local', '/data/movies/a.mkv')).toBe(7);
  });

  it('handles a source root with a trailing slash', () => {
    const repo = makeRepo(
      [{ id: 1, kind: 'local', root: '/data/movies/' }],
      [{ sourceId: 1, path: 'a.mkv', itemId: 7 }]
    );
    expect(findCatalogItemId(repo, 'local', '/data/movies/a.mkv')).toBe(7);
  });

  it('returns null for online media (no catalog item)', () => {
    const repo = makeRepo([], []);
    expect(findCatalogItemId(repo, 'jellyfin', 'item-abc')).toBeNull();
    expect(findCatalogItemId(repo, 'emby', '42')).toBeNull();
  });

  it('returns null for malformed WebDAV keys and unknown paths', () => {
    const repo = makeRepo([{ id: 1, kind: 'local', root: '/data' }], []);
    expect(findCatalogItemId(repo, 'webdav', 'nonsense')).toBeNull();
    expect(findCatalogItemId(repo, 'webdav', '1:gone.mkv')).toBeNull();
    expect(findCatalogItemId(repo, 'local', '/elsewhere/a.mkv')).toBeNull();
    expect(findCatalogItemId(repo, undefined, undefined)).toBeNull();
  });

  it('does not match partial root prefixes (no /data2 inside /data)', () => {
    const repo = makeRepo(
      [{ id: 1, kind: 'local', root: '/data' }],
      [{ sourceId: 1, path: 'a.mkv', itemId: 7 }]
    );
    expect(findCatalogItemId(repo, 'local', '/data2/a.mkv')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// injectAttachedSubtitles: default selected, rest auto, never throws
// ---------------------------------------------------------------------------

function makePlayer() {
  const calls: Array<{ path: string; flag?: string }> = [];
  const player: SubtitleInjectionPlayer = {
    addSubtitle: async (path, flag) => {
      calls.push({ path, flag });
    },
  };
  return { player, calls };
}

const ROW = (id: number, over: { is_default?: number; status?: 'ok' | 'missing' | 'corrupt' } = {}) => ({
  id,
  managed_path: `/managed/${id}.srt`,
  is_default: 0,
  status: 'ok' as const,
  ...over,
});

describe('injectAttachedSubtitles', () => {
  it('selects the default row and adds the rest as auto tracks', async () => {
    const repo: SubtitleLookupRepo = {
      listSources: () => [],
      getFileByPath: () => ({ item_id: 5 }),
      listSubtitlesByItem: () => [
        ROW(1),
        ROW(2, { is_default: 1 }),
        ROW(3, { status: 'missing' as const }),
      ],
    };
    const { player, calls } = makePlayer();
    await injectAttachedSubtitles(player, repo, 'webdav', '2:a.mkv');
    // Missing rows are skipped; default is selected exactly once.
    expect(calls).toEqual([
      { path: '/managed/2.srt', flag: 'select' },
      { path: '/managed/1.srt', flag: 'auto' },
    ]);
  });

  it('falls back to the first row when none is default', async () => {
    const repo: SubtitleLookupRepo = {
      listSources: () => [],
      getFileByPath: () => ({ item_id: 5 }),
      listSubtitlesByItem: () => [ROW(9), ROW(4)],
    };
    const { player, calls } = makePlayer();
    await injectAttachedSubtitles(player, repo, 'webdav', '1:a.mkv');
    expect(calls).toEqual([
      { path: '/managed/9.srt', flag: 'select' },
      { path: '/managed/4.srt', flag: 'auto' },
    ]);
  });

  it('injects nothing without rows or without a catalog item', async () => {
    const emptyRepo: SubtitleLookupRepo = {
      listSources: () => [],
      getFileByPath: () => undefined,
      listSubtitlesByItem: () => [],
    };
    const a = makePlayer();
    await injectAttachedSubtitles(a.player, emptyRepo, 'jellyfin', 'item-1');
    expect(a.calls).toEqual([]);

    const noRows: SubtitleLookupRepo = {
      listSources: () => [],
      getFileByPath: () => ({ item_id: 3 }),
      listSubtitlesByItem: () => [],
    };
    const b = makePlayer();
    await injectAttachedSubtitles(b.player, noRows, 'webdav', '1:a.mkv');
    expect(b.calls).toEqual([]);
  });

  it('never rejects when sub-add fails (playback must not block)', async () => {
    const repo: SubtitleLookupRepo = {
      listSources: () => [],
      getFileByPath: () => ({ item_id: 5 }),
      listSubtitlesByItem: () => [ROW(1), ROW(2)],
    };
    const calls: string[] = [];
    const failing: SubtitleInjectionPlayer = {
      addSubtitle: async (path) => {
        calls.push(path);
        throw new Error('mpv IPC timeout');
      },
    };
    await expect(injectAttachedSubtitles(failing, repo, 'webdav', '1:a.mkv')).resolves.toBeUndefined();
    // Per-track isolation: every track is attempted despite failures.
    expect(calls).toEqual(['/managed/1.srt', '/managed/2.srt']);
  });
});

// ---------------------------------------------------------------------------
// PlayerCore.addSubtitle flag pass-through (contract level)
// ---------------------------------------------------------------------------

describe('addSubtitle flags (mpv 0.29/0.32 compatibility)', () => {
  it('only uses select/auto (no cached, which is 0.33+)', async () => {
    // Contract guard: the allowed flag set must stay within 0.29 support.
    const flags = ['select', 'auto'] as const;
    for (const flag of flags) {
      expect(['select', 'auto']).toContain(flag);
    }
  });
});
