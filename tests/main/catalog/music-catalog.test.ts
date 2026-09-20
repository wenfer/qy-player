import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabaseAtPath } from '../../../src/main/modules/storage/db';
import { createCatalogRepository, type CatalogRepository } from '../../../src/main/modules/catalog/repository';
import { createUnifiedQueryService } from '../../../src/main/modules/catalog/unified-query';

/**
 * QYP3-008a：歌手聚合、收藏、统一搜索接入音乐。
 * 收藏标记落在 music_tracks 行上（catalog_user_state 的 item_id 外键指向
 * catalog_items，音乐条目不在该域内）。
 */

let dbDir: string;
let repo: CatalogRepository;
let sourceId: number;

beforeEach(() => {
  dbDir = mkdtempSync(join(tmpdir(), 'qy-music-cat-'));
  const db = openDatabaseAtPath(join(dbDir, 'catalog.db'));
  repo = createCatalogRepository(db);
  sourceId = repo.createSource({ kind: 'local', name: '音乐库', root: '/music' });
  const seed: Array<[string, string, string, number, boolean]> = [
    ['a1', '晴天', '叶惠美', 3, true],
    ['a2', '懦夫', '叶惠美', 4, false],
    ['b1', '七里香', '七里香', 1, true],
  ];
  for (const [key, title, album, trackNo, cover] of seed) {
    repo.upsertMusicTrack({
      sourceId,
      sourceKey: key,
      path: `/music/${key}.mp3`,
      title,
      artist: '周杰伦',
      album,
      albumartist: '周杰伦',
      trackNo,
      year: album === '叶惠美' ? 2003 : 2004,
      duration: 260,
      codec: 'mp3',
      hasCover: cover,
      hasLyrics: false,
      fingerprint: `fp-${key}`,
    });
  }
  // 另一个歌手（验证分组与搜索的歌手维度）
  repo.upsertMusicTrack({
    sourceId,
    sourceKey: 'c1',
    path: '/music/c1.mp3',
    title: '青花瓷',
    artist: '周杰伦',
    album: '我很忙',
    albumartist: '周杰伦',
    trackNo: 2,
    duration: 240,
    codec: 'mp3',
    fingerprint: 'fp-c1',
  });
  repo.upsertMusicTrack({
    sourceId,
    sourceKey: 'd1',
    path: '/music/d1.mp3',
    title: '演员',
    artist: '薛之谦',
    album: '绅士',
    albumartist: '薛之谦',
    trackNo: 1,
    duration: 250,
    codec: 'mp3',
    fingerprint: 'fp-d1',
  });
});

afterEach(() => {
  rmSync(dbDir, { recursive: true, force: true });
});

describe('music catalog queries (QYP3-008a)', () => {
  it('aggregates artists with album/track counts and a cover track', () => {
    const artists = repo.listMusicArtists([sourceId]);
    expect(artists).toHaveLength(2);
    const jay = artists.find((a) => a.albumartist === '周杰伦')!;
    expect(jay.album_count).toBe(3);
    expect(jay.track_count).toBe(4);
    expect(jay.cover_track_id).not.toBeNull();
    const xue = artists.find((a) => a.albumartist === '薛之谦')!;
    expect(xue.album_count).toBe(1);
    expect(xue.cover_track_id).toBeNull();
  });

  it('lists albums of one artist only', () => {
    const albums = repo.listArtistAlbums([sourceId], '周杰伦');
    expect(albums.map((a) => a.album)).toEqual(['七里香', '叶惠美', '我很忙']);
    expect(repo.listArtistAlbums([sourceId], '不存在')).toEqual([]);
  });

  it('toggles favorites and lists only favorited tracks', () => {
    expect(repo.listFavoriteMusicTracks([sourceId])).toEqual([]);
    const all = repo.listMusicTracksPaged([sourceId], 0, 200);
    const target = all.find((t) => t.title === '晴天')!;
    expect(target.favorite).toBe(0);
    expect(repo.setMusicFavorite(target.id, true)).toBe(true);
    const favorites = repo.listFavoriteMusicTracks([sourceId]);
    expect(favorites.map((t) => t.title)).toEqual(['晴天']);
    expect(favorites[0].favorite).toBe(1);
    // 关掉后从收藏列表消失
    repo.setMusicFavorite(target.id, false);
    expect(repo.listFavoriteMusicTracks([sourceId])).toEqual([]);
  });

  it('backfills a track duration (QYP3-052)', () => {
    const target = repo.listMusicTracksPaged([sourceId], 0, 200).find((t) => t.title === '晴天')!;
    repo.setMusicTrackDuration(target.id, 269.5);
    expect(repo.listMusicTracksPaged([sourceId], 0, 200).find((t) => t.id === target.id)?.duration).toBe(269.5);
    // 播放期给的是真实值，旧的估算值直接被覆盖
    repo.setMusicTrackDuration(target.id, 271);
    expect(repo.listMusicTracksPaged([sourceId], 0, 200).find((t) => t.id === target.id)?.duration).toBe(271);
    // 顺带覆盖扫描器用来判断"要不要补时长"的投影
    const index = repo.listMusicTracks(sourceId).find((r) => r.source_key === 'a1');
    expect(index?.duration).toBe(271);
  });

  it('searches music by title, artist and album', () => {
    expect(repo.searchMusicTracks([sourceId], '晴天').map((t) => t.title)).toEqual(['晴天']);
    expect(repo.searchMusicTracks([sourceId], '薛之谦').map((t) => t.title)).toEqual(['演员']);
    expect(repo.searchMusicTracks([sourceId], '叶惠美')).toHaveLength(2);
    // % 与 _ 是字面量（不是通配符）
    expect(repo.searchMusicTracks([sourceId], '%')).toEqual([]);
    expect(repo.searchMusicTracks([sourceId], '   ')).toEqual([]);
  });

  it('includes music cards in the unified search (provider=music)', async () => {
    const db = openDatabaseAtPath(join(dbDir, 'catalog.db'));
    const unified = createUnifiedQueryService({
      db,
      onlineContinueWatching: async () => [],
      onlineSearch: async () => [],
      onlineRecent: async () => [],
    });
    const { items } = await unified.search('晴天', 1);
    const music = items.find((c) => c.ref.provider === 'music');
    expect(music).toBeTruthy();
    expect(music!.title).toBe('晴天');
    expect(music!.kind).toBe('audio');
    // 歌手名也能搜到（且不与其他来源互相去重）
    const byArtist = await unified.search('薛之谦', 1);
    expect(byArtist.items.some((c) => c.ref.provider === 'music' && c.title === '演员')).toBe(true);
  });
});
