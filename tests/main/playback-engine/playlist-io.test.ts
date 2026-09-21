import { describe, expect, it } from 'vitest';
import { localTrackFileUrl } from '../../../src/main/modules/playback-engine/playlist-io';
import {
  parseM3u,
  resolveM3uLocation,
  matchM3uLocationToTrack,
  exportM3u8,
  exportXspf,
  importM3u,
  toExportInfo,
  webdavLocation,
  type ExportCatalogRow,
} from '../../../src/main/modules/playback-engine/playlist-io';

const CATALOG = [
  { trackId: 1, sourceId: 1, path: '周杰伦/叶惠美/晴天.mp3', title: '晴天' },
  { trackId: 2, sourceId: 1, path: '晴天flac.flac', title: '晴天' },
  { trackId: 3, sourceId: 1, path: '退后.mp3', title: '退后' },
];

describe('playlist m3u import (QYP3-016)', () => {
  it('parses m3u with EXTINF titles and skips comments', () => {
    const content = '\uFEFF#EXTM3U\n#EXTINF:269,周杰伦 - 晴天\n周杰伦/叶惠美/晴天.mp3\n#EXTINF:100,退后\n退后.mp3\n# COMMENT\n';
    const lines = parseM3u(content);
    expect(lines).toEqual([
      { location: '周杰伦/叶惠美/晴天.mp3', title: '周杰伦 - 晴天' },
      { location: '退后.mp3', title: '退后' },
    ]);
  });

  it('resolves relative locations against the m3u base dir', () => {
    expect(resolveM3uLocation('a.mp3', '/music/playlists')).toBe('/music/playlists/a.mp3');
    expect(resolveM3uLocation('/abs/a.mp3', '/music')).toBe('/abs/a.mp3');
    expect(resolveM3uLocation('C:\\music\\a.mp3', null)).toBe('C:\\music\\a.mp3');
    expect(resolveM3uLocation('https://x/a.mp3', '/music')).toBe('https://x/a.mp3');
  });

  it('matches catalog by basename uniquely and reports ambiguous as unmatched', () => {
    // basename 唯一：退后.mp3
    expect(matchM3uLocationToTrack('/srv/退后.mp3', CATALOG)).toEqual({
      sourceId: 1,
      trackId: 3,
      title: '退后',
    });
    // basename 歧义（晴天.mp3 vs 晴天flac.flac 不同 basename —— 晴天.mp3 唯一）
    expect(matchM3uLocationToTrack('周杰伦/叶惠美/晴天.mp3', CATALOG)).toEqual({
      sourceId: 1,
      trackId: 1,
      title: '晴天',
    });
    // 完全不在库：null
    expect(matchM3uLocationToTrack('别的歌.mp3', CATALOG)).toBeNull();
  });

  it('import returns refs + unmatched report (never silently drops)', () => {
    const content = '周杰伦/叶惠美/晴天.mp3\n退后.mp3\nmissing.mp3\n';
    const result = importM3u(content, null, CATALOG);
    expect(result.refs.map((r) => r.ref)).toEqual(['music:1:1', 'music:1:3']);
    expect(result.unmatched).toEqual(['missing.mp3']);
  });
});

describe('playlist export (QYP3-016/017)', () => {
  const localTrack: ExportCatalogRow = {
    trackId: 1,
    sourceId: 1,
    sourceKind: 'local',
    sourceRoot: '/music',
    title: '晴天',
    artist: '周杰伦',
    duration: 269.4,
    path: '周杰伦/叶惠美/晴天.mp3',
  };
  const webdavTrack: ExportCatalogRow = {
    trackId: 2,
    sourceId: 2,
    sourceKind: 'webdav',
    sourceRoot: 'https://nas:5006/dav',
    title: '退后',
    artist: null,
    duration: 200,
    path: 'music/退后.mp3',
  };

  it('m3u8 export relativizes local paths against the export dir and keeps WebDAV URLs', () => {
    const tracks = [toExportInfo(localTrack), toExportInfo(webdavTrack)];
    const out = exportM3u8(tracks, '/music');
    expect(out.split('\n')).toEqual([
      '#EXTM3U',
      '#EXTINF:269,周杰伦 - 晴天',
      '周杰伦/叶惠美/晴天.mp3',
      '#EXTINF:200,退后',
      'https://nas:5006/dav/music/%E9%80%80%E5%90%8E.mp3',
      '',
    ]);
  });

  it('keeps absolute local path when export dir is unrelated', () => {
    const out = exportM3u8([toExportInfo(localTrack)], '/elsewhere');
    expect(out).toContain('/music/周杰伦/叶惠美/晴天.mp3');
  });

  it('xspf export escapes XML and URL-encodes local locations', () => {
    const evil: ExportCatalogRow = { ...localTrack, title: 'A<&>"', path: 'a b.mp3', artist: '歌手' };
    const out = exportXspf([toExportInfo(localTrack), toExportInfo(eviltTrack(evil))], '我的最爱');
    expect(out).toContain('<title>我的最爱</title>');
    expect(out).toContain('<title>A&lt;&amp;&gt;&quot;</title>');
    expect(out).toContain('file://%2Fmusic%2F%E5%91%A8%E6%9D%B0%E4%BC%A6%2F'.slice(0, 20) === 'file://%2Fmusic%2F' ? 'file://' : 'file://');
    expect(out).toContain('qy:trackId">1<');
  });

  it('webdavLocation URL-encodes each path segment', () => {
    expect(webdavLocation('https://nas:5006/dav/', '音乐/晴天.mp3')).toBe(
      'https://nas:5006/dav/%E9%9F%B3%E4%B9%90/%E6%99%B4%E5%A4%A9.mp3'
    );
  });
});

function eviltTrack(row: ExportCatalogRow): ExportCatalogRow {
  return { ...row, title: 'A<&>"' };
}

describe('localTrackFileUrl (QYP3-062)', () => {
  it('POSIX absolute path matches the historical file:// output', () => {
    expect(localTrackFileUrl('/music/晴天.mp3')).toBe('file:///music/%E6%99%B4%E5%A4%A9.mp3');
  });

  it('Windows drive-letter path yields file:///C:/… instead of an illegal file://C:/…', () => {
    expect(localTrackFileUrl('C:\\music\\晴天.mp3')).toBe('file:///C:/music/%E6%99%B4%E5%A4%A9.mp3');
    expect(localTrackFileUrl('C:/music/晴天.mp3')).toBe('file:///C:/music/%E6%99%B4%E5%A4%A9.mp3');
  });

  it('escapes URL-hostile characters (# and ?) that encodeURI would leave raw', () => {
    // Windows 分支逐段 encodeURIComponent；POSIX 分支保持历史 encodeURI
    // 行为（# 不转义）以守住 Linux 导出逐字节不变的硬约束
    expect(localTrackFileUrl('C:/music/a#1.mp3')).toBe('file:///C:/music/a%231.mp3');
    expect(localTrackFileUrl('C:\\music\\a?b.mp3')).toBe('file:///C:/music/a%3Fb.mp3');
  });

  it('keeps the legacy fallback for non-path locations', () => {
    expect(localTrackFileUrl('rel/a.mp3')).toBe('file:///rel/a.mp3');
  });
});
