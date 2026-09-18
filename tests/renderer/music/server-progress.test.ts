// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 内置引擎服务器音乐进度/续播对齐（QYP3-038）。
 *
 * webaudio 播放不经 PLAYER.LOAD_FILE，Sessions/Playing 系列与服务器续播
 * 位置会整体丢失。修复后：服务器曲目起播先 START_SERVER_SESSION 拿
 * playSessionId，节流进度带同一 id 回传；本地/WebDAV 仍走 REPORT_PROGRESS
 * （WebDAV 带 mediaType:'webdav' 落对续播键）；stop() 收尾走 Stopped。
 */

const h = vi.hoisted(() => ({
  engine: { instance: null as unknown as Record<string, unknown> },
}));

vi.mock('../../../src/renderer/player/web-audio-engine', () => {
  class WebAudioEngine {
    queueState = { length: 0, index: 0, currentTrackId: null, repeat: 'off', shuffle: false };
    onError?: unknown;
    onResolveError?: unknown;
    onTime?: unknown;
    onEnded?: unknown;
    onPlaying?: unknown;
    setEq = vi.fn();
    setVolume = vi.fn();
    playQueue = vi.fn(async () => undefined);
    next = vi.fn(async () => undefined);
    prev = vi.fn(async () => undefined);
    pause = vi.fn();
    resume = vi.fn();
    seek = vi.fn();
    jumpTo = vi.fn(async () => undefined);
    getSpectrum = vi.fn(() => null);
    getWaveform = vi.fn(() => null);
    recoverFlac = vi.fn(async () => false);
    constructor() {
      h.engine.instance = this as unknown as Record<string, unknown>;
    }
  }
  return { WebAudioEngine };
});

import { useMusicPlaybackStore, type MusicTrackInput } from '../../../src/renderer/stores/music-playback-store';

const api = {
  resolvePlayback: vi.fn(),
  playerLoadFile: vi.fn((..._args: unknown[]) => Promise.resolve()),
  playerControl: vi.fn(() => Promise.resolve({ ok: true })),
  setMusicEngineActive: vi.fn(() => Promise.resolve({ ok: true })),
  getSettings: vi.fn(() => Promise.resolve({ ok: true, data: null })),
  getMusicLyrics: vi.fn(() => Promise.resolve({ ok: true, data: { hasLyrics: false, content: null } })),
  getServerLyrics: vi.fn(() => Promise.resolve({ ok: true, data: { hasLyrics: false, content: null } })),
  pushDeskLyricsState: vi.fn(() => Promise.resolve({ ok: true })),
  startMusicServerSession: vi.fn(() => Promise.resolve({ ok: true, data: { playSessionId: 'ps-1' } })),
  // 参数签名要显式声明，否则 mock.calls 的元组是 []（取不到第 1 参）
  reportMusicServerProgress: vi.fn((..._args: unknown[]) => Promise.resolve({ ok: true })),
  reportMusicProgress: vi.fn((..._args: unknown[]) => Promise.resolve({ ok: true })),
};

vi.stubGlobal('electronAPI', api);

const serverTrack = (itemId: string, title: string): MusicTrackInput => ({
  trackId: 0,
  sourceId: 0,
  serverId: 7,
  provider: 'jellyfin',
  itemId,
  title,
  artist: null,
  albumartist: null,
  duration: 200,
  path: '',
  codec: 'mp3',
});

const localTrack = (trackId: number, path: string): MusicTrackInput => ({
  trackId,
  sourceId: 5,
  title: `曲${trackId}`,
  artist: null,
  albumartist: null,
  duration: 200,
  path,
  codec: 'mp3',
});

/** 微任务冲刷：让 startMusicServerSession 的 .then 落定 playSessionId。 */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  vi.clearAllMocks();
  useMusicPlaybackStore.setState({
    engine: null,
    current: null,
    currentSource: null,
    position: 0,
    duration: 0,
    isPlaying: false,
    queueLength: 0,
    queueIndex: 0,
    errorMessage: null,
    queueSnapshot: [],
    serverQueue: [],
    serverIndex: -1,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('server music progress parity (QYP3-038)', () => {
  it('starts a server session and reports progress with the playSessionId', async () => {
    api.resolvePlayback.mockResolvedValue({
      ok: true,
      data: {
        kind: 'music-direct',
        url: 'qy-stream://audio/sess-1',
        startPosition: 0,
        engine: { engine: 'webaudio', reason: 'direct-codec' },
        mediaContext: { mediaType: 'jellyfin', mediaId: 'item-1', mediaSourceId: 'ms-1' },
      },
    });

    await useMusicPlaybackStore.getState().playQueue([serverTrack('item-1', '云歌')], 0);
    await flushMicrotasks();

    expect(api.startMusicServerSession).toHaveBeenCalledWith({
      serverId: 7,
      provider: 'jellyfin',
      itemId: 'item-1',
      mediaSourceId: 'ms-1',
      title: '云歌',
    });

    // 节流窗口（10s）过后，onTime 驱动的上报必须带上同一 playSessionId
    vi.setSystemTime(1_000_000 + 10_001);
    (h.engine.instance.onTime as (p: number, d: number) => void)(30, 200);
    await flushMicrotasks();
    expect(api.reportMusicServerProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        serverId: 7,
        provider: 'jellyfin',
        itemId: 'item-1',
        position: 30,
        duration: 200,
        playSessionId: 'ps-1',
      })
    );
    const firstCall = api.reportMusicServerProgress.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(firstCall[0].isStopped).toBeUndefined();
  });

  it('local tracks never open a server session and keep the local report path', async () => {
    api.resolvePlayback.mockResolvedValue({
      ok: true,
      data: {
        kind: 'music-direct',
        url: 'qy-file://audio/5/a.mp3',
        startPosition: 0,
        engine: { engine: 'webaudio', reason: 'direct-codec' },
        mediaContext: { mediaType: 'local', mediaId: '/music/a.mp3' },
      },
    });

    await useMusicPlaybackStore.getState().playQueue([localTrack(1, '/music/a.mp3')], 0);
    await flushMicrotasks();

    expect(api.startMusicServerSession).not.toHaveBeenCalled();
    vi.setSystemTime(1_000_000 + 10_001);
    (h.engine.instance.onTime as (p: number, d: number) => void)(15, 200);
    await flushMicrotasks();
    expect(api.reportMusicProgress).toHaveBeenCalledWith(
      expect.objectContaining({ mediaId: '/music/a.mp3', mediaType: 'local' })
    );
    expect(api.reportMusicServerProgress).not.toHaveBeenCalled();
  });

  it('webdav tracks report through the webdav progress key', async () => {
    api.resolvePlayback.mockResolvedValue({
      ok: true,
      data: {
        kind: 'music-direct',
        url: 'qy-stream://audio/sess-2',
        startPosition: 0,
        engine: { engine: 'webaudio', reason: 'direct-codec' },
        mediaContext: { mediaType: 'webdav', mediaId: '3:Music/a.flac' },
      },
    });

    await useMusicPlaybackStore.getState().playQueue([localTrack(2, 'Music/a.flac')], 0);
    await flushMicrotasks();

    expect(api.startMusicServerSession).not.toHaveBeenCalled();
    vi.setSystemTime(1_000_000 + 10_001);
    (h.engine.instance.onTime as (p: number, d: number) => void)(12, 200);
    await flushMicrotasks();
    expect(api.reportMusicProgress).toHaveBeenCalledWith(
      expect.objectContaining({ mediaId: '3:Music/a.flac', mediaType: 'webdav' })
    );
  });

  it('stop() flushes a final Stopped for the server track', async () => {
    api.resolvePlayback.mockResolvedValue({
      ok: true,
      data: {
        kind: 'music-direct',
        url: 'qy-stream://audio/sess-1',
        startPosition: 0,
        engine: { engine: 'webaudio', reason: 'direct-codec' },
        mediaContext: { mediaType: 'jellyfin', mediaId: 'item-1', mediaSourceId: 'ms-1' },
      },
    });

    await useMusicPlaybackStore.getState().playQueue([serverTrack('item-1', '云歌')], 0);
    await flushMicrotasks();
    vi.setSystemTime(1_000_000 + 10_001);
    (h.engine.instance.onTime as (p: number, d: number) => void)(50, 200);
    await flushMicrotasks();

    useMusicPlaybackStore.getState().stop();
    await flushMicrotasks();

    const lastCall = api.reportMusicServerProgress.mock.calls.at(-1) as unknown as [Record<string, unknown>] | undefined;
    const stopped = (lastCall?.[0] ?? {}) as Record<string, unknown>;
    expect(stopped.isStopped).toBe(true);
    expect(stopped.playSessionId).toBe('ps-1');
    expect(useMusicPlaybackStore.getState().engine).toBeNull();
  });
});
