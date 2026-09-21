// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * direct 引擎解码失败兜底（QYP3-030）。
 *
 * 真实故障（用户报的「这首 flac 播不了」）：文件能被 mpv 解、但 Chromium 的
 * 媒体栈在打开容器时就失败（FLAC 内嵌图片块的 type 字段非法）。此时
 * `<audio>` 先抛 error 事件、`play()` 的 Promise 随后 reject。
 *
 * 修这个 bug 的关键是两件事，这个文件各钉一条：
 * 1. 兜底按「失败的那一首」重播（不是读 store.current —— 首播时它是 null，
 *    换曲后它是上一首）；
 * 2. 已交给 mpv 的那次 rejection 不再报错（否则用户看到"放不了"的假消息），
 *    而真正没人接的失败仍要报错。
 */

const h = vi.hoisted(() => ({
  engine: { instance: null as unknown as Record<string, unknown> },
  /** 引擎行为开关：引擎单例在 playQueue 内部懒建，测试不能提前替换实例方法。 */
  behavior: { unsupported: false, otherError: false, flacRecover: false, decodeErrorNoEvent: false },
}));

vi.mock('../../../src/renderer/player/web-audio-engine', () => {
  class WebAudioEngine {
    queueState = { length: 0, index: 0, currentTrackId: null as number | null, repeat: 'off', shuffle: false };
    onError?: (e?: unknown, track?: { id: number }) => void;
    onTime?: unknown;
    onEnded?: unknown;
    onPlaying?: unknown;
    setEq = vi.fn();
    setVolume = vi.fn();
    playQueue = vi.fn(async (tracks: Array<{ id: number }>, startIndex: number) => {
      // 真实引擎在起播前就把队列推进到当前曲（QYP3-068d：onError 要带上它）
      this.queueState = {
        ...this.queueState,
        length: tracks.length,
        index: startIndex,
        currentTrackId: tracks[startIndex]?.id ?? null,
      };
      if (h.behavior.unsupported) {
        // 与 Chromium 实测时序一致：先 error 事件，再 play() rejection
        this.onError?.(new Event('error'), tracks[startIndex]);
        throw new DOMException('Failed to load because no supported source was found.', 'NotSupportedError');
      }
      if (h.behavior.decodeErrorNoEvent) {
        // 没有 error 事件、只有 play() rejection 的边角场景（映射中文用）
        throw new DOMException('Failed to load because no supported source was found.', 'NotSupportedError');
      }
      if (h.behavior.otherError) throw new Error('解析播放地址失败');
      return undefined;
    });
    next = vi.fn(async () => undefined);
    prev = vi.fn(async () => undefined);
    pause = vi.fn();
    resume = vi.fn();
    seek = vi.fn();
    getSpectrum = vi.fn(() => null);
    getWaveform = vi.fn(() => null);
    recoverFlac = vi.fn(async () => h.behavior.flacRecover);
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
  // 参数签名要显式声明，否则 mock.calls 的元组是 []（取不到第 1 参）
  playerLoadFile: vi.fn((..._args: unknown[]) => Promise.resolve()),
  playerControl: vi.fn(() => Promise.resolve({ ok: true })),
  setMusicEngineActive: vi.fn(() => Promise.resolve({ ok: true })),
  getSettings: vi.fn(() => Promise.resolve({ ok: true, data: null })),
  getMusicLyrics: vi.fn(() => Promise.resolve({ ok: true, data: { hasLyrics: false, content: null } })),
  getServerLyrics: vi.fn(() => Promise.resolve({ ok: true, data: { hasLyrics: false, content: null } })),
  pushDeskLyricsState: vi.fn(() => Promise.resolve({ ok: true })),
  // QYP3-038：服务器会话/进度通道（webaudio 服务器曲目起播即开 Session）
  startMusicServerSession: vi.fn(() => Promise.resolve({ ok: true, data: { playSessionId: 'ps-1' } })),
  reportMusicServerProgress: vi.fn((..._args: unknown[]) => Promise.resolve({ ok: true })),
  reportMusicProgress: vi.fn((..._args: unknown[]) => Promise.resolve({ ok: true })),
};

vi.stubGlobal('electronAPI', api);

const flacTrack = (trackId: number, title: string): MusicTrackInput => ({
  trackId,
  sourceId: 5,
  title,
  artist: null,
  albumartist: null,
  duration: 284,
  path: `${title}.flac`,
  codec: 'flac',
});

/** direct 解析成功（renderer 引擎）+ mpv 兜底解析成功的成套应答。 */
function resolveDirectThenMpv(mpvItemIdOf: { value: string } = { value: '' }): void {
  api.resolvePlayback.mockImplementation(
    (ref: { itemId: string }, opts?: { engineForce?: string }) => {
      if (opts?.engineForce === 'mpv') {
        mpvItemIdOf.value = ref.itemId;
        return Promise.resolve({
          ok: true,
          data: {
            kind: 'local-file',
            url: `/home/qiuyuan/Music/曲${ref.itemId}.flac`,
            startPosition: 0,
            mediaContext: { mediaType: 'local', mediaId: `曲${ref.itemId}.flac` },
          },
        });
      }
      return Promise.resolve({
        ok: true,
        data: {
          kind: 'music-direct',
          url: `qy-file://audio/5/曲${ref.itemId}.flac`,
          startPosition: 0,
          engine: { engine: 'webaudio', reason: 'direct-codec' },
          mediaContext: { mediaType: 'local', mediaId: `曲${ref.itemId}.flac` },
        },
      });
    }
  );
}

/** 引擎失败：Chromium 打开不了容器 → 先 error 事件，再 play() rejection。 */
function failLikeUnsupportedFormat(): void {
  h.behavior.unsupported = true;
}

beforeEach(() => {
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
  const engine = h.engine.instance as { queueState: Record<string, unknown> } | null;
  if (engine) {
    engine.queueState = { length: 0, index: 0, currentTrackId: null, repeat: 'off', shuffle: false };
  }
  h.behavior.unsupported = false;
  h.behavior.otherError = false;
  h.behavior.flacRecover = false;
  h.behavior.decodeErrorNoEvent = false;
});

describe('direct → mpv fallback (QYP3-030)', () => {
  it('hands the FAILED track to mpv and reports no error', async () => {
    resolveDirectThenMpv();
    failLikeUnsupportedFormat();

    await useMusicPlaybackStore.getState().playQueue([flacTrack(13, '嘲笑')], 0);

    // 兜底重播的是失败的那一首，走 mpv（兜底是 fire-and-forget，等它落定）
    await vi.waitFor(() => expect(api.playerLoadFile).toHaveBeenCalledTimes(1));
    expect(api.playerLoadFile.mock.calls[0][0]).toBe('/home/qiuyuan/Music/曲13.flac');
    const state = useMusicPlaybackStore.getState();
    expect(state.engine).toBe('mpv');
    // 能播就不该报错（这是用户看到"点不动"的根源之一）
    expect(state.errorMessage).toBeNull();
  });

  it('falls back to the clicked track, not the previous one', async () => {
    const mpvItemId = { value: '' };
    resolveDirectThenMpv(mpvItemId);
    failLikeUnsupportedFormat();
    // 上一首还在状态里（真实场景：用户接着点下一首）
    useMusicPlaybackStore.setState({
      engine: 'webaudio',
      current: {
        id: 12,
        title: '海屿你',
        artist: null,
        album: null,
        albumartist: null,
        duration: 295,
        url: 'qy-file://audio/5/01.马也_Crabbit - 海屿你.flac',
      },
      isPlaying: false,
    });

    await useMusicPlaybackStore.getState().playQueue([flacTrack(13, '嘲笑')], 0);

    await vi.waitFor(() => expect(api.playerLoadFile).toHaveBeenCalledTimes(1));
    expect(mpvItemId.value).toBe('13');
    expect(api.playerLoadFile.mock.calls[0][0]).toBe('/home/qiuyuan/Music/曲13.flac');
  });

  it('reports a Chinese-ish error only when the mpv fallback also fails', async () => {
    api.resolvePlayback.mockImplementation((_ref: unknown, opts?: { engineForce?: string }) =>
      Promise.resolve(
        opts?.engineForce === 'mpv'
          ? { ok: false, error: { message: '音轨不存在或已删除' } }
          : {
              ok: true,
              data: {
                kind: 'music-direct',
                url: 'qy-file://audio/5/曲13.flac',
                startPosition: 0,
                engine: { engine: 'webaudio', reason: 'direct-codec' },
                mediaContext: { mediaType: 'local', mediaId: '曲13.flac' },
              },
            }
      )
    );
    failLikeUnsupportedFormat();

    await useMusicPlaybackStore.getState().playQueue([flacTrack(13, '嘲笑')], 0);

    await vi.waitFor(() =>
      expect(useMusicPlaybackStore.getState().errorMessage).toBe('音轨不存在或已删除')
    );
    const state = useMusicPlaybackStore.getState();
    expect(api.playerLoadFile).not.toHaveBeenCalled();
    expect(state.engine).toBeNull();
  });

  it('keeps webaudio and surfaces no error when FLAC cover-strip recovery succeeds (QYP3-033)', async () => {
    resolveDirectThenMpv();
    failLikeUnsupportedFormat();
    h.behavior.flacRecover = true;

    await useMusicPlaybackStore.getState().playQueue([flacTrack(13, '嘲笑')], 0);

    // 自救成功：保持内置引擎、不兜底 mpv、不把浏览器原文当失败弹出来
    await vi.waitFor(() => expect(useMusicPlaybackStore.getState().engine).toBe('webaudio'));
    expect(useMusicPlaybackStore.getState().errorMessage).toBeNull();
    expect(api.playerLoadFile).not.toHaveBeenCalled();
  });

  it('maps a raw decoder error to a Chinese message when no recovery/fallback owns it', async () => {
    resolveDirectThenMpv();
    // 没有 error 事件的自救/兜底 → 这次 rejection 无人认领，必须中文化上报
    h.behavior.decodeErrorNoEvent = true;

    await useMusicPlaybackStore.getState().playQueue([flacTrack(13, '嘲笑')], 0);

    await vi.waitFor(() =>
      expect(useMusicPlaybackStore.getState().errorMessage).toBe('这首曲目无法解码播放')
    );
  });

  it('still reports failures that no fallback picked up', async () => {
    resolveDirectThenMpv();
    // 没有 error 事件（不是解码失败，而是别的异常）→ 必须照常报错
    h.behavior.otherError = true;

    await useMusicPlaybackStore.getState().playQueue([flacTrack(13, '嘲笑')], 0);

    expect(useMusicPlaybackStore.getState().errorMessage).toBe('解析播放地址失败');
    expect(api.playerLoadFile).not.toHaveBeenCalled();
  });

  it('next() with a failing track falls back to THAT track and never throws unhandled (QYP3-068d)', async () => {
    resolveDirectThenMpv();
    const a = flacTrack(12, '海屿你');
    const b = flacTrack(13, '嘲笑');
    h.behavior.unsupported = false;
    await useMusicPlaybackStore.getState().playQueue([a, b], 0);
    expect(useMusicPlaybackStore.getState().current?.title).toBe('海屿你');

    // 模拟下一曲 B 起播失败：引擎队列已前进到 B，error 事件带上 B，
    // play() rejection 随后——store.next() 必须吞掉它且兜底重播 B
    const engine = h.engine.instance as {
      queueState: Record<string, unknown>;
      onError?: (e?: unknown, track?: { id: number }) => void;
      next: ReturnType<typeof vi.fn>;
    };
    engine.next.mockImplementation(async () => {
      engine.queueState = { ...engine.queueState, index: 1, currentTrackId: 13 };
      engine.onError?.(new Event('error'), { id: 13 });
      throw new DOMException('Failed to load because no supported source was found.', 'NotSupportedError');
    });

    // 不冒泡 = 不会变成 unhandled rejection（用户看到的白板场景）
    await expect(useMusicPlaybackStore.getState().next()).resolves.toBeUndefined();

    await vi.waitFor(() => expect(api.playerLoadFile).toHaveBeenCalledTimes(1));
    expect(api.playerLoadFile.mock.calls[0][0]).toBe('/home/qiuyuan/Music/曲13.flac');
  });
});

describe('server track fallback (QYP3-037)', () => {
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

  /** 服务器曲目解析：直解给 qy-stream；mpv 兜底给直链（记录拿到的 ref）。 */
  function resolveServerThenMpv(mpvRefOf: { value: unknown } = { value: null }): void {
    api.resolvePlayback.mockImplementation(
      (ref: Record<string, unknown>, opts?: { engineForce?: string }) => {
        if (opts?.engineForce === 'mpv') {
          mpvRefOf.value = ref;
          return Promise.resolve({
            ok: true,
            data: {
              kind: 'online-direct',
              url: 'http://srv:8096/Videos/x/stream',
              startPosition: 0,
              mediaContext: { mediaType: 'jellyfin', mediaId: 'x' },
            },
          });
        }
        return Promise.resolve({
          ok: true,
          data: {
            kind: 'music-direct',
            url: 'qy-stream://audio/sess-1',
            startPosition: 0,
            engine: { engine: 'webaudio', reason: 'direct-codec' },
            mediaContext: { mediaType: 'jellyfin', mediaId: ref.itemId },
          },
        });
      }
    );
  }

  it('hands a FAILED server track to mpv via {provider, serverId, itemId}', async () => {
    const mpvRefOf = { value: null as unknown };
    resolveServerThenMpv(mpvRefOf);
    failLikeUnsupportedFormat();

    await useMusicPlaybackStore.getState().playQueue([serverTrack('item-9', '云歌')], 0);

    await vi.waitFor(() => expect(api.playerLoadFile).toHaveBeenCalledTimes(1));
    // 兜底 ref 必须是服务器路由，不能是本地构造 {provider:'music', itemId:'0'}
    expect(mpvRefOf.value).toEqual({
      provider: 'jellyfin',
      serverId: 7,
      itemId: 'item-9',
    });
    expect(useMusicPlaybackStore.getState().errorMessage).toBeNull();
  });

  it('gives server tracks distinct negative queue ids (trackId is 0 for all)', async () => {
    resolveServerThenMpv();

    await useMusicPlaybackStore
      .getState()
      .playQueue([serverTrack('a', '一'), serverTrack('b', '二')], 0);

    const snapshot = useMusicPlaybackStore.getState().queueSnapshot;
    expect(snapshot.map((q) => q.id)).toEqual([-1, -2]);
    // 服务器队列落进状态：中途兜底 mpv 后，eof 推进有据可依
    expect(useMusicPlaybackStore.getState().serverQueue.length).toBe(2);
    expect(useMusicPlaybackStore.getState().serverIndex).toBe(0);
  });

  it('aligns serverIndex to the fallback track so mpv continues the queue', async () => {
    resolveServerThenMpv();
    failLikeUnsupportedFormat();

    // 从第 2 首起播（第 1 首是另一首服务器曲目），失败后 serverIndex 对到 1
    await useMusicPlaybackStore
      .getState()
      .playQueue([serverTrack('a', '一'), serverTrack('b', '二')], 1);

    await vi.waitFor(() => expect(api.playerLoadFile).toHaveBeenCalledTimes(1));
    expect(useMusicPlaybackStore.getState().serverIndex).toBe(1);
  });
});
