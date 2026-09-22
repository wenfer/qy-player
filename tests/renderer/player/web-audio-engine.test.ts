// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { PlaybackQueue, WebAudioEngine, type QueueTrack } from '../../../src/renderer/player/web-audio-engine';
import {
  AUDIO_FX_DEFAULT,
  AUDIO_FX_MAX_BANDS,
} from '../../../src/main/modules/playback-engine/audio-fx';

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

/**
 * 假 AudioContext 的节点工厂（QYP3-068v 收敛成单一来源）。
 *
 * 引擎构造里的图构建被外层 `catch {}` **静默吞掉** —— 缺任何一个节点工厂
 * 都会让整张图直接降级（无频谱、无 EQ、无音效）却不报错。这份 stub 以前
 * 抄了三份，加节点漏改一处就静默失效，所以现在统一从这里取。
 */
function fakeNodeFactories(): Record<string, () => unknown> {
  const raw: Record<string, () => unknown> = {
    createMediaElementSource: () => ({ connect: vi.fn() }),
    createAnalyser: () => ({
      fftSize: 2048,
      smoothingTimeConstant: 0,
      frequencyBinCount: 1024,
      getByteFrequencyData: (arr: Uint8Array) => arr.fill(7),
      getByteTimeDomainData: (arr: Uint8Array) => arr.fill(128),
      connect: vi.fn(),
    }),
    createBiquadFilter: () => ({
      type: '',
      frequency: { value: 0 },
      Q: { value: 1 },
      gain: { value: 0 },
      connect: vi.fn(),
    }),
    createGain: () => ({ gain: { value: 1 }, connect: vi.fn() }),
    createChannelSplitter: () => ({ connect: vi.fn() }),
    createChannelMerger: () => ({ channelCount: 2, channelCountMode: 'explicit', connect: vi.fn() }),
    createWaveShaper: () => ({ curve: null, oversample: 'none', connect: vi.fn() }),
  };
  // 用 vi.fn 包装：部分用例要靠 mock.results 取回建好的节点
  const wrapped: Record<string, () => unknown> = {};
  for (const [key, fn] of Object.entries(raw)) wrapped[key] = vi.fn(fn);
  return wrapped;
}

function fakeCtx(overrides: Record<string, unknown> = {}): AudioContext {
  return {
    state: 'running',
    ...fakeNodeFactories(),
    destination: {},
    resume: vi.fn(async () => undefined),
    ...overrides,
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

  it('setShuffle re-orders a live queue instead of walking it in order (QYP3-068t)', () => {
    const q = new PlaybackQueue();
    // 固定随机源：让洗牌结果可预测（Fisher-Yates 每次取 0 号位交换）
    const rand = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      q.setQueue([makeTrack(1), makeTrack(2), makeTrack(3), makeTrack(4)], 0);
      q.setShuffle(true);
      // 当前曲仍是第 1 首，但后续顺序不再是 2,3,4
      expect(q.current?.id).toBe(1);
      const seen = [q.next()?.id, q.next()?.id, q.next()?.id];
      expect(new Set(seen).size).toBe(3); // 一轮之内不重复
      expect(seen).not.toEqual([2, 3, 4]);
    } finally {
      rand.mockRestore();
    }
  });

  it('setShuffle(false) puts next() back on the sequential order', () => {
    const q = new PlaybackQueue();
    q.shuffle = true;
    q.setQueue([makeTrack(1), makeTrack(2), makeTrack(3)], 0);
    q.setShuffle(false);
    expect(q.next()?.id).toBe(2);
    expect(q.next()?.id).toBe(3);
  });
});

/** 会记录连线的假上下文：用来钉住"analyser 必须在链路上"。 */
function fakeCtxWithEdges(): { ctx: AudioContext; edges: string[] } {
  const edges: string[] = [];
  const node = (label: string, extra: Record<string, unknown> = {}): Record<string, unknown> => {
    const n: Record<string, unknown> = { label, ...extra };
    // 引擎会传 (dest, output, input)，后两个参数这里不关心
    n.connect = (target: unknown): void => {
      edges.push(`${label}->${(target as { label?: string } | undefined)?.label ?? 'destination'}`);
    };
    return n;
  };
  const ctx = {
    state: 'running',
    createMediaElementSource: () => node('source'),
    createAnalyser: () =>
      node('analyser', {
        fftSize: 2048,
        smoothingTimeConstant: 0,
        frequencyBinCount: 1024,
        getByteFrequencyData: (arr: Uint8Array) => arr.fill(7),
        getByteTimeDomainData: (arr: Uint8Array) => arr.fill(128),
      }),
    createBiquadFilter: () => node('filter', { type: '', frequency: { value: 0 }, Q: { value: 1 }, gain: { value: 0 } }),
    createGain: () => node('gain', { gain: { value: 1 } }),
    createChannelSplitter: () => node('splitter'),
    createChannelMerger: () => node('merger', { channelCount: 2, channelCountMode: 'explicit' }),
    createWaveShaper: () => node('shaper', { curve: null, oversample: 'none' }),
    destination: { label: 'destination' },
    resume: vi.fn(async () => undefined),
  };
  return { ctx: ctx as unknown as AudioContext, edges };
}

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

  it('connects the analyser into the graph (QYP3-045): 悬空的 analyser 只读到静音', () => {
    const { ctx, edges } = fakeCtxWithEdges();
    const engine = new WebAudioEngine({
      createElement: () => fakeAudio(),
      createContext: () => ctx,
    });
    void engine.playQueue([makeTrack(1)], 0, 'off', false);
    // 取样点是链路第一跳；绕过它（source 直连 filter）频谱就恒为全 0
    expect(edges[0]).toBe('source->analyser');
    expect(edges.at(-1)).toBe('gain->destination');
    expect(edges).not.toContain('source->filter');
    // QYP3-068v：analyser 之后是 preamp（gain）再进 EQ —— 取样点在 EQ 之前
    // （离线频谱本来就是对原始 PCM 做的，语义是"源信号监视器"）
    expect(edges[1]).toBe('analyser->gain');
    expect(edges[2]).toBe('gain->filter');
    // 10 段 EQ 串在 preamp 之后
    expect(edges.filter((e) => e === 'filter->filter')).toHaveLength(9);
    // 声场矩阵与交叉馈送分流后再合流，末端是削波保护
    expect(edges).toContain('filter->splitter');
    expect(edges).toContain('merger->shaper');
    expect(edges).toContain('shaper->gain');
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

  it('setAudioFx writes parametric bands (freq/Q/gain) across the filters', () => {
    const { engine } = makeEngine();
    void engine.playQueue([makeTrack(1)], 0, 'off', false);
    const filters = (engine as unknown as { filters: Array<{ type: string; frequency: { value: number }; Q: { value: number }; gain: { value: number } }> }).filters;
    expect(filters).toHaveLength(AUDIO_FX_MAX_BANDS);
    engine.setAudioFx({
      ...AUDIO_FX_DEFAULT,
      eq: {
        enabled: true,
        preamp: 0,
        bands: [
          { freq: 120, gain: 5, q: 1.1, type: 'lowshelf' },
          { freq: 3000, gain: -4, q: 2.5, type: 'peaking' },
        ],
      },
    });
    expect(filters[0]).toMatchObject({ type: 'lowshelf', gain: { value: 5 } });
    expect(filters[0].frequency.value).toBe(120);
    expect(filters[0].Q.value).toBe(1.1);
    expect(filters[1]).toMatchObject({ type: 'peaking', gain: { value: -4 } });
    // 未配置的段必须直通（否则会留着上一次的增益）
    expect(filters[2].gain.value).toBe(0);
    expect(filters[9].gain.value).toBe(0);
    // 通过 spectrum 探针确认 analyser 存在（fake 全 bin 填 7 → 分带后每带峰值 7）
    const spectrum = engine.getSpectrum();
    expect(spectrum).not.toBeNull();
    expect(spectrum![0]).toBe(7);
  });

  it('setAudioFx returns every stage to unity when disabled (QYP3-068v)', () => {
    const { engine } = makeEngine();
    void engine.playQueue([makeTrack(1)], 0, 'off', false);
    const inner = engine as unknown as {
      preamp: { gain: { value: number } } | null;
      filters: Array<{ gain: { value: number } }>;
      fieldMatrix: Array<{ gain: { value: number } }>;
      crossGains: Array<{ gain: { value: number } }>;
      shaper: { curve: Float32Array | null } | null;
    };
    engine.setAudioFx({
      enabled: true,
      eq: { enabled: true, preamp: 6, bands: [{ freq: 100, gain: 9, q: 1, type: 'peaking' }] },
      limiter: { enabled: true, ceiling: -1 },
      width: 2,
      balance: 0.5,
      crossfeed: 1,
    });
    expect(inner.preamp!.gain.value).toBeGreaterThan(1);
    expect(inner.fieldMatrix[0].gain.value).not.toBe(1);
    expect(inner.shaper!.curve).not.toBeNull();

    // 关掉总开关 → 每一级都必须回到恒等（节点常驻，只能靠参数归位）
    engine.setAudioFx({ ...AUDIO_FX_DEFAULT, enabled: false });
    expect(inner.preamp!.gain.value).toBe(1);
    expect(inner.filters.every((f) => f.gain.value === 0)).toBe(true);
    expect(inner.fieldMatrix.map((g) => g.gain.value)).toEqual([1, 0, 0, 1]);
    expect(inner.crossGains.every((g) => g.gain.value === 0)).toBe(true);
    expect(inner.shaper!.curve).toBeNull();
  });

  it('soft-clip curve never exceeds full scale (QYP3-068v)', () => {
    const { engine } = makeEngine();
    void engine.playQueue([makeTrack(1)], 0, 'off', false);
    const shaper = (engine as unknown as { shaper: { curve: Float32Array | null } }).shaper;
    engine.setAudioFx({ ...AUDIO_FX_DEFAULT, limiter: { enabled: true, ceiling: -1 } });
    const curve = shaper.curve!;
    expect(curve).not.toBeNull();
    // 抬满也不能越过 0dBFS，否则就是硬削波
    for (const y of curve) expect(Math.abs(y)).toBeLessThan(1);
    // 阈值以下必须严格线性（不能把小信号也压了）
    const limit = Math.pow(10, -1 / 20);
    const mid = curve[Math.floor(((limit * 0.5 + 1) / 2) * (curve.length - 1))];
    expect(Math.abs(mid - limit * 0.5)).toBeLessThan(0.02);
  });

  it('stub factories cover every node the graph builds (missing one silently degrades)', () => {
    // 图构建失败被 catch 吞掉，缺 factory 不会报错只会整张图消失
    expect(Object.keys(fakeNodeFactories()).sort()).toEqual(
      [
        'createAnalyser',
        'createBiquadFilter',
        'createChannelMerger',
        'createChannelSplitter',
        'createGain',
        'createMediaElementSource',
        'createWaveShaper',
      ].sort()
    );
  });

  it('spectrum is log-banded (QYP3-057): bass gets few bins, mids get many', () => {
    // 独立 fake：sampleRate 44100、按 bin 下标放两个标记音
    // binHz = 44100/2048 ≈ 21.53Hz。bin 2 ≈ 43Hz（第 0 带 40~43.4Hz）；
    // bin 300 ≈ 6.46kHz（第 61 带 6.24~6.82kHz）
    const byBin = (arr: Uint8Array): void => {
      for (let i = 0; i < arr.length; i += 1) arr[i] = i === 2 ? 200 : i === 300 ? 150 : 0;
    };
    const engine = new WebAudioEngine({
      createElement: () => fakeAudio(),
      // 复用同一份节点工厂，只覆盖 sampleRate 与 analyser 的数据填充
      createContext: () =>
        fakeCtx({
          sampleRate: 44100,
          createAnalyser: () => ({
            fftSize: 2048,
            smoothingTimeConstant: 0,
            frequencyBinCount: 1024,
            getByteFrequencyData: byBin,
            getByteTimeDomainData: (arr: Uint8Array) => arr.fill(128),
            connect: vi.fn(),
          }),
        }),
    });
    void engine.playQueue([makeTrack(1)], 0, 'off', false);
    const spectrum = engine.getSpectrum();
    expect(spectrum).not.toBeNull();
    expect(spectrum!.length).toBe(64); // 对数分带数（与画图方解耦）
    expect(spectrum![0]).toBe(200); // bin 2 落在第 0 带
    expect(spectrum![61]).toBe(150); // bin 300 落在第 61 带
    expect(spectrum![63]).toBe(0); // 8kHz 以上没有能量
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

  it('volume goes to the output gain node when the graph exists', () => {
    const { engine, ctx } = makeEngine();
    void engine.playQueue([makeTrack(1)], 0, 'off', false);
    engine.setVolume(0.5);
    // QYP3-068v：图里现在有多个 gain（preamp / 声场矩阵 / 交叉馈送），
    // 音量是**最后一个**（削波保护之后、destination 之前）
    const gains = (ctx as unknown as { createGain: ReturnType<typeof vi.fn> }).createGain.mock.results.map(
      (r) => r.value as { gain: { value: number } }
    );
    expect(gains.length).toBeGreaterThan(1);
    expect(gains.at(-1)?.gain.value).toBe(0.5);
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

  // ---- 懒解析期间的起播让位（QYP3-067：双播修复）----------------------

  it('discards a stale lazy resolution when the queue moved on during resolve', async () => {
    const { engine, audio } = makeEngine();
    let resolveFirst!: (v: { url: string; startPosition: number }) => void;
    const resolver = vi.fn(
      () => new Promise<{ url: string; startPosition: number }>((res) => { resolveFirst = res; })
    );
    const lazy = makeTrack(1, '');
    const pending = engine.playQueue([lazy, makeTrack(2)], 0, 'off', false, resolver);
    // playCurrent 同步推进到 resolver await：此时换曲
    await engine.jumpTo(1);
    expect(audio.src).toBe('qy-file://audio/1/2.mp3');
    // 旧解析这时才回来：必须让位——不覆盖 src、不再 play（否则双响）
    resolveFirst({ url: 'qy-stream://audio/stale', startPosition: 0 });
    await pending;
    expect(audio.src).toBe('qy-file://audio/1/2.mp3');
    expect(audio.play).toHaveBeenCalledTimes(1);
  });

  it('swallows a play() rejection superseded by a newer start (abort is expected)', async () => {
    const { engine, audio } = makeEngine();
    let calls = 0;
    let rejectFirst!: (e: unknown) => void;
    (audio as unknown as { play: () => Promise<void> }).play = vi.fn(() => {
      calls += 1;
      if (calls === 1) {
        return new Promise<void>((_res, rej) => { rejectFirst = rej; });
      }
      return Promise.resolve();
    }) as unknown as FakeAudio['play'];
    const pending = engine.playQueue([makeTrack(1), makeTrack(2)], 0, 'off', false);
    await engine.jumpTo(1); // 换 src → 旧 play() 将以 abort 类错误拒绝
    rejectFirst(new Error('The play() request was interrupted by a new load request'));
    // 旧起播的 rejection 不能沿调用链把"换曲"报成"播放失败"
    await expect(pending).resolves.toBeUndefined();
    expect(audio.src).toBe('qy-file://audio/1/2.mp3');
  });
});
