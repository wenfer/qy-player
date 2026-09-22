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

import { isFlacUrl, stripFlacPicture } from './flac-strip';
// 与 mpv 离线频谱同一套对数分带数学（pcm-fft 是纯计算模块，无 IO 无依赖）
import { bandBinRanges } from '../../main/modules/music-spectrum/pcm-fft';
// 音效契约为两个引擎共用（纯计算，无 IO）；`t=q` 的 w 就是这里的 Q
import {
  AUDIO_FX_MAX_BANDS,
  EQ_DEFAULT_FREQS,
  EQ_DEFAULT_Q,
  widthBalanceMatrix,
  type AudioFxSettings,
} from '../../main/modules/playback-engine/audio-fx';

/**
 * 交叉馈送的低通截止（Hz）。真正的 Bauer 还需要 ~300μs 的延迟网络，而
 * Web Audio 的 DelayNode 最小是一个渲染量子（128 样本 ≈ 2.9ms @44.1k），
 * 做出来会是梳状染色而不是交叉馈送 —— 所以这里**只做低通混音**：它是
 * crossfeed 的近似，只有 mpv 侧的 `crossfeed` 滤镜才是完整实现。
 */
const CROSSFEED_LP_HZ = 2500;
/** 交叉馈送强度 1.0 时的混入量（≈ -9dB，接近 Bauer 的量级）。 */
const CROSSFEED_MAX_MIX = 0.35;

const curveCache = new Map<string, Float32Array>();

/**
 * 削波保护曲线（QYP3-068v）。
 *
 * 阈值以下严格线性（不动一丝 tipsy），阈值以上用 tanh 把余量压掉：
 *   |x| ≤ t      → y = x
 *   |x| >  t     → y = t + (1-t)·tanh((|x|-t)/(1-t))·sign(x)
 * 因此输出恒 < 1 —— 抬了 EQ 也不会硬削波。
 *
 * 这是**无记忆软削波**，不是 lookahead 限幅器（那个要到 DelayNode 做前瞻，
 * 成本与复杂度都不划算），所以 UI 文案叫「削波保护」而不是「限幅器」。
 * 按 ceiling 缓存：拖滑块时不必每帧重算 2048 点。
 */
function softClipCurve(ceilingDb: number): Float32Array {
  const key = ceilingDb.toFixed(1);
  const cached = curveCache.get(key);
  if (cached) return cached;
  const limit = Math.pow(10, Math.max(-6, Math.min(0, ceilingDb)) / 20);
  const n = 2048;
  const curve = new Float32Array(n);
  const remainder = 1 - limit;
  for (let i = 0; i < n; i += 1) {
    const x = (i / (n - 1)) * 2 - 1; // [-1, 1]
    const ax = Math.abs(x);
    const y = ax <= limit ? ax : limit + remainder * Math.tanh((ax - limit) / remainder);
    curve[i] = Math.sign(x) * y;
  }
  curveCache.set(key, curve);
  return curve;
}

export type RepeatMode = 'off' | 'all' | 'one';

export interface QueueTrack {
  /** music_tracks.id（持久键）；服务器曲目用负数合成 id（见 store）。 */
  id: number;
  title: string;
  artist: string | null;
  album: string | null;
  albumartist: string | null;
  duration: number | null;
  /**
   * 播放 URL：`qy-file://audio/...`（本地）、`qy-stream://audio/<id>`
   * （服务器/WebDAV 代理，QYP3-037）或 blob:（FLAC 自救）。
   * 允许为空串：配合 urlResolver 按需解析（服务器整队预解析是 N 次网络请求）。
   */
  url: string;
  /** EQ 频段增益 dB（10 段，-12..+12）；null = 直通。 */
  eqGains?: number[] | null;
  /** 编解码（flac 等小写扩展名）；FLAC 封面自救的判定依据之一。 */
  codec?: string | null;
}

/**
 * 按需解析单曲播放地址（QYP3-037）：返回真实可播 URL 与续播位置；
 * 抛错 = 解析失败（由 onResolveError 交给上层兜底）。
 */
export type TrackUrlResolver = (
  track: QueueTrack
) => Promise<{ url: string; startPosition: number }>;

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

  /**
   * 会话中开/关随机（QYP3-068t）：`shuffle` 是**队列字段**，光改字段不够——
   * 播放顺序 `order` 是建队时排好的，不开关都得重排一次，否则"随机"只是把
   * 顺序播放的 order 原样走一遍。当前曲作为分界点：开随机时把它换到 order
   * 队首（下一首从随机序里挑），关随机时把 orderPos 拨回原位索引。
   */
  setShuffle(on: boolean): void {
    if (this.shuffle === on) return;
    this.shuffle = on;
    const current = this.index;
    this.repeatQueueOrder();
    if (on) {
      const at = this.order.indexOf(current);
      if (at > 0) [this.order[0], this.order[at]] = [this.order[at], this.order[0]];
    }
    this.orderPos = this.order.indexOf(current);
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
 * 播放图（QYP3-068v 扩展）：
 *
 *   Element → MediaElementSource → Analyser → preampGain → EQ×10
 *           → 声场矩阵（宽度+平衡）→ 交叉馈送 → shaper（削波保护）
 *           → Gain（音量）→ out
 *
 * 同一元素重挂 source 会爆（每个元素只能 createMediaElementSource 一次），
 * 因此 audio 元素与图在构造时创建一次，换曲目只换 src。
 *
 * **所有音效节点都在构造时一次性建好并常驻**：引擎实例进程内永不销毁
 * （没有 dispose / ctx.close），所以"开关某个效果"只能表现为**参数归直通
 * 值**——绝不能靠 disconnect 重连：重连必爆 click，而且矩阵分支一变，
 * 尾部连线也就跟着变了。直通也要留意：Biquad peak gain=0 / 单位矩阵 /
 * crossGain=0 / curve=null 各自才是恒等。
 *
 * Analyser 的取样点在 EQ **之前**：离线频谱（pcm-fft）本来就是对解码后
 * 原始 PCM 做的，语义是"源信号监视器"。移到 EQ 之后会让 mpv 侧（永远只
 * 反映源信号）和这里不一致。
 */
export class WebAudioEngine {
  private readonly audio: HTMLAudioElement;
  private readonly ctx: AudioContext | null;
  private readonly source: MediaElementAudioSourceNode | null = null;
  private readonly analyser: AnalyserNode | null = null;
  private readonly filters: BiquadFilterNode[] = [];
  private readonly gain: GainNode | null = null;
  /** 输入增益（preamp）：在 EQ 之前衰减，才保得住 EQ 的精度。 */
  private readonly preamp: GainNode | null = null;
  /**
   * 声场矩阵（QYP3-068v）：宽度与平衡合并成 4 个增益，与 mpv 侧那条 `pan`
   * 数学完全一致（见 `widthBalanceMatrix`）。顺序 [L→L', R→L', L→R', R→R']。
   */
  private readonly fieldMatrix: GainNode[] = [];
  /** 交叉馈送的两条声道低通（约 2.5kHz）。 */
  private readonly crossFilters: BiquadFilterNode[] = [];
  /** 交叉馈送的混入量增益：0 = 关闭。 */
  private readonly crossGains: GainNode[] = [];
  /** 削波保护（QYP3-068v）：无记忆软削波，不是 lookahead 限幅器。 */
  private readonly shaper: WaveShaperNode | null = null;
  private readonly queue = new PlaybackQueue();
  private freqData: Uint8Array | null = null;
  /**
   * 对数分带后的频谱（QYP3-057）。AnalyserNode 的 bin 是 0~22kHz **线性**
   * 等宽的，音乐能量几乎全在低频——直接等宽下采样会让左边的柱子永远比
   * 右边活跃。这里按 40Hz~8kHz 对数分带取峰值（与 mpv 离线频谱同一套
   * `bandBinRanges`），两个引擎的频谱分布才一致。
   */
  private static readonly SPECTRUM_BANDS = 64;
  private bandedFreq: Uint8Array | null = null;
  private bandRanges: Int32Array | null = null;
  /** 时域波形缓冲（getByteTimeDomainData；fftSize 长度，值中心 128=静音）。 */
  private waveData: Uint8Array | null = null;
  /** 上次剥离封面生成的 blob URL，换曲/自救前释放，避免内存泄漏。 */
  private lastBlobUrl: string | null = null;

  /**
   * 解码失败（QYP3-068d）：带上引擎队列当前曲目。换曲窗口里引擎队列已
   * 前进、调用方的 store.current 还是上一首——按 store 识别会认领错曲。
   */
  onError?: (err: unknown, track?: QueueTrack) => void;
  onEnded?: () => void;
  onTime?: (position: number, duration: number) => void;
  onPlaying?: (isPlaying: boolean) => void;
  /** 懒解析失败（含 NEEDS_MPV）：上层决定回退 mpv（QYP3-037）。 */
  onResolveError?: (err: unknown, track: QueueTrack) => void;
  private urlResolver: TrackUrlResolver | null = null;
  /** playQueue 传入的首曲续播位置；playCurrent 起播后消费一次。 */
  private startAt = 0;
  /**
   * 起播代数（QYP3-067）：每次 playCurrent 递增。懒解析（服务器曲目一次
   * 网络请求，可达秒级）期间用户又点了新曲目/换了曲时，旧解析回来后
   * 必须让位——否则旧曲照常 play()，与新曲双响。
   */
  private loadSeq = 0;

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
        const analyser = this.ctx.createAnalyser();
        analyser.fftSize = 2048;
        analyser.smoothingTimeConstant = 0.8;
        this.analyser = analyser;
        this.freqData = new Uint8Array(analyser.frequencyBinCount);
        this.waveData = new Uint8Array(analyser.fftSize);
        // 对数分带边界（fake/测试环境没有 sampleRate 时按 44.1k 兜底）
        const sampleRate = this.ctx.sampleRate || 44100;
        this.bandRanges = bandBinRanges(
          sampleRate,
          analyser.fftSize,
          WebAudioEngine.SPECTRUM_BANDS,
          40,
          8000
        );
        this.bandedFreq = new Uint8Array(WebAudioEngine.SPECTRUM_BANDS);
        let node: AudioNode = this.source;
        // 取样点必须真的在链路上（QYP3-045 修复）：analyser 建了却没接进图时，
        // 它读的是静音——频域恒全 0、时域恒 128，可视化就一直画"无真实数据"
        // 的那条静态进度线（用户看到的就是一条直线）。
        node.connect(analyser);
        node = analyser;

        // ---- 输入增益（preamp）----
        this.preamp = this.ctx.createGain();
        this.preamp.gain.value = 1;
        node.connect(this.preamp);
        node = this.preamp;

        // ---- 参量 EQ（最多 AUDIO_FX_MAX_BANDS 段，常驻）----
        for (let i = 0; i < AUDIO_FX_MAX_BANDS; i += 1) {
          const f = this.ctx.createBiquadFilter();
          f.type = 'peaking';
          f.frequency.value = EQ_DEFAULT_FREQS[i] ?? 1000;
          f.Q.value = EQ_DEFAULT_Q;
          f.gain.value = 0; // 直通
          node.connect(f);
          node = f;
          this.filters.push(f);
        }

        // ---- 声场矩阵 + 交叉馈送（共用一个 splitter/merger 组）----
        // L' = a0·L + b0·R + crossR    R' = b1·L + a1·R + crossL
        const splitter = this.ctx.createChannelSplitter(2);
        const merger = this.ctx.createChannelMerger(2);
        // 不显式指定的话，mono 源会按 speaker 解释方式落到左声道
        merger.channelCount = 2;
        merger.channelCountMode = 'explicit';
        node.connect(splitter);
        // Web Audio 的 connect 是求和的：多条线汇到同一个输入就相加
        for (let i = 0; i < 4; i += 1) {
          const g = this.ctx.createGain();
          g.gain.value = i === 0 || i === 3 ? 1 : 0; // 单位矩阵
          this.fieldMatrix.push(g);
        }
        splitter.connect(this.fieldMatrix[0], 0); // L → L'
        splitter.connect(this.fieldMatrix[1], 1); // R → L'
        splitter.connect(this.fieldMatrix[2], 0); // L → R'
        splitter.connect(this.fieldMatrix[3], 1); // R → R'
        this.fieldMatrix[0].connect(merger, 0, 0);
        this.fieldMatrix[1].connect(merger, 0, 0);
        this.fieldMatrix[2].connect(merger, 0, 1);
        this.fieldMatrix[3].connect(merger, 0, 1);
        for (let ch = 0; ch < 2; ch += 1) {
          const lp = this.ctx.createBiquadFilter();
          lp.type = 'lowpass';
          lp.frequency.value = CROSSFEED_LP_HZ;
          lp.Q.value = 0.7;
          const g = this.ctx.createGain();
          g.gain.value = 0; // 关闭 = 不混入对侧
          splitter.connect(lp, ch);
          lp.connect(g);
          // 交叉：ch 0(L) 混进 R'，ch 1(R) 混进 L'
          g.connect(merger, 0, ch === 0 ? 1 : 0);
          this.crossFilters.push(lp);
          this.crossGains.push(g);
        }
        node = merger;

        // ---- 削波保护 ----
        this.shaper = this.ctx.createWaveShaper();
        this.shaper.oversample = 'none'; // 老机 CPU； working memory 是"软削波"
        node.connect(this.shaper);
        node = this.shaper;

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
    this.audio.addEventListener?.('error', (e) => this.onError?.(e, this.queue.current ?? undefined));
  }

  /**
   * 播放一个队列（从 startIndex 开始）。
   *
   * QYP3-037：urlResolver 提供时按需解析单曲 URL（服务器整队预解析是 N 次
   * 网络请求，不可接受）；startPosition 是首曲的续播位置（懒解析曲目的
   * 续播位置随解析结果返回）。
   */
  async playQueue(
    tracks: QueueTrack[],
    startIndex: number,
    repeat: RepeatMode,
    shuffle: boolean,
    urlResolver?: TrackUrlResolver,
    startPosition?: number
  ): Promise<void> {
    this.queue.repeat = repeat;
    this.queue.shuffle = shuffle;
    this.urlResolver = urlResolver ?? null;
    this.startAt = startPosition ?? 0;
    this.queue.setQueue(tracks, startIndex);
    await this.playCurrent();
  }

  private async playCurrent(): Promise<void> {
    const seq = ++this.loadSeq;
    const track = this.queue.current;
    if (!track) return;
    // 起播前必须确保 AudioContext 处于 running：构造时创建的上下文在浏览器
    // 自动播放策略下常为 suspended，且本调用不在用户手势的同步栈内
    // （playQueue 之前有 resolvePlayback 的 IPC await），若不主动 resume，
    // 整条图（source→analyser→…→destination）不运转——既听不到声音，
    // 拾音器 AnalyserNode 也只读到全 0，频谱静止。
    if (this.ctx && this.ctx.state === 'suspended') {
      try {
        await this.ctx.resume();
      } catch {
        // resume 失败不阻断换源；部分环境无声但可继续，交由上层处理
      }
    }
    // 释放上一次封面剥离生成的 blob（如有），避免随每次换曲堆积
    if (this.lastBlobUrl) {
      URL.revokeObjectURL(this.lastBlobUrl);
      this.lastBlobUrl = null;
    }
    // 懒解析：url 为空的曲目在起播前才解析；结果写回快照条目，重播/seek
    // 不再重复解析。失败交给上层（回退 mpv），这里不设 src。
    let startAt = this.startAt;
    this.startAt = 0;
    if (!track.url) {
      if (!this.urlResolver) return;
      try {
        const resolved = await this.urlResolver(track);
        // 解析期间队列已前进/重设（用户点了别的曲）：本次起播作废
        if (seq !== this.loadSeq) return;
        track.url = resolved.url;
        startAt = resolved.startPosition;
      } catch (err) {
        this.onResolveError?.(err, track);
        return;
      }
    }
    if (seq !== this.loadSeq) return;
    this.audio.src = track.url;
    try {
      await this.audio.play?.();
    } catch (err) {
      // play() 期间被更新的起播换掉 src：abort 类 rejection 属预期，
      // 不能沿调用链把"换曲"报成"播放失败"
      if (seq !== this.loadSeq) return;
      throw err;
    }
    // 续播位置：play() resolve 时元数据已可用；duration 未知则放弃（用户可手动 seek）
    if (startAt > 0 && Number.isFinite(this.audio.duration) && this.audio.duration > 0) {
      this.audio.currentTime = Math.min(startAt, this.audio.duration);
    }
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

  /**
   * 应用整条音效链（QYP3-068v）。会话中可随时调用（拖滑块即生效）。
   *
   * 节点全部常驻，所以"关"= 参数归直通值：
   *   preamp 1.0 / Biquad gain 0 / 单位矩阵 / crossGain 0 / curve null
   * 图构建失败（`this.gain === null`）时整体静默返回，沿用既有降级惯例。
   */
  setAudioFx(fx: AudioFxSettings | null): void {
    if (!this.gain || !this.preamp || !this.shaper) return;
    const active = fx !== null && fx.enabled;

    // ---- 输入增益 ----
    const preampDb = active && fx!.eq.enabled ? fx!.eq.preamp : 0;
    this.preamp.gain.value = Math.pow(10, preampDb / 20);

    // ---- 参量 EQ ----
    const bands = active && fx!.eq.enabled ? fx!.eq.bands : [];
    for (let i = 0; i < this.filters.length; i += 1) {
      const f = this.filters[i];
      const band = bands[i];
      if (!band) {
        f.gain.value = 0; // 段未启用 → 直通
        continue;
      }
      // 切换 type 会重置内部状态（可能引起轻微 artifact），只在真的变了才写
      if (f.type !== band.type) f.type = band.type;
      f.frequency.value = band.freq;
      f.Q.value = band.q;
      f.gain.value = band.gain;
    }

    // ---- 声场矩阵（宽度 + 平衡，与 mpv 的 pan 同一套数学）----
    const m = active ? widthBalanceMatrix(fx!.width, fx!.balance) : null;
    const [a0, b0, b1, a1] = m
      ? [m.a0, m.b0, m.b1, m.a1]
      : [1, 0, 0, 1]; // 单位矩阵 = 恒等
    if (this.fieldMatrix.length === 4) {
      this.fieldMatrix[0].gain.value = a0;
      this.fieldMatrix[1].gain.value = b0;
      this.fieldMatrix[2].gain.value = b1;
      this.fieldMatrix[3].gain.value = a1;
    }

    // ---- 交叉馈送（低通混音近似，非完整 Bauer）----
    const crossMix = active ? fx!.crossfeed * CROSSFEED_MAX_MIX : 0;
    for (const g of this.crossGains) g.gain.value = crossMix;

    // ---- 削波保护 ----
    this.shaper.curve = active && fx!.limiter.enabled ? softClipCurve(fx!.limiter.ceiling) : null;
  }


  /**
   * 频谱快照（UI 拾音器 ≤30fps 拉取；无图返回 null）。
   *
   * 返回的是**对数分带**后的峰值（QYP3-057）：40Hz~8kHz 均匀分布 64 带，
   * 每带取 bin 峰值（字节刻度不变，归一化仍由画图方做）。与 mpv 音源的
   * 离线频谱同一分布——两个引擎的柱状图左右能量分布一致。
   */
  getSpectrum(): Uint8Array | null {
    if (!this.analyser || !this.freqData) return null;
    this.analyser.getByteFrequencyData(this.freqData);
    return this.bandSpectrum();
  }

  /** 线性 bin → 对数频带峰值（每带取 max，与离线频谱的聚合方式一致）。 */
  private bandSpectrum(): Uint8Array {
    const raw = this.freqData;
    const ranges = this.bandRanges;
    const out = this.bandedFreq;
    if (!raw || !ranges || !out) return raw!;
    for (let b = 0; b < out.length; b += 1) {
      const lo = ranges[b * 2];
      const hi = ranges[b * 2 + 1];
      let peak = 0;
      for (let k = lo; k < hi && k < raw.length; k += 1) {
        if (raw[k] > peak) peak = raw[k];
      }
      out[b] = peak;
    }
    return out;
  }

  /**
   * 时域波形快照（QYP3-033：真波形）。无图返回 null；静音时值恒为 128，
   * 由调用方判定"无信号"→ 显示静态进度线而非假跳动。
   */
  getWaveform(): Uint8Array | null {
    if (!this.analyser || !this.waveData) return null;
    this.analyser.getByteTimeDomainData(this.waveData);
    return this.waveData;
  }

  /**
   * FLAC 内嵌封面剥离自救（QYP3-033；QYP3-037 扩展到服务器/WebDAV）：FLAC
   * 因非法封面被 Chromium 拒绝解码时，剥离封面后以 blob 在内置引擎重播——
   * 保留真频谱/真波形，且不必兜底 mpv（顺便避免黑窗）。服务器/WebDAV 走
   * qy-stream 代理 URL（fetch 全量拉取同样成立）。成功返回 true；非 FLAC /
   * 无可剥离封面 / 重封装后仍解码失败返回 false（交给上层 mpv 兜底）。
   */
  async recoverFlac(track: QueueTrack): Promise<boolean> {
    if (!isFlacUrl(track.url)) return false;
    try {
      const blobUrl = await stripFlacPicture(track.url);
      if (!blobUrl) return false;
      if (this.lastBlobUrl) URL.revokeObjectURL(this.lastBlobUrl);
      this.lastBlobUrl = blobUrl;
      this.audio.src = blobUrl;
      await this.audio.play?.();
      return true;
    } catch {
      return false;
    }
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

  /**
   * 会话中改播放模式（QYP3-068t）。`queueState` 是**只读快照**（每次 get 都是
   * 新对象），往它上面赋值是静默的空操作——这正是"循环/随机按钮点了没反应"
   * 的根因（只有建队那次 playQueue 的参数生效过）。模式改动必须走这里。
   */
  setQueueMode(repeat: RepeatMode, shuffle: boolean): void {
    this.queue.repeat = repeat;
    this.queue.setShuffle(shuffle);
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
