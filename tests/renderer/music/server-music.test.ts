// 服务器音乐映射层（QYP3-025）：纯函数，无 IPC。
import { describe, expect, it } from 'vitest';
import {
  isAudioItem,
  mapServerAlbums,
  mapServerPlaylists,
  mapServerTracks,
  pickMusicLibraries,
  type ServerLibraryGroup,
} from '../../../src/renderer/utils/server-music';

const group = (over: Partial<ServerLibraryGroup> = {}): ServerLibraryGroup => ({
  serverId: 1,
  serverName: '家里',
  serverType: 'jellyfin',
  views: [],
  ...over,
});

describe('pickMusicLibraries (QYP3-025)', () => {
  it('keeps only music views and normalizes Id/id + Name', () => {
    const libs = pickMusicLibraries([
      group({
        views: [
          { Id: 'v1', Name: '音乐', CollectionType: 'music' },
          { Id: 'v2', Name: '电影', CollectionType: 'movies' },
          { id: 'v3', CollectionType: 'Music' },
        ],
      }),
    ]);
    expect(libs).toEqual([
      { serverId: 1, serverName: '家里', serverType: 'jellyfin', viewId: 'v1', viewName: '音乐' },
      { serverId: 1, serverName: '家里', serverType: 'jellyfin', viewId: 'v3', viewName: '音乐库' },
    ]);
  });

  it('skips servers that failed to load and views without an id', () => {
    const libs = pickMusicLibraries([
      group({ error: '连接超时', views: [{ Id: 'v1', CollectionType: 'music' }] }),
      group({ serverId: 2, views: [{ CollectionType: 'music' }, { Id: 'v9', CollectionType: 'music' }] }),
    ]);
    expect(libs.map((l) => l.viewId)).toEqual(['v9']);
  });

  it('tolerates a missing views array', () => {
    expect(pickMusicLibraries([{ serverId: 1, serverName: 'a', serverType: 'emby' }])).toEqual([]);
  });
});

describe('mapServerAlbums (QYP3-025)', () => {
  it('maps Jellyfin fields and falls back to Artists[0]', () => {
    const albums = mapServerAlbums([
      {
        Id: 'a1',
        Name: '叶惠美',
        AlbumArtist: '周杰伦',
        ProductionYear: 2003,
        ImageTags: { Primary: 'tag1' },
      },
      { Id: 'a2', Name: '七里香', Artists: ['周杰伦'], ImageTags: {} },
    ]);
    expect(albums).toEqual([
      { id: 'a1', name: '叶惠美', artist: '周杰伦', year: 2003, tag: 'tag1' },
      { id: 'a2', name: '七里香', artist: '周杰伦', year: null, tag: null },
    ]);
  });

  it('drops entries without an Id and degrades missing names', () => {
    const albums = mapServerAlbums([{ Name: '无 id' }, { Id: 'a3' }]);
    expect(albums).toEqual([{ id: 'a3', name: '未知专辑', artist: null, year: null, tag: null }]);
  });
});

describe('mapServerTracks (QYP3-025)', () => {
  it('converts RunTimeTicks to seconds and keeps the track index', () => {
    const tracks = mapServerTracks([
      { Id: 't1', Name: '晴天', AlbumArtist: '周杰伦', Album: '叶惠美', RunTimeTicks: 26_900_000_000, IndexNumber: 3 },
    ]);
    expect(tracks).toEqual([
      { id: 't1', name: '晴天', artist: '周杰伦', album: '叶惠美', duration: 2690, index: 3 },
    ]);
  });

  it('returns null duration/index when the server omits them', () => {
    expect(mapServerTracks([{ Id: 't2', Name: 'x' }])[0]).toEqual({
      id: 't2',
      name: 'x',
      artist: null,
      album: null,
      duration: null,
      index: null,
    });
  });
});

describe('mapServerPlaylists (P2)', () => {
  it('maps name/item count/image tag and drops entries without an id', () => {
    expect(
      mapServerPlaylists([
        { Id: 'p1', Name: '通勤', ChildCount: 12, ImageTags: { Primary: 'tg' } },
        { Name: '无 id' },
        { Id: 'p2', Name: '深夜' },
      ])
    ).toEqual([
      { id: 'p1', name: '通勤', itemCount: 12, tag: 'tg' },
      { id: 'p2', name: '深夜', itemCount: null, tag: null },
    ]);
  });

  it('degrades a missing name instead of throwing', () => {
    expect(mapServerPlaylists([{ Id: 'p3' }])[0].name).toBe('未命名歌单');
  });
});

describe('isAudioItem (P2)', () => {
  it('keeps audio entries and drops video/other containers', () => {
    expect(isAudioItem({ Type: 'Audio' })).toBe(true);
    // 服务器未给 Type（部分歌单条目）时按可播处理，交给解析层判断
    expect(isAudioItem({ Id: 'x' })).toBe(true);
    expect(isAudioItem({ Type: 'Movie' })).toBe(false);
    expect(isAudioItem({ Type: 'Episode' })).toBe(false);
  });
});
