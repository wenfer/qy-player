// @vitest-environment jsdom
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 启动恢复「当前播放的音乐」（QYP3-053）。
 *
 * 音频不记播放历史，只留一条"上次在放哪首 + 放到哪"：重启后播放条**原样
 * 出现**但不自动出声；点播放从上次位置继续；一旦真正起播，恢复态即让位。
 * engine 全程保持 null（恢复态不算音乐会话）——否则会误触自动精简模式、
 * 抢走全局媒体键。
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

import MusicMiniBar from '../../../src/renderer/components/MusicMiniBar';
import {
  useMusicPlaybackStore,
  type MusicTrackInput,
} from '../../../src/renderer/stores/music-playback-store';
import { useSleepTimerStore } from '../../../src/renderer/stores/sleep-timer-store';
import { useCompactModeStore } from '../../../src/renderer/stores/compact-mode-store';

const api = {
  resolvePlayback: vi.fn(),
  playerLoadFile: vi.fn((..._args: unknown[]) => Promise.resolve()),
  playerControl: vi.fn(() => Promise.resolve({ ok: true })),
  setMusicEngineActive: vi.fn(() => Promise.resolve({ ok: true })),
  getSettings: vi.fn((_key: string): Promise<{ ok: boolean; data: unknown }> =>
    Promise.resolve({ ok: true, data: null })
  ),
  setSettings: vi.fn(() => Promise.resolve({ ok: true })),
  getMusicLyrics: vi.fn(() => Promise.resolve({ ok: true, data: { hasLyrics: false, content: null } })),
  getServerLyrics: vi.fn(() => Promise.resolve({ ok: true, data: { hasLyrics: false, content: null } })),
  pushDeskLyricsState: vi.fn(() => Promise.resolve({ ok: true })),
  getMusicFavorites: vi.fn(() => Promise.resolve({ ok: true, data: { tracks: [] } })),
  // 返回类型要显式声明，否则 TS 从初始实现推断成 `{ record: null }` 收不了记录
  getNowPlaying: vi.fn(
    (): Promise<{ ok: boolean; data: { record: unknown } }> =>
      Promise.resolve({ ok: true, data: { record: null } })
  ),
  setNowPlaying: vi.fn((..._args: unknown[]) => Promise.resolve({ ok: true })),
  reportMusicServerProgress: vi.fn((..._args: unknown[]) => Promise.resolve({ ok: true })),
  startMusicServerSession: vi.fn(() =>
    Promise.resolve({ ok: true, data: { playSessionId: 'ps-1' } })
  ),
  onPlayerStateChange: vi.fn(() => () => undefined),
  onMusicSessionEnd: vi.fn(() => () => undefined),
  onMusicCommand: vi.fn(() => () => undefined),
};

vi.stubGlobal('electronAPI', api);
HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as never;

const localInput: MusicTrackInput = {
  trackId: 12,
  sourceId: 5,
  title: '云上歌',
  artist: '歌手',
  albumartist: '歌手',
  duration: 200,
  path: 'Music/song.flac',
  codec: 'flac',
};

const serverInput: MusicTrackInput = {
  trackId: 0,
  sourceId: 0,
  serverId: 7,
  provider: 'jellyfin',
  itemId: 'item-1',
  title: '云端曲',
  artist: null,
  albumartist: null,
  duration: 180,
  path: '',
  codec: 'mp3',
};

/** 微任务冲刷：让 initNowPlaying 的 await 落定。 */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

function resetStore(): void {
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
    restored: false,
    restoreInput: null,
    restorePosition: 0,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetStore();
  useCompactModeStore.setState({ compact: false });
  useSleepTimerStore.setState({ active: false, minutes: null, expiresAt: null, remainingMs: null });
});

describe('now-playing restore (QYP3-053)', () => {
  it('restores the bar without pretending to have an engine', async () => {
    api.getNowPlaying.mockResolvedValue({
      ok: true,
      data: { record: { type: 'track', position: 42, duration: 200, updatedAt: 1, input: localInput } },
    });

    await useMusicPlaybackStore.getState().initNowPlaying();

    const s = useMusicPlaybackStore.getState();
    expect(s.engine).toBeNull(); // 恢复态不算音乐会话（不自动精简、不抢媒体键）
    expect(s.restored).toBe(true);
    expect(s.isPlaying).toBe(false);
    expect(s.position).toBe(42);
    expect(s.current?.title).toBe('云上歌');
    expect(s.currentSource).toEqual({ trackId: 12, sourceId: 5 });
    expect(s.restoreInput).toEqual(localInput);
  });

  it('ignores a missing record and never enters the restored state', async () => {
    api.getNowPlaying.mockResolvedValue({ ok: true, data: { record: null } });
    await useMusicPlaybackStore.getState().initNowPlaying();
    expect(useMusicPlaybackStore.getState().restored).toBe(false);
    expect(useMusicPlaybackStore.getState().current).toBeNull();
  });

  it('ignores a restore that arrives after the user already started playing', async () => {
    useMusicPlaybackStore.setState({ engine: 'mpv' });
    api.getNowPlaying.mockResolvedValue({
      ok: true,
      data: { record: { type: 'track', position: 42, duration: 200, updatedAt: 1, input: localInput } },
    });
    await useMusicPlaybackStore.getState().initNowPlaying();
    expect(useMusicPlaybackStore.getState().restored).toBe(false);
  });

  it('resumeRestored plays from the saved position and clears the restored state', async () => {
    api.getNowPlaying.mockResolvedValue({
      ok: true,
      data: { record: { type: 'track', position: 42, duration: 200, updatedAt: 1, input: localInput } },
    });
    api.resolvePlayback.mockResolvedValue({
      ok: true,
      data: {
        kind: 'music-direct',
        url: 'qy-file://audio/5/Music/song.flac',
        startPosition: 0, // QYP3-053：resolver 不再给音乐续播位置
        engine: { engine: 'webaudio', reason: 'direct-codec' },
        mediaContext: { mediaType: 'local', mediaId: 'Music/song.flac' },
      },
    });
    await useMusicPlaybackStore.getState().initNowPlaying();
    await useMusicPlaybackStore.getState().resumeRestored();
    await flush();

    // 恢复位置必须显式传进引擎（首曲起播位置的第 6 个参数）
    const engineArgs = (h.engine.instance.playQueue as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(engineArgs[5]).toBe(42);
    const s = useMusicPlaybackStore.getState();
    expect(s.engine).toBe('webaudio');
    expect(s.restored).toBe(false);
    expect(s.restoreInput).toBeNull();
    expect(s.isPlaying).toBe(true);
  });

  it('resumeRestored feeds the saved position to mpv as well', async () => {
    api.getNowPlaying.mockResolvedValue({
      ok: true,
      data: { record: { type: 'track', position: 77, duration: 200, updatedAt: 1, input: localInput } },
    });
    api.resolvePlayback.mockResolvedValue({
      ok: true,
      data: {
        kind: 'local-file',
        url: '/music/song.flac',
        startPosition: 0,
        engine: { engine: 'mpv', reason: 'compat-first' },
        mediaContext: { mediaType: 'local', mediaId: 'Music/song.flac' },
      },
    });
    await useMusicPlaybackStore.getState().initNowPlaying();
    await useMusicPlaybackStore.getState().resumeRestored();
    await flush();

    expect(api.playerLoadFile.mock.calls[0][1]).toBe(77);
    expect(useMusicPlaybackStore.getState().engine).toBe('mpv');
    expect(useMusicPlaybackStore.getState().restored).toBe(false);
  });

  it('a plain playQueue starts from 0 (no per-track resume anymore)', async () => {
    api.resolvePlayback.mockResolvedValue({
      ok: true,
      data: {
        kind: 'music-direct',
        url: 'qy-file://audio/5/Music/song.flac',
        startPosition: 0,
        engine: { engine: 'webaudio', reason: 'direct-codec' },
        mediaContext: { mediaType: 'local', mediaId: 'Music/song.flac' },
      },
    });
    await useMusicPlaybackStore.getState().playQueue([localInput], 0);
    await flush();
    const engineArgs = (h.engine.instance.playQueue as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(engineArgs[5]).toBe(0);
    expect(useMusicPlaybackStore.getState().position).toBe(0);
  });

  it('the mini bar renders in the restored state and starts from there', async () => {
    api.getNowPlaying.mockResolvedValue({
      ok: true,
      data: { record: { type: 'server', position: 42, duration: 180, updatedAt: 1, input: serverInput } },
    });
    useMusicPlaybackStore.setState({
      restored: true,
      restoreInput: serverInput,
      restorePosition: 42,
      current: {
        id: 0,
        title: '云端曲',
        artist: null,
        album: null,
        albumartist: null,
        duration: 180,
        url: '',
      },
      currentSource: { trackId: 0, serverId: 7, itemId: 'item-1' },
      position: 42,
      duration: 180,
    });

    render(<MusicMiniBar />);
    const play = await screen.findByLabelText('继续播放音乐');
    expect(screen.getByText('云端曲')).toBeTruthy();
    expect(screen.getByText('0:42 / 3:00')).toBeTruthy();

    // 点播放 → 真正起播（mpv 引擎的服务器曲目走 loadfile，位置来自恢复态）
    api.resolvePlayback.mockResolvedValue({
      ok: true,
      data: {
        kind: 'online-direct',
        url: 'http://s:8096/Audio/item-1/stream',
        startPosition: 0,
        engine: { engine: 'mpv', reason: 'server-audio' },
        mediaContext: { mediaType: 'jellyfin', mediaId: 'item-1', mediaSourceId: 'ms-1' },
      },
    });
    fireEvent.click(play);
    await waitFor(() => expect(api.playerLoadFile).toHaveBeenCalled());
    expect(api.playerLoadFile.mock.calls[0][1]).toBe(42);
  });

  it('the mini bar stays hidden when there is neither a session nor a restore', async () => {
    render(<MusicMiniBar />);
    await waitFor(() => expect(api.getMusicFavorites).toHaveBeenCalled());
    expect(screen.queryByLabelText('继续播放音乐')).toBeNull();
  });
});
