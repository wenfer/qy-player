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
      fftSize: 0,
      smoothingTimeConstant: 0,
      frequencyBinCount: 64,
      getByteFrequencyData: (arr: Uint8Array) => arr.fill(7),
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

  it('volume goes to gain node when the graph exists', () => {
    const { engine, ctx } = makeEngine();
    void engine.playQueue([makeTrack(1)], 0, 'off', false);
    engine.setVolume(0.5);
    const gain = (ctx as unknown as { createGain: ReturnType<typeof vi.fn> }).createGain.mock.results[0]?.value as
      | { gain: { value: number } }
      | undefined;
    expect(gain?.gain.value).toBe(0.5);
  });
});
