import { describe, expect, it } from 'vitest';
import {
  SPECTRUM_BANDS,
  SPECTRUM_HEADER_BYTES,
  encodeSpectrum,
  frameView,
  parseSpectrum,
} from '../../../src/main/modules/music-spectrum/spectrum-format';

/**
 * 离线频谱缓存文件格式（QYP3-050）：头 32 字节 + frameCount×bands 字节帧。
 * 关注点：往返一致、损坏/截断/版本不符一律当"没有缓存"（不能把坏数据喂给可视化）。
 */

function frames(n: number): Uint8Array[] {
  return Array.from({ length: n }, (_, i) =>
    Uint8Array.from({ length: SPECTRUM_BANDS }, (_, b) => (i * 7 + b) % 256)
  );
}

describe('spectrum file format (QYP3-050)', () => {
  it('round-trips header and frame bytes', () => {
    const src = frames(5);
    const parsed = parseSpectrum(encodeSpectrum(src));
    expect(parsed).not.toBeNull();
    const { header, frames: flat } = parsed!;
    expect(header.bands).toBe(SPECTRUM_BANDS);
    expect(header.fps).toBe(12);
    expect(header.sampleRate).toBe(24000);
    expect(header.frameCount).toBe(5);
    // fps × hop === sampleRate（帧与时间严格对齐，无漂移）
    expect(header.hopSize * header.fps).toBe(header.sampleRate);
    expect(flat.length).toBe(5 * SPECTRUM_BANDS);
    src.forEach((frame, i) => {
      expect(Array.from(frameView(parsed!, i)!)).toEqual(Array.from(frame));
    });
  });

  it('rejects a wrong magic / version / truncated payload', () => {
    const good = encodeSpectrum(frames(2));
    expect(parseSpectrum(new Uint8Array(0))).toBeNull();
    expect(parseSpectrum(new Uint8Array(SPECTRUM_HEADER_BYTES))).toBeNull(); // 头全 0：magic 不符

    const badMagic = Buffer.from(good);
    badMagic.write('XXXX', 0, 'ascii');
    expect(parseSpectrum(badMagic)).toBeNull();

    const badVersion = Buffer.from(good);
    badVersion.writeUInt16LE(99, 4);
    expect(parseSpectrum(badVersion)).toBeNull();

    // 截断：头说 2 帧，实际只给 1 帧（写一半/磁盘满）
    expect(parseSpectrum(good.subarray(0, SPECTRUM_HEADER_BYTES + SPECTRUM_BANDS))).toBeNull();
  });

  it('frameView clamps out-of-range indexes', () => {
    const parsed = parseSpectrum(encodeSpectrum(frames(3)))!;
    expect(frameView(parsed, 0)).not.toBeNull();
    expect(frameView(parsed, 2)).not.toBeNull();
    expect(frameView(parsed, 3)).toBeNull();
    expect(frameView(parsed, -1)).toBeNull();
    expect(frameView(parsed, 1.5)).toBeNull();
  });
});
