// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 播放期时长回填的另一条路径（QYP3-052）：内置引擎（webaudio）的
 * `onTime(position, duration)` 也要把真实时长报一次。
 *
 * mpv 那条路径见 `duration-backfill.test.ts`；两处都要覆盖——这是两个独立的
 * 调用点，漏一个就是"外放能补上、内置引擎补不上"的静默不一致。
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
    setAudioFx = vi.fn();
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

import {
  useMusicPlaybackStore,
  type MusicTrackInput,
} from '../../../src/renderer/stores/music-playback-store';

const api = {
  resolvePlayback: vi.fn(),
  playerLoadFile: vi.fn(() => Promise.resolve()),
  playerControl: vi.fn(() => Promise.resolve({ ok: true })),
  setMusicEngineActive: vi.fn(() => Promise.resolve({ ok: true })),
  getSettings: vi.fn(() => Promise.resolve({ ok: true, data: null })),
  getMusicLyrics: vi.fn(() => Promise.resolve({ ok: true, data: { hasLyrics: false, content: null } })),
  pushDeskLyricsState: vi.fn(() => Promise.resolve({ ok: true })),
  reportMusicProgress: vi.fn(() => Promise.resolve({ ok: true })),
  setMusicTrackDuration: vi.fn((..._args: unknown[]) => Promise.resolve({ ok: true })),
};

vi.stubGlobal('electronAPI', api);

/** 本地音轨：时长未知（扫描期没解析出来）。 */
const localTrack = (trackId: number): MusicTrackInput => ({
  trackId,
  sourceId: 1,
  title: '晴天',
  artist: '周杰伦',
  albumartist: '周杰伦',
  duration: null,
  path: '周杰伦/叶惠美/03 - 晴天.mp3',
  codec: 'mp3',
});

const flushMicrotasks = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.clearAllMocks();
  api.resolvePlayback.mockResolvedValue({
    ok: true,
    data: {
      kind: 'music-direct',
      url: 'qy-file://audio/1/x.mp3',
      startPosition: 0,
      engine: { engine: 'webaudio', reason: 'direct-codec' },
      mediaContext: { mediaType: 'local', mediaId: '201' },
    },
  });
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

describe('duration backfill via the built-in engine (QYP3-052)', () => {
  it('reports the real duration once when the built-in engine knows it', async () => {
    await useMusicPlaybackStore.getState().playQueue([localTrack(201)], 0);
    await flushMicrotasks();
    expect(useMusicPlaybackStore.getState().currentSource?.trackId).toBe(201);

    (h.engine.instance.onTime as (p: number, d: number) => void)(3, 269);
    await flushMicrotasks();
    expect(api.setMusicTrackDuration).toHaveBeenCalledTimes(1);
    expect(api.setMusicTrackDuration).toHaveBeenCalledWith(201, 269);

    // 后续每秒的 onTime 不该重复写库
    (h.engine.instance.onTime as (p: number, d: number) => void)(4, 269);
    await flushMicrotasks();
    expect(api.setMusicTrackDuration).toHaveBeenCalledTimes(1);
  });
});
