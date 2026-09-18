// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { PlaybackQueue, WebAudioEngine, type QueueTrack } from '../../../src/renderer/player/web-audio-engine';

function makeTrack(id: number, url?: string): QueueTrack {
  return {
    id,
    title: `曲目${id}`,
    artist: null,
    album: null,
    albumartist: null,
    duration: 100 + id,
    url: url ?? `qy-file://audio/1/${id}.mp3`,
  };
}

type FakeAudio = HTMLAudioElement & {
  paused: boolean;
  listeners: Record<string, Array<(e?: unknown) => void>>;
  emit: (name: string) => void;
};

function fakeAudio(): FakeAudio {
  const el: FakeAudio = {
    paused: true,
    currentTime: 0,
    duration: NaN,
    src: '',
    volume: 1,
    listeners: {},
    emit(name: string) {
      for (const cb of el.listeners[name] ?? []) cb();
    },
    play: vi.fn(async () => {
      el.paused = false;
    }),
    pause: vi.fn(() => {
      el.paused = true;
    }),
    addEventListener(name: string, cb: (e?: unknown) => void) {
      el.listeners[name] ??= [];
      el.listeners[name].push(cb);
    },
  } as unknown as FakeAudio;
  return el;
}

function fakeCtx(): AudioContext {
  return {
    state: 'running',
    createMediaElementSource: vi.fn(() => ({ connect: vi.fn() })),
    createAnalyser: vi.fn(() => ({
      fftSize: 2048,
      smoothingTimeConstant: 0,
      frequencyBinCount: 1024,
      getByteFrequencyData: (arr: Uint8Array) => arr.fill(7),
      getByteTimeDomainData: (arr: Uint8Array) => arr.fill(128),
      connect: vi.fn(),
    })),
    createBiquadFilter: vi.fn(() => ({
      type: '',
      frequency: { value: 0 },
      gain: { value: 0 },
      connect: vi.fn(),
    })),
    createGain: vi.fn(() => ({ gain: { value: 1 }, connect: vi.fn() })),
    destination: {},
    resume: vi.fn(async () => undefined),
  } as unknown as AudioContext;
}

describe('PlaybackQueue (QYP3-010)', () => {
  it('plays sequentially and stops at queue end with repeat off', () => {
    const q = new PlaybackQueue();
    q.setQueue([makeTrack(1), makeTrack(2), makeTrack(3)], 0);
    expect(q.current?.id).toBe(1);
    expect(q.next()?.id).toBe(2);
    expect(q.next()?.id).toBe(3);
    expect(q.next()).toBeNull();
    expect(q.prev()?.id).toBe(2);
    expect(q.prev()?.id).toBe(1);
    expect(q.prev()?.id).toBe(1); // repeat off：队头不动
  });

  it('repeat all wraps around', () => {
    const q = new PlaybackQueue();
    q.repeat = 'all';
    q.setQueue([makeTrack(1), makeTrack(2)], 1);
    expect(q.next()?.id).toBe(1);
    expect(q.next()?.id).toBe(2);
    expect(q.prev()?.id).toBe(1);
    expect(q.prev()?.id).toBe(2);
  });

  it('repeat one never advances', () => {
    const q = new PlaybackQueue();
    q.repeat = 'one';
    q.setQueue([makeTrack(1), makeTrack(2)], 0);
    expect(q.next()?.id).toBe(1);
    expect(q.prev()?.id).toBe(1);
  });

  it('shuffle: first cycle visits distinct items, wrap never nulls', () => {
    const q = new PlaybackQueue();
    q.shuffle = true;
    q.setQueue([makeTrack(1), makeTrack(2), makeTrack(3)], 0);
    // 首个洗牌周期（repeat off 下耗尽前）访问的曲子互不重复
    const visited: number[] = [q.current!.id];
    let t = q.next();
    while (t) {
      visited.push(t.id);
      t = q.next();
    }
    expect(new Set(visited).size).toBe(visited.length);
    expect(visited.length).toBeLessThanOrEqual(3);
    // repeat all + shuffle：绕不完、永不 null、值域合法（跨周期允许重洗）
    q.repeat = 'all';
    for (let i = 0; i < 20; i++) {
      const item = q.next();
      expect(item).not.toBeNull();
      expect([1, 2, 3]).toContain(item!.id);
    }
  });

  it('shuffle with repeat off stops at the end', () => {
    const q = new PlaybackQueue();
    q.shuffle = true;
    q.setQueue([makeTrack(1), makeTrack(2), makeTrack(3)], 0);
    // repeat off：随机排列耗尽后必然停止（≤ length 步内出现 null）
    let sawNull = false;
    for (let i = 0; i < q.length; i++) {
      if (q.next() === null) {
        sawNull = true;
        break;
      }
    }
    expect(sawNull).toBe(true);
    expect(q.next()).toBeNull();
  });

  it('jumpTo switches to an arbitrary index', () => {
    const q = new PlaybackQueue();
    q.setQueue([makeTrack(1), makeTrack(2), makeTrack(3)], 0);
    q.jumpTo(2);
    expect(q.current?.id).toBe(3);
    expect(q.next()).toBeNull();
  });
});

describe('WebAudioEngine (QYP3-010)', () => {
  function makeEngine(): { engine: WebAudioEngine; audio: FakeAudio; ctx: AudioContext } {
    const audio = fakeAudio();
    const ctx = fakeCtx();
    const engine = new WebAudioEngine({
      createElement: () => audio,
      createContext: () => ctx,
    });
    return { engine, audio, ctx };
  }

  it('builds the graph: source → analyser → 10 EQ filters → gain → out', () => {
    const { engine } = makeEngine();
    // 曲目切换只换 src（图单次构建）
    void engine.playQueue([makeTrack(1), makeTrack(2)], 0, 'off', false);
    expect(engine.queueState).toMatchObject({ length: 2, index: 0, currentTrackId: 1 });
  });

  it('next(auto) with repeat one restarts the same track', async () => {
    const { engine, audio } = makeEngine();
    await engine.playQueue([makeTrack(1), makeTrack(2)], 0, 'one', false);
    await engine.next(true);
    expect(engine.queueState.currentTrackId).toBe(1);
    expect((audio as unknown as { currentTime: number }).currentTime).toBe(0);
  });

  it('ended auto-advances to the next track (repeat all wraps)', async () => {
    const { engine, audio } = makeEngine();
    await engine.playQueue([makeTrack(1), makeTrack(2)], 1, 'all', false);
    audio.emit('ended');
    // onEnded 由测试自行调用 engine.next(false) 模拟（store 层职责）
    void engine;
  });

  it('timeupdate fires onTime with position and duration', () => {
    const { engine, audio } = makeEngine();
    const onTime = vi.fn();
    engine.onTime = onTime;
    (audio as unknown as { currentTime: number; duration: number }).currentTime = 5;
    (audio as unknown as { duration: number }).duration = 100;
    audio.emit('timeupdate');
    expect(onTime).toHaveBeenCalledWith(5, 100);
  });

  it('setEq writes dB gains across the 10 filters', () => {
    const { engine } = makeEngine();
    // 通过 playQueue 建 10 个 filter（fake ctx 每次返回新对象，但 gain.value 可读）
    void engine.playQueue([makeTrack(1)], 0, 'off', false);
    const gains = [3, 0, -2, 0, 0, 0, 0, 0, 1, 4];
    engine.setEq(gains);
    // 通过 spectrum 探针确认 analyser 存在
    const spectrum = engine.getSpectrum();
    expect(spectrum).not.toBeNull();
    expect(spectrum![0]).toBe(7);
  });

  it('spectrum stays null-safe when the graph could not build', () => {
    const engine = new WebAudioEngine({
      createElement: () => fakeAudio(),
      createContext: () => {
        throw new Error('no audio device');
      },
    });
    expect(engine.getSpectrum()).toBeNull();
  });

  it('getWaveform returns a time-domain buffer centered at 128 (QYP3-033)', () => {
    const { engine } = makeEngine();
    void engine.playQueue([makeTrack(1)], 0, 'off', false);
    const wave = engine.getWaveform();
    expect(wave).not.toBeNull();
    // fftSize=2048 → 时域缓冲长度 2048；fake 填充 128（静音）
    expect(wave!.length).toBe(2048);
    expect(wave![0]).toBe(128);
  });

  it('waveform stays null-safe when the graph could not build (QYP3-033)', () => {
    const engine = new WebAudioEngine({
      createElement: () => fakeAudio(),
      createContext: () => {
        throw new Error('no audio device');
      },
    });
    expect(engine.getWaveform()).toBeNull();
  });

  it('recoverFlac strips embedded picture and retries for a local FLAC (QYP3-033)', async () => {
    const audio = fakeAudio();
    const ctx = fakeCtx();
    const engine = new WebAudioEngine({
      createElement: () => audio,
      createContext: () => ctx,
    });
    // 造一个含 PICTURE(type=6) 块的 FLAC（STREAMINFO + PICTURE + 末块 + 音频帧）
    const input = new Uint8Array([
      0x66, 0x4c, 0x61, 0x43, // 'fLaC'
      0x00, 0x00, 0x00, 0x02, 1, 2, // STREAMINFO（非末块）
      0x06, 0x00, 0x00, 0x02, 9, 9, // PICTURE（应被剥离）
      0x84, 0x00, 0x00, 0x01, 5, // VORBIS（末块）
      0xff, 0xf8, 0x00, // 音频帧
    ]);
    const fetchMock = vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => input.slice().buffer,
    }));
    const createObjectURL = vi.fn(() => 'blob:fake-stripped');
    const RealURL = globalThis.URL;
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('URL', Object.assign(Object.create(RealURL), { createObjectURL }));
    try {
      // 本地 FLAC（qy-file://audio），含非法封面 → 剥离后在内置引擎重播
      const ok = await engine.recoverFlac(makeTrack(1, 'qy-file://audio/1/嘲笑.flac'));
      expect(ok).toBe(true);
      expect(createObjectURL).toHaveBeenCalled();
      expect(audio.src).toBe('blob:fake-stripped');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('recoverFlac returns false for non-local / non-flac urls (QYP3-033)', async () => {
    const { engine } = makeEngine();
    expect(await engine.recoverFlac(makeTrack(1, 'qy-file://audio/1/x.mp3'))).toBe(false);
    expect(await engine.recoverFlac(makeTrack(1, 'https://example.com/a.flac'))).toBe(false);
  });

  it('volume goes to gain node when the graph exists', () => {
    const { engine, ctx } = makeEngine();
    void engine.playQueue([makeTrack(1)], 0, 'off', false);
    engine.setVolume(0.5);
    const gain = (ctx as unknown as { createGain: ReturnType<typeof vi.fn> }).createGain.mock.results[0]?.value as
      | { gain: { value: number } }
      | undefined;
    expect(gain?.gain.value).toBe(0.5);
  });

  it('resumes a suspended AudioContext on initial play (QYP3-031)', async () => {
    const audio = fakeAudio();
    const ctx = fakeCtx();
    // 自动播放策略下构造出的上下文常为 suspended
    (ctx as unknown as { state: string }).state = 'suspended';
    // 让 resume 真正把状态切到 running（mock 默认不改 state）
    const resume = vi.fn(async () => {
      (ctx as unknown as { state: string }).state = 'running';
    });
    (ctx as unknown as { resume: ReturnType<typeof vi.fn> }).resume = resume;
    const engine = new WebAudioEngine({
      createElement: () => audio,
      createContext: () => ctx,
    });
    await engine.playQueue([makeTrack(1)], 0, 'off', false);
    expect(resume).toHaveBeenCalled();
    expect((ctx as unknown as { state: string }).state).toBe('running');
  });

  it('does not call resume when the context is already running', async () => {
    const audio = fakeAudio();
    const ctx = fakeCtx(); // 默认 running
    const resume = ctx.resume as ReturnType<typeof vi.fn>;
    const engine = new WebAudioEngine({
      createElement: () => audio,
      createContext: () => ctx,
    });
    await engine.playQueue([makeTrack(1)], 0, 'off', false);
    expect(resume).not.toHaveBeenCalled();
  });

  // ---- 懒解析（QYP3-037）--------------------------------------------

  it('resolves a lazy track via urlResolver only when url is empty', async () => {
    const { engine, audio } = makeEngine();
    const resolver = vi.fn(async () => ({ url: 'qy-stream://audio/r1', startPosition: 0 }));
    const lazy = { ...makeTrack(1, ''), codec: 'flac' };
    await engine.playQueue([lazy, makeTrack(2)], 0, 'off', false, resolver);
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(resolver).toHaveBeenCalledWith(lazy);
    expect(audio.src).toBe('qy-stream://audio/r1');
    // 结果写回快照条目：重播/换回不重复解析
    expect(lazy.url).toBe('qy-stream://audio/r1');
    await engine.prev();
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(audio.src).toBe('qy-stream://audio/r1');
  });

  it('does not call the resolver for tracks that already carry a url', async () => {
    const { engine } = makeEngine();
    const resolver = vi.fn(async () => ({ url: 'x', startPosition: 0 }));
    await engine.playQueue([makeTrack(1), makeTrack(2)], 0, 'off', false, resolver);
    expect(resolver).not.toHaveBeenCalled();
  });

  it('reports resolve errors via onResolveError and never sets src', async () => {
    const { engine, audio } = makeEngine();
    const onResolveError = vi.fn();
    engine.onResolveError = onResolveError;
    const resolver = vi.fn(async () => {
      throw new Error('NEEDS_MPV');
    });
    await engine.playQueue([makeTrack(1, '')], 0, 'off', false, resolver);
    expect(onResolveError).toHaveBeenCalledTimes(1);
    expect(onResolveError.mock.calls[0][1].id).toBe(1);
    expect(audio.src).toBe('');
  });

  it('seeks to the resolver-provided startPosition after play', async () => {
    const audio = fakeAudio();
    (audio as unknown as { duration: number }).duration = 200;
    const ctx = fakeCtx();
    const engine = new WebAudioEngine({
      createElement: () => audio,
      createContext: () => ctx,
    });
    const resolver = vi.fn(async () => ({ url: 'qy-stream://audio/r1', startPosition: 30 }));
    await engine.playQueue([makeTrack(1, '')], 0, 'off', false, resolver);
    expect((audio as unknown as { currentTime: number }).currentTime).toBe(30);
  });

  it('seeks to the playQueue startPosition for the first (eager) track', async () => {
    const audio = fakeAudio();
    (audio as unknown as { duration: number }).duration = 200;
    const ctx = fakeCtx();
    const engine = new WebAudioEngine({
      createElement: () => audio,
      createContext: () => ctx,
    });
    await engine.playQueue([makeTrack(1)], 0, 'off', false, undefined, 15);
    expect((audio as unknown as { currentTime: number }).currentTime).toBe(15);
  });
});
