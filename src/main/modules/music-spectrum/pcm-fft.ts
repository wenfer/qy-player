/**
 * PCM → 频带矩阵（QYP3-050）。纯计算，无 IO，无依赖（主进程不引任何 FFT 库）。
 *
 * 手写**迭代式 radix-2 FFT**（定长 N）＋ Hann 窗，按 hop 切帧、取每个频带的峰值，
 * 量化成 0..255 的字节。频带按**对数**分布（40 Hz–8 kHz）：既对齐人耳，也与
 * 播放器里 10 段均衡器的观感一致。
 *
 * 帧对齐：`sampleRate === fps × hop`（默认 24000 = 12 × 2000）**整除**，所以第 i
 * 帧严格对应 `t = i / fps`——不需要时间戳，也没有累积漂移（这是选 24000/2000 而
 * 不是 16000/1333 的唯一原因）。
 */

export interface BandFrameOptions {
  sampleRate?: number;
  fps?: number;
  fftSize?: number;
  bands?: number;
  /** 量化下限（dB）：低于它一律记 0。 */
  dbFloor?: number;
  /** 频带下限/上限（Hz）。 */
  minHz?: number;
  maxHz?: number;
}

/** 原位迭代 radix-2 FFT（长度须为 2 的幂）。 */
export function fftInPlace(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  if (n <= 1) return;
  // 位反转置换
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len / 2; k += 1) {
        const aRe = re[i + k];
        const aIm = im[i + k];
        const bRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
        const bIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
        re[i + k] = aRe + bRe;
        im[i + k] = aIm + bIm;
        re[i + k + len / 2] = aRe - bRe;
        im[i + k + len / 2] = aIm - bIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

/**
 * 每个频带覆盖的 FFT bin 区间 `[lo, hi]`（含端点），log 均匀分布。
 * 窄带处强制 `hi ≥ lo + 1`（最低几带会共用同一个 bin，视觉上无碍）。
 */
export function bandBinRanges(
  sampleRate: number,
  fftSize: number,
  bands: number,
  minHz = 40,
  maxHz = 8000
): Int32Array {
  const out = new Int32Array(bands * 2);
  const binHz = sampleRate / fftSize;
  const ratio = maxHz / minHz;
  for (let i = 0; i < bands; i += 1) {
    const loHz = minHz * Math.pow(ratio, i / bands);
    const hiHz = minHz * Math.pow(ratio, (i + 1) / bands);
    const lo = Math.max(0, Math.min(fftSize / 2 - 1, Math.round(loHz / binHz)));
    const hi = Math.max(lo + 1, Math.min(fftSize / 2, Math.round(hiHz / binHz)));
    out[i * 2] = lo;
    out[i * 2 + 1] = hi;
  }
  return out;
}

/** 某个频率落在第几个频带（测试与调试用）。 */
export function bandIndexForHz(
  hz: number,
  bands: number,
  minHz = 40,
  maxHz = 8000
): number {
  if (hz <= minHz) return 0;
  if (hz >= maxHz) return bands - 1;
  const idx = Math.floor((Math.log(hz / minHz) / Math.log(maxHz / minHz)) * bands);
  return Math.max(0, Math.min(bands - 1, idx));
}

/**
 * 流式编码器：把不断到来的 PCM 追加进去，每凑够一帧（hop 个新样本）就产出一帧
 * 频带字节。窗口 = 前 hop 之外多留 `fftSize - hop` 个样本做重叠。
 */
export class BandFrameEncoder {
  readonly hop: number;
  readonly bands: number;
  readonly sampleRate: number;
  readonly fps: number;

  private readonly fftSize: number;
  private readonly dbFloor: number;
  private readonly ranges: Int32Array;
  private readonly window: Float64Array;
  private readonly re: Float64Array;
  private readonly im: Float64Array;
  /** 上一帧尾部（fftSize - hop 个样本），用于窗口重叠。 */
  private readonly tail: Float64Array;
  private readonly block: Float64Array;
  private blockFilled = 0;
  private readonly out: Uint8Array[] = [];

  constructor(options: BandFrameOptions = {}) {
    this.sampleRate = options.sampleRate ?? 24000;
    this.fps = options.fps ?? 12;
    this.bands = options.bands ?? 48;
    this.dbFloor = options.dbFloor ?? 72;
    this.hop = Math.max(1, Math.round(this.sampleRate / this.fps));
    // 窗长必须 ≥ hop，否则重叠窗口拼不出来（配置错了就向上取到 2 的幂）
    const wantFft = options.fftSize ?? 2048;
    this.fftSize = wantFft >= this.hop ? wantFft : 1 << Math.ceil(Math.log2(this.hop));
    this.ranges = bandBinRanges(this.sampleRate, this.fftSize, this.bands);
    this.window = new Float64Array(this.fftSize);
    this.re = new Float64Array(this.fftSize);
    this.im = new Float64Array(this.fftSize);
    this.tail = new Float64Array(Math.max(0, this.fftSize - this.hop));
    this.block = new Float64Array(this.hop);
  }

  /** 已产出的帧数。 */
  get frameCount(): number {
    return this.out.length;
  }

  /** 当前所有帧（每帧 `bands` 字节）；顺序即时间顺序。 */
  get frames(): Uint8Array[] {
    return this.out;
  }

  /** 喂入一段单声道 PCM（s16）。 */
  push(pcm: Int16Array): void {
    let offset = 0;
    while (offset < pcm.length) {
      const take = Math.min(this.hop - this.blockFilled, pcm.length - offset);
      for (let i = 0; i < take; i += 1) {
        this.block[this.blockFilled + i] = pcm[offset + i] / 32768;
      }
      this.blockFilled += take;
      offset += take;
      if (this.blockFilled === this.hop) {
        this.emitFrame();
        this.blockFilled = 0;
      }
    }
  }

  private emitFrame(): void {
    const { fftSize, hop, window, re, im, tail, block } = this;
    window.set(tail, 0);
    window.set(block, fftSize - hop);
    // Hann 窗 + 拷进实部
    const denom = fftSize - 1;
    for (let i = 0; i < fftSize; i += 1) {
      re[i] = window[i] * 0.5 * (1 - Math.cos((2 * Math.PI * i) / denom));
      im[i] = 0;
    }
    fftInPlace(re, im);

    const frame = new Uint8Array(this.bands);
    for (let b = 0; b < this.bands; b += 1) {
      const lo = this.ranges[b * 2];
      const hi = this.ranges[b * 2 + 1];
      let peak = 0;
      for (let k = lo; k < hi && k < fftSize / 2; k += 1) {
        const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
        if (mag > peak) peak = mag;
      }
      // 归一化到幅度（满幅正弦 → 0.5），再转 dB 并压进 0..255
      const db = 20 * Math.log10(peak / fftSize + 1e-9);
      const norm = (db + this.dbFloor) / this.dbFloor;
      frame[b] = Math.max(0, Math.min(255, Math.round(norm * 255)));
    }
    this.out.push(frame);
    tail.set(window.subarray(hop));
  }
}
