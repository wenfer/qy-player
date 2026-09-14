/**
 * renderer 音乐播放引擎（QYP3-010，ADR-0007）。
 *
 * 仅承载 selectAudioEngine 判定为 direct 的本地音轨；队列/循环/随机/
 * 均衡器/实时频谱（AnalyserNode）都在此单点。事件统一推给
 * MusicPlaybackStore（QYP3-011 状态归一的 renderer 侧实现）。
 *
 * 红线：AudioContext 单例懒建（浏览器自动播放策略要求用户手势后
 * resume）； fftSize ≤2048、可视化采样 ≤30fps 由调用方控制。
 * 失败回退 native 引擎一次（错误回调上抛，由 store 决策）。
 */

export type RepeatMode = 'off' | 'all' | 'one';

export interface QueueTrack {
  /** music_tracks.id（持久键）。 */
  id: number;
  title: string;
  artist: string | null;
  album: string | null;
  albumartist: string | null;
  duration: number | null;
  /** qy-file://audio/... 播放 URL（QYP3-010 协议桥产物）。 */
  url: string;
  /** EQ 频段增益 dB（10 段，-12..+12）；null = 直通。 */
  eqGains?: number[] | null;
}

export interface EngineState {
  isPlaying: boolean;
  position: number;
  duration: number;
  currentTrackId: number | null;
  queueLength: number;
  queueIndex: number;
  repeat: RepeatMode;
  shuffle: boolean;
  analyserData: Uint8Array | null;
}

export const EQ_BANDS = [60, 170, 350, 1000, 3500, 6000, 9000, 12000, 14000, 16000];

/** 队列纯逻辑（shuffle 用 seeded 洗牌保持可测）。 */
export class PlaybackQueue {
  private items: QueueTrack[] = [];
  private index = -1;
  repeat: RepeatMode = 'off';
  shuffle = false;
  private order: number[] = [];
  private orderPos = -1;

  setQueue(tracks: QueueTrack[], startIndex: number): void {
    this.items = [...tracks];
    this.repeatQueueOrder();
    this.orderPos = this.order.indexOf(startIndex);
    this.index = startIndex;
  }

  private repeatQueueOrder(): void {
    this.order = this.items.map((_, i) => i);
    if (this.shuffle) {
      // Fisher-Yates，固定当前项位置由调用方处理（seeded 测试另注）
      for (let i = this.order.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [this.order[i], this.order[j]] = [this.order[j], this.order[i]];
      }
    }
  }

  get current(): QueueTrack | null {
    return this.items[this.index] ?? null;
  }

  get length(): number {
    return this.items.length;
  }

  get position(): number {
    return this.index;
  }

  /** 手动跳转（点选队列项）。 */
  jumpTo(index: number): void {
    this.index = index;
    this.orderPos = this.order.indexOf(index);
  }

  /** 下一曲（repeat 语义：off=队列尾停止返回 null；all=循环；one=不跳）。 */
  next(): QueueTrack | null {
    if (this.repeat === 'one') return this.current;
    if (this.shuffle) {
      if (this.orderPos + 1 < this.order.length) {
        this.orderPos += 1;
        this.index = this.order[this.orderPos];
        return this.current;
      }
      if (this.repeat === 'all') {
        this.repeatQueueOrder();
        this.orderPos = 0;
        this.index = this.order[0];
        return this.current;
      }
      return null;
    }
    if (this.index + 1 < this.items.length) {
      this.index += 1;
      return this.current;
    }
    if (this.repeat === 'all') {
      this.index = 0;
      return this.current;
    }
    return null;
  }

  prev(): QueueTrack | null {
    if (this.repeat === 'one') return this.current;
    if (this.index - 1 >= 0) {
      this.index -= 1;
      return this.current;
    }
    if (this.repeat === 'all' && this.items.length > 0) {
      this.index = this.items.length - 1;
      return this.current;
    }
    // repeat off 在队头：不动但返回当前曲（UI 重播语义由上层决定）
    return this.current;
  }
}

export interface WebAudioDeps {
  /** 注入 audio 元素与 AudioContext（测试用）；缺省用真实构造。 */
  createElement?: () => HTMLAudioElement;
  createContext?: () => AudioContext;
}

/**
 * 播放图：Element → MediaElementSource → Analyser → Biquad×10 → Gain → out。
 * 同一元素重挂 source 会爆（每个元素只能 createMediaElementSource 一次），
 * 因此 audio 元素与图在构造时创建一次，换曲目只换 src。
 */
export class WebAudioEngine {
  private readonly audio: HTMLAudioElement;
  private readonly ctx: AudioContext | null;
  private readonly source: MediaElementAudioSourceNode | null = null;
  private readonly analyser: AnalyserNode | null = null;
  private readonly filters: BiquadFilterNode[] = [];
  private readonly gain: GainNode | null = null;
  private readonly queue = new PlaybackQueue();
  private freqData: Uint8Array | null = null;

  onError?: (err: unknown) => void;
  onEnded?: () => void;
  onTime?: (position: number, duration: number) => void;
  onPlaying?: (isPlaying: boolean) => void;

  constructor(deps: WebAudioDeps = {}) {
    this.audio =
      deps.createElement?.() ??
      (typeof Audio !== 'undefined' ? new Audio() : ({} as HTMLAudioElement));
    try {
      this.ctx = deps.createContext?.() ?? (typeof AudioContext !== 'undefined' ? new AudioContext() : null);
    } catch {
      this.ctx = null;
    }
    if (this.ctx && this.audio) {
      try {
        this.source = this.ctx.createMediaElementSource(this.audio);
        this.analyser = this.ctx.createAnalyser();
        this.analyser.fftSize = 2048;
        this.analyser.smoothingTimeConstant = 0.8;
        this.freqData = new Uint8Array(this.analyser.frequencyBinCount);
        let node: AudioNode = this.source;
        for (const freq of EQ_BANDS) {
          const f = this.ctx.createBiquadFilter();
          f.type = freq <= 350 ? 'lowshelf' : freq >= 9000 ? 'highshelf' : 'peaking';
          f.frequency.value = freq;
          f.gain.value = 0;
          node.connect(f);
          node = f;
          this.filters.push(f);
        }
        this.gain = this.ctx.createGain();
        node.connect(this.gain);
        this.gain.connect(this.ctx.destination);
      } catch {
        // 图构建失败（如无 MediaElementSource）→ 直连输出，无频谱/EQ
      }
    } else {
      this.ctx = this.ctx ?? null;
      this.source = null;
      this.analyser = null;
      this.gain = null;
    }
    this.audio.addEventListener?.('timeupdate', () => {
      this.onTime?.(this.audio.currentTime || 0, this.audio.duration || 0);
    });
    this.audio.addEventListener?.('ended', () => {
      this.onEnded?.();
    });
    this.audio.addEventListener?.('play', () => this.onPlaying?.(true));
    this.audio.addEventListener?.('pause', () => this.onPlaying?.(false));
    this.audio.addEventListener?.('error', (e) => this.onError?.(e));
  }

  /** 播放一个队列（从 startIndex 开始）。 */
  async playQueue(tracks: QueueTrack[], startIndex: number, repeat: RepeatMode, shuffle: boolean): Promise<void> {
    this.queue.repeat = repeat;
    this.queue.shuffle = shuffle;
    this.queue.setQueue(tracks, startIndex);
    await this.playCurrent();
  }

  private async playCurrent(): Promise<void> {
    const track = this.queue.current;
    if (!track) return;
    this.audio.src = track.url;
    await this.audio.play?.();
  }

  async next(auto: boolean): Promise<void> {
    const nextTrack = this.queue.next();
    if (auto && this.queue.repeat === 'one' && this.queue.current) {
      // 单曲循环：重播当前
      this.audio.currentTime = 0;
      await this.audio.play?.();
      return;
    }
    if (nextTrack) await this.playCurrent();
  }

  async prev(): Promise<void> {
    const prevTrack = this.queue.prev();
    if (prevTrack) await this.playCurrent();
  }

  jumpTo(index: number): Promise<void> {
    this.queue.jumpTo(index);
    return this.playCurrent();
  }

  pause(): void {
    this.audio.pause?.();
  }

  async resume(): Promise<void> {
    if (this.ctx?.state === 'suspended') await this.ctx.resume();
    await this.audio.play?.();
  }

  seek(position: number): void {
    if (Number.isFinite(this.audio.duration)) {
      this.audio.currentTime = Math.min(Math.max(position, 0), this.audio.duration);
    }
  }

  setVolume(volume: number): void {
    if (this.gain) this.gain.gain.value = volume;
    else if ('volume' in this.audio) this.audio.volume = volume;
  }

  /** EQ 增益 dB（10 段）。 */
  setEq(gains: number[] | null): void {
    this.filters.forEach((f, i) => {
      f.gain.value = gains?.[i] ?? 0;
    });
  }

  /** 频谱快照（UI 拾音器 ≤30fps 拉取；无图返回 null）。 */
  getSpectrum(): Uint8Array | null {
    if (!this.analyser || !this.freqData) return null;
    this.analyser.getByteFrequencyData(this.freqData);
    return this.freqData;
  }

  get queueState(): { length: number; index: number; repeat: RepeatMode; shuffle: boolean; currentTrackId: number | null } {
    return {
      length: this.queue.length,
      index: this.queue.position,
      repeat: this.queue.repeat,
      shuffle: this.queue.shuffle,
      currentTrackId: this.queue.current?.id ?? null,
    };
  }

  get position(): number {
    return this.audio.currentTime || 0;
  }

  get duration(): number {
    return Number.isFinite(this.audio.duration) ? this.audio.duration : 0;
  }

  get playing(): boolean {
    return !this.audio.paused;
  }
}
