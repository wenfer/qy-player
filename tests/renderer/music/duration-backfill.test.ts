// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  attachMusicMpvBridge,
  useMusicPlaybackStore,
  type MusicTrackInput,
} from '../../../src/renderer/stores/music-playback-store';

/**
 * 播放期时长回填（QYP3-052）：扫描期解析不出时长的曲目（VBR 无 Xing、ID3 标签
 * 超出读取窗口、WebDAV 源）在列表里一直是空白，播放器知道真实值 —— 每个曲目
 * 报一次、失败静默。
 *
 * 注意：哨兵（已报告过的 trackId）是模块级的，用例之间**必须用不同的 trackId**。
 */

let stateListener: ((state: unknown) => void) | null = null;

const api = {
  onPlayerStateChange: vi.fn((cb: (state: unknown) => void) => {
    stateListener = cb;
    return () => undefined;
  }),
  onMusicSessionEnd: vi.fn(() => () => undefined),
  onMusicSpectrumReady: vi.fn(() => () => undefined),
  getMusicSpectrum: vi.fn((): Promise<{ ok: boolean; data: unknown }> =>
    Promise.resolve({ ok: true, data: { status: 'none' } })
  ),
  setMusicEngineActive: vi.fn(() => Promise.resolve({ ok: true })),
  pushDeskLyricsState: vi.fn(() => Promise.resolve({ ok: true })),
  playerControl: vi.fn(() => Promise.resolve({ ok: true })),
  playerLoadFile: vi.fn(() => Promise.resolve()),
  getSettings: vi.fn(() => Promise.resolve({ ok: true, data: null })),
  getMusicLyrics: vi.fn(() => Promise.resolve({ ok: true, data: { hasLyrics: false, content: null } })),
  setMusicTrackDuration: vi.fn(() => Promise.resolve({ ok: true })),
};

vi.stubGlobal('electronAPI', api);

/** 把 store 置于"mpv 正在播这首本地曲目"的状态。 */
function primeLocalMpvMusic(trackId: number, storedDuration?: number): void {
  useMusicPlaybackStore.setState({
    engine: 'mpv',
    current: {
      id: trackId,
      title: '晴天',
      artist: '周杰伦',
      album: null,
      albumartist: '周杰伦',
      duration: storedDuration ?? null,
      url: 'qy-file://audio/1/x.mp3',
    },
    currentSource: { trackId },
    position: 0,
    duration: 0,
    isPlaying: true,
    queueSnapshot: [],
    serverQueue: [],
    serverIndex: -1,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  attachMusicMpvBridge();
});

describe('duration backfill (QYP3-052)', () => {
  it('reports the real duration of a local track that has none, exactly once', () => {
    primeLocalMpvMusic(101);
    stateListener!({ music: true, currentTime: 1, duration: 269, isPlaying: true });
    expect(api.setMusicTrackDuration).toHaveBeenCalledTimes(1);
    expect(api.setMusicTrackDuration).toHaveBeenCalledWith(101, 269);

    // mpv 重载/seek 会重发同一个 duration：不能再写一次库
    stateListener!({ music: true, currentTime: 30, duration: 269, isPlaying: true });
    stateListener!({ music: true, currentTime: 60, duration: 269, isPlaying: true });
    expect(api.setMusicTrackDuration).toHaveBeenCalledTimes(1);
  });

  it('skips server tracks (trackId = 0, 不落本地库)', () => {
    const serverTrack: MusicTrackInput = {
      trackId: 0,
      sourceId: 0,
      serverId: 1,
      provider: 'jellyfin',
      itemId: 't1',
      title: '晴天',
      artist: '周杰伦',
      albumartist: '周杰伦',
      duration: 269,
      path: '',
      codec: null,
    };
    useMusicPlaybackStore.setState({
      engine: 'mpv',
      current: {
        id: -1,
        title: '晴天',
        artist: '周杰伦',
        album: null,
        albumartist: '周杰伦',
        duration: null,
        url: 'qy-stream://audio/abc',
      },
      currentSource: { trackId: 0, serverId: 1, itemId: 't1' },
      duration: 0,
      isPlaying: true,
      serverQueue: [serverTrack],
      serverIndex: 0,
    });
    stateListener!({ music: true, currentTime: 1, duration: 269, isPlaying: true });
    expect(api.setMusicTrackDuration).not.toHaveBeenCalled();
  });

  it('does not write when the stored duration is already accurate (差 ≤2s)', () => {
    primeLocalMpvMusic(102, 269);
    stateListener!({ music: true, currentTime: 1, duration: 269.4, isPlaying: true });
    expect(api.setMusicTrackDuration).not.toHaveBeenCalled();
  });

  it('overwrites a stored duration that is clearly wrong (解析出的估算值差得远)', () => {
    primeLocalMpvMusic(103, 84);
    stateListener!({ music: true, currentTime: 1, duration: 252, isPlaying: true });
    expect(api.setMusicTrackDuration).toHaveBeenCalledWith(103, 252);
  });

  it('ignores a zero/unknown duration and stays silent on failure', () => {
    primeLocalMpvMusic(104);
    stateListener!({ music: true, currentTime: 0, duration: 0, isPlaying: true });
    expect(api.setMusicTrackDuration).not.toHaveBeenCalled();

    api.setMusicTrackDuration.mockRejectedValueOnce(new Error('db closed'));
    stateListener!({ music: true, currentTime: 1, duration: 200, isPlaying: true });
    expect(api.setMusicTrackDuration).toHaveBeenCalledTimes(1); // 抛错也不冒泡
  });
});
