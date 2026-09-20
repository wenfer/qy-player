import { describe, expect, it } from 'vitest';
import {
  BandFrameEncoder,
  bandBinRanges,
  bandIndexForHz,
  fftInPlace,
} from '../../../src/main/modules/music-spectrum/pcm-fft';

/**
 * PCM → 频带矩阵（QYP3-050）：手写 radix-2 FFT + log 频带 + dB 量化。
 * 关注点：FFT 正确、帧率对齐（12fps 严格对齐）、频带定位准确、静音为 0。
 */

const SAMPLE_RATE = 24000;
const FPS = 12;
const BANDS = 48;

function sine(hz: number, samples: number, amplitude = 1): Int16Array {
  const out = new Int16Array(samples);
  for (let i = 0; i < samples; i += 1) {
    out[i] = Math.round(Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE) * 32767 * amplitude);
  }
  return out;
}

function argmax(frame: Uint8Array): number {
  let best = 0;
  for (let i = 1; i < frame.length; i += 1) if (frame[i] > frame[best]) best = i;
  return best;
}

describe('fftInPlace (QYP3-050)', () => {
  it('puts a DC signal entirely in bin 0', () => {
    const n = 8;
    const re = new Float64Array(n).fill(1);
    const im = new Float64Array(n);
    fftInPlace(re, im);
    expect(re[0]).toBeCloseTo(n, 6);
    for (let k = 1; k < n; k += 1) expect(re[k]).toBeCloseTo(0, 6);
  });

  it('localizes a single sine to its bin', () => {
    const n = 64;
    const bin = 5;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; i += 1) re[i] = Math.cos((2 * Math.PI * bin * i) / n);
    fftInPlace(re, im);
    let best = 0;
    for (let k = 0; k < n / 2; k += 1) {
      const mag = Math.hypot(re[k], im[k]);
      if (mag > Math.hypot(re[best], im[best])) best = k;
    }
    expect(best).toBe(bin);
    expect(Math.hypot(re[bin], im[bin])).toBeCloseTo(n / 2, 6);
  });
});

describe('band mapping (QYP3-050)', () => {
  it('covers 0..Nyquist with non-overlapping ascending bins', () => {
    const ranges = bandBinRanges(SAMPLE_RATE, 2048, BANDS);
    expect(ranges.length).toBe(BANDS * 2);
    for (let i = 0; i < BANDS; i += 1) {
      const lo = ranges[i * 2];
      const hi = ranges[i * 2 + 1];
      expect(hi).toBeGreaterThan(lo);
      expect(hi).toBeLessThanOrEqual(1024);
      if (i > 0) expect(lo).toBeGreaterThanOrEqual(ranges[(i - 1) * 2]);
    }
  });

  it('places reference frequencies in the expected band', () => {
    // 频带是 log 分布：第 0 带只覆盖 40–44.7 Hz，所以 50 Hz 落在第 2 带
    expect(bandIndexForHz(40, BANDS)).toBe(0);
    expect(bandIndexForHz(50, BANDS)).toBe(2);
    expect(bandIndexForHz(1000, BANDS)).toBe(29);
    expect(bandIndexForHz(4000, BANDS)).toBeGreaterThan(bandIndexForHz(1000, BANDS));
    expect(bandIndexForHz(20000, BANDS)).toBe(BANDS - 1); // 超上限钳制
  });
});

describe('BandFrameEncoder (QYP3-050)', () => {
  it('emits exactly one frame per 1/12 s and localizes a 1 kHz tone', () => {
    const enc = new BandFrameEncoder({ sampleRate: SAMPLE_RATE, fps: FPS, bands: BANDS });
    enc.push(sine(1000, SAMPLE_RATE)); // 恰好 1 秒
    expect(enc.frameCount).toBe(FPS); // 帧率对齐：12 帧
    for (const frame of enc.frames) {
      expect(frame.length).toBe(BANDS);
      expect(argmax(frame)).toBe(bandIndexForHz(1000, BANDS));
      expect(frame[argmax(frame)]).toBeGreaterThan(200);
    }
  });

  it('moves the peak up for a higher tone', () => {
    const enc = new BandFrameEncoder({ sampleRate: SAMPLE_RATE, fps: FPS, bands: BANDS });
    enc.push(sine(4000, SAMPLE_RATE / 2));
    const peak = argmax(enc.frames[0]);
    expect(peak).toBe(bandIndexForHz(4000, BANDS));
    expect(peak).toBeGreaterThan(bandIndexForHz(1000, BANDS));
  });

  it('keeps two tones as two local maxima', () => {
    const enc = new BandFrameEncoder({ sampleRate: SAMPLE_RATE, fps: FPS, bands: BANDS });
    const mixed = new Int16Array(SAMPLE_RATE / 2);
    const a = sine(400, SAMPLE_RATE / 2, 0.5);
    const b = sine(4000, SAMPLE_RATE / 2, 0.5);
    for (let i = 0; i < mixed.length; i += 1) mixed[i] = a[i] + b[i];
    enc.push(mixed);
    const frame = enc.frames[0];
    const lo = bandIndexForHz(400, BANDS);
    const hi = bandIndexForHz(4000, BANDS);
    // 两个等幅音（各 0.5 → 满幅的一半，约 -6dB，量化后 ~191）可能完全相等，
    // 所以不比 argmax，而是各自在邻域内最大
    expect(frame[lo]).toBeGreaterThan(180);
    expect(frame[hi]).toBeGreaterThan(180);
    expect(Math.max(...frame.subarray(Math.max(0, lo - 2), lo + 3))).toBe(frame[lo]);
    expect(Math.max(...frame.subarray(hi - 2, hi + 3))).toBe(frame[hi]);
    // 两音之间应当是安静的：频带映射糊了的话这里会被填满
    const mid = Math.floor((lo + hi) / 2);
    expect(frame[mid]).toBeLessThan(Math.min(frame[lo], frame[hi]) - 40);
  });

  it('encodes silence as all zeros', () => {
    const enc = new BandFrameEncoder({ sampleRate: SAMPLE_RATE, fps: FPS, bands: BANDS });
    enc.push(new Int16Array(SAMPLE_RATE));
    expect(enc.frameCount).toBe(FPS);
    for (const frame of enc.frames) expect(Array.from(frame)).toEqual(new Array(BANDS).fill(0));
  });

  it('handles chunks smaller than one hop (streaming pushes)', () => {
    const enc = new BandFrameEncoder({ sampleRate: SAMPLE_RATE, fps: FPS, bands: BANDS });
    const src = sine(1000, 6000);
    for (let off = 0; off < src.length; off += 137) {
      enc.push(src.subarray(off, Math.min(src.length, off + 137)));
    }
    expect(enc.frameCount).toBe(3); // 6000 / 2000
    expect(argmax(enc.frames[0])).toBe(bandIndexForHz(1000, BANDS));
  });
});
