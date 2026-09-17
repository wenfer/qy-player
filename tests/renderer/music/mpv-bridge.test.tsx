// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  attachMusicMpvBridge,
  useMusicPlaybackStore,
  type MusicTrackInput,
} from '../../../src/renderer/stores/music-playback-store';

/**
 * mpv 引擎音乐位置源（QYP3-026）。
 *
 * mpv 的音乐与视频共用同一路 player:on-state-change；只有主进程打了
 * `music` 标记的事件才写回音乐 store（否则视频进度会驱动迷你条）。
 * 自然 EOF 按音乐队列推进下一曲；视频加载（music=false / SESSION_END）
 * 结束音乐会话。
 */

let stateListener: ((state: unknown) => void) | null = null;
let sessionEndListener: (() => void) | null = null;

const api = {
  onPlayerStateChange: vi.fn((cb: (state: unknown) => void) => {
    stateListener = cb;
    return () => undefined;
  }),
  onMusicSessionEnd: vi.fn((cb: () => void) => {
    sessionEndListener = cb;
    return () => undefined;
  }),
  setMusicEngineActive: vi.fn(() => Promise.resolve({ ok: true })),
  pushDeskLyricsState: vi.fn(() => Promise.resolve({ ok: true })),
  playerControl: vi.fn(() => Promise.resolve({ ok: true })),
  playerLoadFile: vi.fn(() => Promise.resolve()),
  resolvePlayback: vi.fn(),
  getSettings: vi.fn(() => Promise.resolve({ ok: true, data: null })),
  getMusicLyrics: vi.fn(() => Promise.resolve({ ok: true, data: { hasLyrics: false, content: null } })),
  getServerLyrics: vi.fn(() =>
    Promise.resolve({ ok: true, data: { hasLyrics: false, content: null } })
  ),
};

vi.stubGlobal('electronAPI', api);

const serverTrack = (itemId: string, title: string): MusicTrackInput => ({
  trackId: 0,
  sourceId: 0,
  serverId: 1,
  provider: 'jellyfin',
  itemId,
  title,
  artist: '周杰伦',
  albumartist: '周杰伦',
  duration: 269,
  path: '',
  codec: null,
});

function resetStore(): void {
  useMusicPlaybackStore.setState({
    engine: null,
    current: null,
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
}

/** 把 store 置于"mpv 正在播服务器音乐"的状态。 */
function primeMpvMusic(): void {
  useMusicPlaybackStore.setState({
    engine: 'mpv',
    current: {
      id: 0,
      title: '晴天',
      artist: '周杰伦',
      album: null,
      albumartist: '周杰伦',
      duration: 269,
      url: 'http://s:8096/Audio/t1/stream',
    },
    isPlaying: true,
    serverQueue: [serverTrack('t1', '晴天'), serverTrack('t2', '以父之名')],
    serverIndex: 0,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetStore();
  // 幂等：首次调用注册，其后为 no-op（监听器读的是实时 state）
  attachMusicMpvBridge();
});

describe('mpv music bridge (QYP3-026)', () => {
  it('subscribes once and ignores non-music (video) events', () => {
    attachMusicMpvBridge();
    expect(api.onPlayerStateChange).toHaveBeenCalledTimes(1);
    expect(api.onMusicSessionEnd).toHaveBeenCalledTimes(1);
    expect(stateListener).toBeTypeOf('function');

    primeMpvMusic();
    stateListener!({ music: false, currentTime: 42, duration: 5000 });
    const state = useMusicPlaybackStore.getState();
    // 视频进度不写进音乐 store；但视频已接管 mpv → 音乐会话结束
    expect(state.position).toBe(0);
    expect(state.engine).toBeNull();
    expect(state.current).toBeNull();
  });

  it('keeps the renderer engine session when a stale mpv event arrives', () => {
    // renderer 引擎音乐与视频互斥由主进程 ON_SESSION_END 负责；
    // mpv 的残留事件（music=false）不得误杀 renderer 引擎
    useMusicPlaybackStore.setState({ engine: 'webaudio', isPlaying: true });
    stateListener!({ music: false, volume: 50 });
    expect(useMusicPlaybackStore.getState().engine).toBe('webaudio');
    expect(useMusicPlaybackStore.getState().isPlaying).toBe(true);
  });

  it('writes mpv position/duration/playing only in a music session', () => {
    // 桌面歌词推送有 ≤10Hz 节流（真实时间），把时钟推远以越过节流
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 5_000);
    primeMpvMusic();
    stateListener!({ music: true, currentTime: 12.5, duration: 269, isPlaying: true });
    const state = useMusicPlaybackStore.getState();
    expect(state.position).toBe(12.5);
    expect(state.duration).toBe(269);
    expect(state.isPlaying).toBe(true);
    // 桌面歌词位置随之推送（mpv 无 renderer 引擎的 onTime）
    expect(api.pushDeskLyricsState).toHaveBeenCalledWith(
      expect.objectContaining({ position: 12.5, isPlaying: true, title: '晴天' })
    );
    vi.useRealTimers();

    stateListener!({ music: true, isPlaying: false });
    expect(useMusicPlaybackStore.getState().isPlaying).toBe(false);
  });

  it('advances the server queue on natural eof', async () => {
    primeMpvMusic();
    api.resolvePlayback.mockResolvedValue({
      ok: true,
      data: { url: 'http://s:8096/Audio/t2/stream', startPosition: 0, mediaContext: {} },
    });
    stateListener!({ music: true, eof: true, isPlaying: false });
    await vi.waitFor(() => expect(useMusicPlaybackStore.getState().serverIndex).toBe(1));
    expect(api.playerLoadFile).toHaveBeenCalledWith(
      'http://s:8096/Audio/t2/stream',
      undefined,
      undefined,
      expect.anything(),
      undefined,
      expect.anything()
    );
  });

  it('does not touch mpv on eof when there is no queue (single local track)', () => {
    useMusicPlaybackStore.setState({
      engine: 'mpv',
      current: {
        id: 7,
        title: '冷门格式',
        artist: null,
        album: null,
        albumartist: null,
        duration: 100,
        url: '/x.ape',
      },
      isPlaying: true,
    });
    stateListener!({ music: true, eof: true, isPlaying: false });
    expect(api.playerControl).not.toHaveBeenCalled();
    expect(api.playerLoadFile).not.toHaveBeenCalled();
  });

  it('clears the session when the main process reports a video took over', () => {
    primeMpvMusic();
    sessionEndListener!();
    const state = useMusicPlaybackStore.getState();
    expect(state.engine).toBeNull();
    expect(state.current).toBeNull();
    expect(state.serverQueue).toEqual([]);
    expect(state.isPlaying).toBe(false);
    expect(api.setMusicEngineActive).toHaveBeenCalledWith(false);
  });
});
