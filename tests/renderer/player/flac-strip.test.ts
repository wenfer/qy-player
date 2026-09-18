// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { isLocalFlacUrl, stripFlacPictureBytes } from '../../../src/renderer/player/flac-strip';

/** 拼一个 FLAC 字节流：magic + 若干元数据块（含 header）+ 音频帧。 */
function flac(parts: Array<{ type: number; last?: boolean; data: number[] }>, frames: number[]): Uint8Array {
  const bytes: number[] = [0x66, 0x4c, 0x61, 0x43];
  parts.forEach((p, i) => {
    const isLast = p.last ?? i === parts.length - 1;
    const header = (isLast ? 0x80 : 0x00) | (p.type & 0x7f);
    bytes.push(header, (p.data.length >> 16) & 0xff, (p.data.length >> 8) & 0xff, p.data.length & 0xff, ...p.data);
  });
  bytes.push(...frames);
  return new Uint8Array(bytes);
}

/** 扫描输出里所有元数据块的 (type, last) 对。 */
function scanBlocks(out: Uint8Array): Array<{ type: number; last: boolean }> {
  const res: Array<{ type: number; last: boolean }> = [];
  let offset = 4;
  while (offset + 4 <= out.length) {
    const header = out[offset];
    const last = (header & 0x80) !== 0;
    const type = header & 0x7f;
    const length = (out[offset + 1] << 16) | (out[offset + 2] << 8) | out[offset + 3];
    res.push({ type, last });
    offset += 4 + length;
    if (last) break;
  }
  return res;
}

describe('stripFlacPictureBytes (QYP3-033)', () => {
  it('returns null for non-FLAC input', () => {
    expect(stripFlacPictureBytes(new Uint8Array([1, 2, 3, 4]))).toBeNull();
  });

  it('returns null when there is no PICTURE block to strip', () => {
    const input = flac([{ type: 0, data: [1, 2] }, { type: 4, last: true, data: [5] }], [0xff, 0xf8, 0x00]);
    expect(stripFlacPictureBytes(input)).toBeNull();
  });

  it('strips the PICTURE block, keeps STREAMINFO + audio frames, fixes last flag', () => {
    const input = flac(
      [
        { type: 0, data: [1, 2] }, // STREAMINFO
        { type: 6, data: [9, 9] }, // PICTURE（应被剥离）
        { type: 4, last: true, data: [5] }, // VORBIS（原末块）
      ],
      [0xff, 0xf8, 0x00], // 音频帧
    );
    const out = stripFlacPictureBytes(input);
    expect(out).not.toBeNull();
    // 封面数据 [9,9] 不应出现在输出中
    expect(Array.from(out!).includes(9)).toBe(false);
    // STREAMINFO 数据 [1,2] 保留
    expect(out!.slice(4, 10)).toEqual(new Uint8Array([0x00, 0x00, 0x00, 0x02, 1, 2]));
    // 音频帧原样保留在末尾
    expect(Array.from(out!.slice(out!.length - 3))).toEqual([0xff, 0xf8, 0x00]);
    // 块结构：只剩 STREAMINFO + VORBIS，且 VORBIS 成为末块
    const blocks = scanBlocks(out!);
    expect(blocks).toEqual([
      { type: 0, last: false },
      { type: 4, last: true },
    ]);
  });

  it('returns null on truncated / length-overflowing metadata', () => {
    const input = flac([{ type: 0, data: [1, 2] }], [0xff]);
    // 篡改长度使其越界
    input[5] = 0xff;
    input[6] = 0xff;
    expect(stripFlacPictureBytes(input)).toBeNull();
  });
});

describe('isLocalFlacUrl (QYP3-033)', () => {
  it('matches local audio flac urls (including encoded CJK names)', () => {
    expect(isLocalFlacUrl('qy-file://audio/1/嘲笑.flac')).toBe(true);
    expect(isLocalFlacUrl('qy-file://audio/1/x.FLAC')).toBe(true);
  });
  it('rejects non-flac and non-local urls', () => {
    expect(isLocalFlacUrl('qy-file://audio/1/x.mp3')).toBe(false);
    expect(isLocalFlacUrl('https://example.com/a.flac')).toBe(false);
    expect(isLocalFlacUrl('qy-file://covers/1.png')).toBe(false);
  });
});

describe('isFlacUrl (QYP3-037)', () => {
  it('accepts qy-stream proxy urls and local qy-file flac paths', async () => {
    const { isFlacUrl } = await import('../../../src/renderer/player/flac-strip');
    expect(isFlacUrl('qy-stream://audio/sess-1')).toBe(true);
    expect(isFlacUrl('qy-file://audio/1/%E5%98%B2%E7%AC%91.flac')).toBe(true);
    expect(isFlacUrl('qy-file://audio/1/%E5%98%B2%E7%AC%91.mp3')).toBe(false);
    expect(isFlacUrl('https://example.com/a.flac')).toBe(false);
  });

  it('isLocalFlacUrl keeps rejecting qy-stream (extension-less)', async () => {
    const { isLocalFlacUrl } = await import('../../../src/renderer/player/flac-strip');
    expect(isLocalFlacUrl('qy-stream://audio/sess-1')).toBe(false);
  });
});
