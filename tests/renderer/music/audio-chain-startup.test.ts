// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 起播时把**已保存的**音效链交给引擎（QYP3-068v）。
 *
 * 两个引擎各走各的路，两条都必须带：
 *   ① 内置引擎：`playQueue` 里 `engine.setAudioFx(读到的链)`
 *   ② mpv：`playerLoadFile` 第 6 参 `audioChain.fx`（主进程据此生成 af）
 *
 * 这个文件的存在本身就是回归护栏——真机实测发现 ② 起播的 af 恒为空：
 * `readAudioFxSettings` 读了 `getSettings(...)?.data`，而 `SETTINGS.GET`
 * 直接返回解码后的值、不包 `{ok,data}`，于是永远读到默认（直通）链，
 * 只有拖滑块（走 APPLY_AUDIO_CHAIN 的那条路）才生效。
 * 单测当时也用 `{ok,data}` 假响应，所以全绿。
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
  AUDIO_FX_KEY,
  type MusicTrackInput,
} from '../../../src/renderer/stores/music-playback-store';
import { AUDIO_FX_DEFAULT, type AudioFxSettings } from '../../../src/main/modules/playback-engine/audio-fx';

/** 用户保存过的链：第 0 段 +7dB、前置 +3dB、宽度 1.5。 */
const SAVED_FX: AudioFxSettings = {
  ...AUDIO_FX_DEFAULT,
  eq: {
    enabled: true,
    preamp: 3,
    bands: AUDIO_FX_DEFAULT.eq.bands.map((b, i) => ({ ...b, gain: i === 0 ? 7 : 0 })),
  },
  width: 1.5,
};

const api = {
  resolvePlayback: vi.fn(),
  // 参数要显式收下，否则 mock.calls[n] 的元组类型是 []，取第 6 参过不了 tsc
  playerLoadFile: vi.fn((..._args: unknown[]) => Promise.resolve()),
  playerControl: vi.fn(() => Promise.resolve({ ok: true })),
  setMusicEngineActive: vi.fn(() => Promise.resolve({ ok: true })),
  // 原样返回，不包 {ok,data} —— 与主进程 SETTINGS.GET 的实际返回一致
  getSettings: vi.fn((_key: string) => Promise.resolve(null as unknown)),
  getMusicLyrics: vi.fn(() => Promise.resolve({ ok: true, data: { hasLyrics: false, content: null } })),
  getServerLyrics: vi.fn(() => Promise.resolve({ ok: true, data: { hasLyrics: false, content: null } })),
  pushDeskLyricsState: vi.fn(() => Promise.resolve({ ok: true })),
  setMusicTrackDuration: vi.fn(() => Promise.resolve({ ok: true })),
};

vi.stubGlobal('electronAPI', api);

const localTrack = (trackId: number): MusicTrackInput => ({
  trackId,
  sourceId: 1,
  title: '晴天',
  artist: '周杰伦',
  albumartist: '周杰伦',
  duration: 269,
  path: '周杰伦/叶惠美/03 - 晴天.mp3',
  codec: 'mp3',
});

/** playerLoadFile 的第 6 参（audioChain）。 */
const CHAIN_ARG = 5;

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
    audioFx: AUDIO_FX_DEFAULT,
  });
  api.getSettings.mockImplementation((key: string) =>
    Promise.resolve(key === AUDIO_FX_KEY ? SAVED_FX : null)
  );
});

describe('起播时的音效链（QYP3-068v）', () => {
  it('mpv 路径把已保存的链交给 playerLoadFile（不是默认直通链）', async () => {
    // 非直解格式 → engine-selector 判 mpv
    api.resolvePlayback.mockResolvedValue({
      ok: true,
      data: { kind: 'local', url: 'qy-file://audio/1/晴天.ape', startPosition: 0, engine: { engine: 'mpv', reason: 'codec' } },
    });

    await useMusicPlaybackStore.getState().playQueue([localTrack(1)], 0);

    expect(api.playerLoadFile).toHaveBeenCalled();
    const chain = api.playerLoadFile.mock.calls[0][CHAIN_ARG] as { fx?: AudioFxSettings };
    expect(chain?.fx).toBeTruthy();
    expect(chain!.fx!.eq.bands[0].gain).toBe(7);
    expect(chain!.fx!.eq.preamp).toBe(3);
    expect(chain!.fx!.width).toBe(1.5);
  });

  it('内置引擎路径把已保存的链灌进音频图', async () => {
    api.resolvePlayback.mockResolvedValue({
      ok: true,
      data: { kind: 'local', url: 'qy-file://audio/1/晴天.mp3', startPosition: 0, engine: { engine: 'webaudio', reason: 'direct' } },
    });

    await useMusicPlaybackStore.getState().playQueue([localTrack(1)], 0);

    const setAudioFx = h.engine.instance.setAudioFx as ReturnType<typeof vi.fn>;
    expect(setAudioFx).toHaveBeenCalled();
    const passed = setAudioFx.mock.calls.at(-1)![0] as AudioFxSettings;
    expect(passed.eq.bands[0].gain).toBe(7);
    expect(passed.width).toBe(1.5);
    // store 也同步了（面板打开时以此为初值）
    expect(useMusicPlaybackStore.getState().audioFx.eq.bands[0].gain).toBe(7);
  });

  it('配置里没有音效链时退回默认（不抛错、不当成脏数据）', async () => {
    api.getSettings.mockResolvedValue(null);
    api.resolvePlayback.mockResolvedValue({
      ok: true,
      data: { kind: 'local', url: 'qy-file://audio/1/晴天.ape', startPosition: 0, engine: { engine: 'mpv', reason: 'codec' } },
    });

    await useMusicPlaybackStore.getState().playQueue([localTrack(1)], 0);

    const chain = api.playerLoadFile.mock.calls[0][CHAIN_ARG] as { fx?: AudioFxSettings };
    expect(chain?.fx?.enabled).toBe(AUDIO_FX_DEFAULT.enabled);
    expect(chain!.fx!.eq.preamp).toBe(0);
  });
});
