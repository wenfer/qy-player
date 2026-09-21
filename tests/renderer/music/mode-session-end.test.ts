// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 回到影视模式即结束音乐会话（QYP3-068p）。
 *
 * 此前迷你条跨模式保留（由音乐会话门禁），影视界面上会一直挂着一条音乐条。
 * 现在 `endSession()` 要把三样东西一起收掉：正在播的引擎（mpv 必须显式
 * stop，否则歌声还在后台响）、`restored` 待播态、以及落盘的「当前播放的
 * 音乐」记录——漏了最后一样，下次启动播放条又回来了。
 */

const h = vi.hoisted(() => ({
  engine: { instance: null as unknown as Record<string, unknown> },
}));

vi.mock('../../../src/renderer/player/web-audio-engine', () => {
  class WebAudioEngine {
    queueState = { length: 0, index: 0, currentTrackId: null as number | null, repeat: 'off', shuffle: false };
    onError?: unknown;
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
  playerLoadFile: vi.fn((..._args: unknown[]) => Promise.resolve()),
  playerControl: vi.fn(() => Promise.resolve({ ok: true })),
  setMusicEngineActive: vi.fn(() => Promise.resolve({ ok: true })),
  setNowPlaying: vi.fn(() => Promise.resolve({ ok: true })),
  clearNowPlaying: vi.fn(() => Promise.resolve({ ok: true })),
  getSettings: vi.fn(() => Promise.resolve({ ok: true, data: null })),
  getMusicLyrics: vi.fn(() => Promise.resolve({ ok: true, data: { hasLyrics: false, content: null } })),
  getServerLyrics: vi.fn(() => Promise.resolve({ ok: true, data: { hasLyrics: false, content: null } })),
  pushDeskLyricsState: vi.fn(() => Promise.resolve({ ok: true })),
  reportMusicServerProgress: vi.fn((..._args: unknown[]) => Promise.resolve({ ok: true })),
};

vi.stubGlobal('electronAPI', api);

const track: MusicTrackInput = {
  trackId: 7,
  sourceId: 1,
  title: '晴天',
  artist: '周杰伦',
  albumartist: '周杰伦',
  duration: 269,
  path: '/music/晴天.mp3',
  codec: 'mp3',
};

beforeEach(() => {
  vi.clearAllMocks();
  useMusicPlaybackStore.setState({
    engine: null,
    restored: false,
    restoreInput: null,
    restorePosition: 0,
    current: null,
    currentSource: null,
    position: 0,
    duration: 0,
    isPlaying: false,
    queueLength: 0,
    queueIndex: 0,
    queueSnapshot: [],
    serverQueue: [],
    serverIndex: -1,
    mpvQueue: [],
    mpvQueueIndex: -1,
    errorMessage: null,
  });
});

describe('endSession (QYP3-068p)', () => {
  it('clears the restored (待播) state and the persisted record', () => {
    useMusicPlaybackStore.setState({
      restored: true,
      restoreInput: track,
      position: 42,
      current: { id: 7, title: '晴天', artist: '周杰伦', albumartist: '周杰伦', album: null, duration: 269, url: '' },
    });
    useMusicPlaybackStore.getState().endSession();
    const s = useMusicPlaybackStore.getState();
    expect(s.restored).toBe(false);
    expect(s.restoreInput).toBeNull();
    expect(s.current).toBeNull();
    expect(s.position).toBe(0);
    expect(api.clearNowPlaying).toHaveBeenCalled();
  });

  it('stops mpv explicitly — clearing state alone would leave the song audible', () => {
    useMusicPlaybackStore.setState({ engine: 'mpv', isPlaying: true });
    useMusicPlaybackStore.getState().endSession();
    expect(api.playerControl).toHaveBeenCalledWith('stop');
    expect(useMusicPlaybackStore.getState().engine).toBeNull();
    expect(api.clearNowPlaying).toHaveBeenCalled();
  });

  it('is a no-op when there is no session at all', () => {
    useMusicPlaybackStore.getState().endSession();
    expect(api.playerControl).not.toHaveBeenCalled();
    expect(api.clearNowPlaying).not.toHaveBeenCalled();
  });
});
