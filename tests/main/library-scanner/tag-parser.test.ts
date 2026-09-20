import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 用真实字节构造的 fixture（tests/fixtures/audio，合成但结构合法）。
const dir = join(fileURLToPath(import.meta.url), '../../../fixtures/audio');
const p = (name: string) => join(dir, name);

describe('tag parser (QYP3-004)', () => {
  it('parses ID3v2.3 with UTF-16 text, USLT lyrics and cover flag', async () => {
    const tags = await import('../../../src/main/modules/library-scanner/tag-parser').then((m) =>
      m.parseAudioTags(p('sample-id3v23.mp3'))
    );
    expect(tags.format).toBe('id3v2');
    expect(tags.title).toBe('晴天');
    expect(tags.artist).toBe('周杰伦');
    expect(tags.album).toBe('叶惠美');
    expect(tags.albumartist).toBe('周杰伦');
    expect(tags.trackNo).toBe(3);
    expect(tags.discNo).toBe(1);
    expect(tags.year).toBe(2003);
    expect(tags.lyrics).toBe('[00:00.00]晴天歌词');
    expect(tags.hasCover).toBe(true);
  });

  it('parses ID3v2.4 UTF-8 frames', async () => {
    const { parseAudioTags } = await import('../../../src/main/modules/library-scanner/tag-parser');
    const tags = await parseAudioTags(p('sample-id3v24.mp3'));
    expect(tags.format).toBe('id3v2');
    expect(tags.title).toBe('标题四');
  });

  it('parses FLAC streaminfo, vorbis comments and picture', async () => {
    const { parseAudioTags } = await import('../../../src/main/modules/library-scanner/tag-parser');
    const tags = await parseAudioTags(p('sample.flac'));
    expect(tags.format).toBe('flac');
    expect(tags.title).toBe('晴天');
    expect(tags.artist).toBe('周杰伦');
    expect(tags.album).toBe('叶惠美');
    expect(tags.albumartist).toBe('周杰伦');
    expect(tags.trackNo).toBe(3);
    expect(tags.discNo).toBe(1);
    expect(tags.year).toBe(2003);
    expect(tags.duration).toBeCloseTo(20, 1);
    expect(tags.lyrics).toBe('[00:00.00]FLAC歌词');
    expect(tags.hasCover).toBe(true);
  });

  it('parses m4a ilst tags and duration', async () => {
    const { parseAudioTags } = await import('../../../src/main/modules/library-scanner/tag-parser');
    const tags = await parseAudioTags(p('sample.m4a'));
    expect(tags.format).toBe('m4a');
    expect(tags.title).toBe('标题M');
    expect(tags.artist).toBe('歌手M');
    expect(tags.albumartist).toBe('专辑歌手M');
    expect(tags.album).toBe('专辑M');
    expect(tags.trackNo).toBe(5);
    expect(tags.year).toBe(2005);
    expect(tags.duration).toBeCloseTo(20, 1);
    expect(tags.lyrics).toBe('[00:00.00]M4A歌词');
    expect(tags.hasCover).toBe(true);
  });

  it('survives truncated/garbage/tagless files with partial results', async () => {
    const { parseAudioTags } = await import('../../../src/main/modules/library-scanner/tag-parser');
    const truncated = await parseAudioTags(p('truncated.mp3'));
    expect(truncated.format).toBe('unknown');
    expect(truncated.hasCover).toBe(false);
    const garbage = await parseAudioTags(p('garbage.bin'));
    expect(garbage.format).toBe('unknown');
    const notags = await parseAudioTags(p('notags.mp3'), { title: '文件名兜底' });
    expect(notags.title).toBe('文件名兜底');
    expect(notags.format).toBe('unknown');
  });

  it('falls back to filename hints when tags are missing', async () => {
    const { parseAudioTags } = await import('../../../src/main/modules/library-scanner/tag-parser');
    const tags = await parseAudioTags(p('notags.mp3'), { title: '晴天', artist: '周杰伦', trackNo: 3 });
    expect(tags.title).toBe('晴天');
    expect(tags.artist).toBe('周杰伦');
    expect(tags.trackNo).toBe(3);
  });
});

/**
 * 时长解析（QYP3-052）：mp3 靠 Xing/Info 总帧数，退化到 ID3 TLEN，再退化到
 * "码率恒定"的 CBR 估算；APE 靠文件头的 `MAC ` 描述符。
 * 全部用合成字节构造，断言精确值（真实文件的对照见交付说明里的实测）。
 */
describe('audio duration (QYP3-052)', () => {
  /** MPEG1 Layer III / 44100Hz 帧头：bitrateIndex 9 = 128kbps，padding=0。 */
  const frameHeader = (bitrateIndex = 9, mono = false): number[] => [
    0xff,
    0xfb,
    bitrateIndex << 4, // sampleRateIndex 0 = 44100
    mono ? 0xc0 : 0x00,
  ];
  /** 128kbps 一帧的字节数（144 * 128000 / 44100 = 417） */
  const FRAME_BYTES = 417;
  /** 一个只含给定帧的最小 ID3v2.3 标签：返回标签字节 + 音频起点。 */
  const id3Tag = (...frames: number[][]): { tag: number[]; audioStart: number } => {
    const body = frames.flat();
    const size = body.length;
    return {
      tag: [
        0x49, 0x44, 0x33, // 'ID3'
        0x03, 0x00, 0x00, // v2.3，flags = 0
        (size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f,
        ...body,
      ],
      audioStart: 10 + size,
    };
  };
  /** 铺 n 个 128kbps 帧（每帧 FRAME_BYTES 字节，帧头之外是 0）。 */
  const cbrFrames = (n: number): number[] => {
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      out.push(...frameHeader(9));
      while (out.length < (i + 1) * FRAME_BYTES) out.push(0);
    }
    return out;
  };
  /** 一个 ID3 文本帧（v2.3，latin1 编码）。 */
  const textFrame = (id: string, text: string): number[] => {
    const payload = [0x00, ...[...text].map((c) => c.charCodeAt(0))];
    const size = payload.length;
    return [
      ...[...id].map((c) => c.charCodeAt(0)),
      (size >> 24) & 0xff,
      (size >> 16) & 0xff,
      (size >> 8) & 0xff,
      size & 0xff,
      0x00,
      0x00, // flags
      ...payload,
    ];
  };
  const bufOf = (bytes: number[]): Buffer => Buffer.from(bytes);

  it('reads mp3 duration from the Xing frame (frames × samplesPerFrame / sampleRate)', async () => {
    const { parseAudioTagsFromBuffer } = await import(
      '../../../src/main/modules/library-scanner/tag-parser'
    );
    const { tag, audioStart } = id3Tag(textFrame('TIT2', 'x'));
    const bytes = [...tag, ...frameHeader()];
    while (bytes.length < audioStart + 4 + 32) bytes.push(0); // 立体声侧信息 32 字节
    bytes.push(0x58, 0x69, 0x6e, 0x67); // 'Xing'
    bytes.push(0x00, 0x00, 0x00, 0x01); // flags: 有帧数字段
    bytes.push(0x00, 0x00, 0x03, 0xe8); // frames = 1000
    const tags = parseAudioTagsFromBuffer(bufOf(bytes), undefined, bytes.length);
    expect(tags.title).toBe('x');
    // 1000 * 1152 / 44100
    expect(tags.duration).toBeCloseTo(26.122, 3);
  });

  it('falls back to the ID3 TLEN frame (milliseconds)', async () => {
    const { parseAudioTagsFromBuffer } = await import(
      '../../../src/main/modules/library-scanner/tag-parser'
    );
    const { tag } = id3Tag(textFrame('TIT2', 'y'), textFrame('TLEN', '180000'));
    const tags = parseAudioTagsFromBuffer(bufOf(tag), undefined, 1000);
    expect(tags.title).toBe('y');
    expect(tags.duration).toBeCloseTo(180, 3);
  });

  it('does not guess VBR mp3 without a Xing frame (首帧码率毫无代表性)', async () => {
    const { parseAudioTagsFromBuffer } = await import(
      '../../../src/main/modules/library-scanner/tag-parser'
    );
    const { tag, audioStart } = id3Tag(textFrame('TIT2', 'vbr'));
    const bytes = [...tag, ...frameHeader(9)];
    // 第二帧换成 192kbps（索引 11）：码率不恒定 → 不给估算
    while (bytes.length < audioStart + FRAME_BYTES) bytes.push(0);
    bytes.push(...frameHeader(11));
    const tags = parseAudioTagsFromBuffer(bufOf(bytes), undefined, 200_000);
    expect(tags.duration).toBeUndefined();
  });

  it('estimates a constant-bitrate mp3 from the file size', async () => {
    const { parseAudioTagsFromBuffer } = await import(
      '../../../src/main/modules/library-scanner/tag-parser'
    );
    const { tag, audioStart } = id3Tag(textFrame('TIT2', 'cbr'));
    const bytes = [...tag, ...cbrFrames(40)];
    // 128kbps = 16000 字节/秒 → 文件里有 32000 字节音频 = 2 秒
    const tags = parseAudioTagsFromBuffer(bufOf(bytes), undefined, audioStart + 32_000);
    expect(tags.duration).toBeCloseTo(2, 3);
  });

  it('has no estimate without a file size (缓冲区只有头部时宁可留空)', async () => {
    const { parseAudioTagsFromBuffer } = await import(
      '../../../src/main/modules/library-scanner/tag-parser'
    );
    const { tag } = id3Tag(textFrame('TIT2', 'nosize'));
    const bytes = [...tag, ...cbrFrames(40)];
    const tags = parseAudioTagsFromBuffer(bufOf(bytes));
    expect(tags.duration).toBeUndefined();
  });

  it('reads a bare mp3 (no ID3 tag) from a leading MPEG frame', async () => {
    const { parseAudioTagsFromBuffer } = await import(
      '../../../src/main/modules/library-scanner/tag-parser'
    );
    const bytes = [...frameHeader()];
    while (bytes.length < 4 + 32) bytes.push(0);
    bytes.push(0x49, 0x6e, 0x66, 0x6f); // 'Info'（CBR 的 Xing 变体）
    bytes.push(0x00, 0x00, 0x00, 0x01);
    bytes.push(0x00, 0x00, 0x0b, 0xb8); // frames = 3000 → 3000*1152/44100
    const tags = parseAudioTagsFromBuffer(bufOf(bytes), undefined, bytes.length);
    expect(tags.duration).toBeCloseTo(78.367, 3);
  });

  it('reads APE duration from the MAC header', async () => {
    const { parseAudioTagsFromBuffer } = await import(
      '../../../src/main/modules/library-scanner/tag-parser'
    );
    const bytes = new Array<number>(76).fill(0);
    bytes[0] = 0x4d; // 'MAC '
    bytes[1] = 0x41;
    bytes[2] = 0x43;
    bytes[3] = 0x20;
    const put = (offset: number, value: number, width: number): void => {
      for (let i = 0; i < width; i++) bytes[offset + i] = (value >>> (8 * i)) & 0xff; // LE
    };
    put(4, 3990, 2); // version
    put(56, 73728, 4); // blocksPerFrame
    put(60, 29762, 4); // finalFrameBlocks
    put(64, 193, 4); // totalFrames
    put(72, 44100, 4); // sampleRate
    const tags = parseAudioTagsFromBuffer(bufOf(bytes), undefined, 30_000_000);
    // ((193-1)*73728 + 29762) / 44100
    expect(tags.duration).toBeCloseTo(321.6675, 3);
  });

  it('does not guess an APE duration on the old (pre-3.98) header layout', async () => {
    const { parseAudioTagsFromBuffer } = await import(
      '../../../src/main/modules/library-scanner/tag-parser'
    );
    const bytes = new Array<number>(76).fill(0);
    bytes[0] = 0x4d;
    bytes[1] = 0x41;
    bytes[2] = 0x43;
    bytes[3] = 0x20;
    bytes[4] = 0x6e; // version 3950（LE）
    bytes[5] = 0x0f;
    const tags = parseAudioTagsFromBuffer(bufOf(bytes), undefined, 30_000_000);
    expect(tags.duration).toBeUndefined();
  });
});
