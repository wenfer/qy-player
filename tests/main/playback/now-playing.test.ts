import { describe, expect, it } from 'vitest';
import {
  NOW_PLAYING_KEY,
  clearNowPlaying,
  parseNowPlaying,
  readNowPlaying,
  serializeNowPlaying,
  writeNowPlaying,
  type ConfigStore,
  type NowPlayingRecord,
} from '../../../src/main/modules/playback-state/now-playing';

/**
 * QYP3-053：「当前播放的音乐」单条状态的解析与落盘。
 *
 * 这是启动恢复的唯一数据源，而启动路径上没有重试机会——所以规则的要点是
 * **坏数据一律当作"没有记录"**（宁可空手启动，也不要拿半条数据去喂播放器）。
 */

function memStore(): ConfigStore & { raw: Map<string, string> } {
  const raw = new Map<string, string>();
  return {
    raw,
    getConfig: (key) => raw.get(key),
    setConfig: (key, value) => {
      raw.set(key, value);
    },
  };
}

const trackRecord: NowPlayingRecord = {
  type: 'track',
  sourceId: 5,
  trackId: 12,
  title: '云上歌',
  artist: '歌手',
  albumartist: '歌手',
  duration: 200,
  position: 42.5,
  updatedAt: 1_700_000_000_000,
};

describe('now-playing record (QYP3-053)', () => {
  it('round-trips a local track through serialize/parse', () => {
    expect(parseNowPlaying(serializeNowPlaying(trackRecord))).toEqual(trackRecord);
  });

  it('round-trips a server entry and defaults the provider to jellyfin', () => {
    const record: NowPlayingRecord = {
      type: 'server',
      serverId: 7,
      provider: 'jellyfin',
      itemId: 'item-1',
      title: '云端曲',
      artist: null,
      albumartist: null,
      duration: null,
      position: 10,
      updatedAt: 1,
    };
    expect(parseNowPlaying(JSON.stringify({ ...record, provider: undefined }))).toEqual(record);
    expect(parseNowPlaying(serializeNowPlaying({ ...record, provider: 'emby' }))?.provider).toBe('emby');
  });

  it('rejects broken JSON, unknown types and empty payloads', () => {
    expect(parseNowPlaying('{not json')).toBeNull();
    expect(parseNowPlaying('')).toBeNull();
    expect(parseNowPlaying(undefined)).toBeNull();
    expect(parseNowPlaying('null')).toBeNull();
    expect(parseNowPlaying(JSON.stringify({ ...trackRecord, type: 'unknown' }))).toBeNull();
  });

  it('rejects a missing title or a negative/non-finite position', () => {
    const { title: _title, ...noTitle } = trackRecord;
    expect(parseNowPlaying(JSON.stringify(noTitle))).toBeNull();
    expect(parseNowPlaying(JSON.stringify({ ...trackRecord, title: '' }))).toBeNull();
    expect(parseNowPlaying(JSON.stringify({ ...trackRecord, position: -1 }))).toBeNull();
    expect(parseNowPlaying(JSON.stringify({ ...trackRecord, position: Number.NaN }))).toBeNull();
    expect(parseNowPlaying(JSON.stringify({ ...trackRecord, position: '42' }))).toBeNull();
  });

  it('requires the locating keys of the declared type', () => {
    expect(parseNowPlaying(JSON.stringify({ ...trackRecord, trackId: undefined }))).toBeNull();
    expect(parseNowPlaying(JSON.stringify({ ...trackRecord, sourceId: 0 }))).toBeNull();
    const server = { type: 'server', serverId: 7, itemId: 'i', title: 't', position: 1, updatedAt: 1 };
    expect(parseNowPlaying(JSON.stringify(server))).not.toBeNull();
    expect(parseNowPlaying(JSON.stringify({ ...server, itemId: undefined }))).toBeNull();
    expect(parseNowPlaying(JSON.stringify({ ...server, serverId: -3 }))).toBeNull();
  });

  it('normalizes a bogus duration to null and defaults updatedAt', () => {
    const parsed = parseNowPlaying(
      JSON.stringify({ ...trackRecord, duration: 0, updatedAt: undefined })
    );
    expect(parsed?.duration).toBeNull();
    expect(typeof parsed?.updatedAt).toBe('number');
  });

  it('read/write/clear go through the config store', () => {
    const store = memStore();
    expect(readNowPlaying(store)).toBeNull();
    writeNowPlaying(store, trackRecord);
    expect(store.raw.get(NOW_PLAYING_KEY)).toBe(serializeNowPlaying(trackRecord));
    expect(readNowPlaying(store)).toEqual(trackRecord);
    clearNowPlaying(store);
    expect(readNowPlaying(store)).toBeNull();
  });

  it('a failing config store never throws (落盘失败只影响下次启动的观感)', () => {
    const broken: ConfigStore = {
      getConfig: () => {
        throw new Error('db not ready');
      },
      setConfig: () => {
        throw new Error('db not ready');
      },
    };
    expect(readNowPlaying(broken)).toBeNull();
    expect(() => writeNowPlaying(broken, trackRecord)).not.toThrow();
    expect(() => clearNowPlaying(broken)).not.toThrow();
  });
});
