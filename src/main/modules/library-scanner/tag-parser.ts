/**
 * 自研音频标签解析器（QYP3-004，计划 §5）。
 *
 * 覆盖：ID3v2.3/2.4（mp3）、FLAC（STREAMINFO/Vorbis comment/Picture）、
 * m4a（moov.udta.meta.ilst 最小集）、APEv2 文件尾只读。
 *
 * 红线：零依赖（禁止 jsmediatags/music-metadata 等 native/大体积包）。
 * 容错：截断/损坏/未知容器返回部分结果，绝不 throw 到调用方。
 * 解析是纯读：不修改文件；封面只报告 hasCover（提取在 QYP3-005）。
 */

import { readFile } from 'node:fs/promises';

/**
 * 时长解析能力的版本（QYP3-052）。
 *
 * 扫描器用它决定"要不要给库里缺时长的老行强制补解析一次"：只有本文件的时长
 * 解析能力变了才 +1，用户重扫一次媒体库即可补齐存量行（指纹没变本来会跳过）。
 */
export const AUDIO_DURATION_PARSER_VERSION = 1;

export interface ParsedAudioTags {
  title?: string;
  artist?: string;
  album?: string;
  albumartist?: string;
  trackNo?: number;
  discNo?: number;
  year?: number;
  /**
   * 时长（秒）。来源：FLAC STREAMINFO / m4a mvhd / mp3 的 Xing·Info 帧
   * （退化到 ID3 TLEN，再退化到"码率恒定的 CBR 按文件大小估"）/ APE MAC 头。
   * 解析不出来的格式（VBR 无 Xing、ID3 标签超出读取窗口、未知格式）留空，
   * 由播放期回填（QYP3-052）。
   */
  duration?: number;
  lyrics?: string;
  hasCover: boolean;
  format: 'id3v2' | 'flac' | 'm4a' | 'ape' | 'unknown';
}

/** ID3 "synchsafe" 整数（每字节仅 7 位）。 */
function synchsafe(buf: Uint8Array, offset: number): number {
  return (
    ((buf[offset] & 0x7f) << 21) |
    ((buf[offset + 1] & 0x7f) << 14) |
    ((buf[offset + 2] & 0x7f) << 7) |
    (buf[offset + 3] & 0x7f)
  );
}

function be32(buf: Uint8Array, offset: number): number {
  return ((buf[offset] << 24) | (buf[offset + 1] << 16) | (buf[offset + 2] << 8) | buf[offset + 3]) >>> 0;
}

function le32(buf: Uint8Array, offset: number): number {
  return (buf[offset] | (buf[offset + 1] << 8) | (buf[offset + 2] << 16) | (buf[offset + 3] << 24)) >>> 0;
}

/** MPEG 音频帧头解析（mp3/mp2/mp1 时长用，QYP3-052）。 */
interface MpegFrame {
  offset: number;
  /** 1 = MPEG1，2 = MPEG2/2.5（码率与每帧采样数的表不同）。 */
  family: 1 | 2;
  /** 真实层号：1 = Layer I，2 = Layer II，3 = Layer III。 */
  layer: 1 | 2 | 3;
  bitrateKbps: number;
  sampleRate: number;
  samplesPerFrame: number;
  /** 1 = 单声道（决定 Xing 头前面的侧信息长度）。 */
  mono: boolean;
  padding: number;
}

/** 索引顺序 = 头里的 layer 位（1→Layer III、2→Layer II、3→Layer I）。 */
const MPEG_BITRATE_KBPS: Record<1 | 2, readonly number[][]> = {
  // MPEG1：Layer I / II / III
  1: [
    [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
    [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
    [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  ],
  // MPEG2 / 2.5：Layer I / II 同 MPEG1，Layer III 减半
  2: [
    [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
    [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
    [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  ],
};
const MPEG_SAMPLE_RATES: readonly (readonly number[])[] = [
  [44100, 48000, 32000], // MPEG1
  [22050, 24000, 16000], // MPEG2
  [11025, 12000, 8000], // MPEG2.5
];
/** 每帧采样数：MPEG1 的 Layer II/III 是 1152，MPEG2/2.5 的 Layer III 只有 576。 */
const MPEG_SAMPLES_PER_FRAME: Record<1 | 2, readonly number[]> = {
  1: [384, 1152, 1152],
  2: [384, 1152, 576],
};

/** 最多向后找这么多字节的 MPEG 帧头（ID3 标签后可能还有残留字节）。 */
const MPEG_SCAN_WINDOW = 200 * 1024;
/** CBR 判定需要连续这么多帧码率一致，才敢用文件大小反推时长。 */
const CBR_PROBE_FRAMES = 40;
/** 时长合理区间（秒）：越界的解析结果一律丢弃。 */
const MIN_DURATION_SEC = 1;
const MAX_DURATION_SEC = 24 * 3600;

function parseMpegFrame(buf: Uint8Array, offset: number): MpegFrame | null {
  if (offset + 4 > buf.length) return null;
  if (buf[offset] !== 0xff || (buf[offset + 1] & 0xe0) !== 0xe0) return null;
  const versionBits = (buf[offset + 1] >> 3) & 0x03; // 3=MPEG1, 2=MPEG2, 0=MPEG2.5, 1=保留
  const layerBits = (buf[offset + 1] >> 1) & 0x03; // 3=I, 2=II, 1=III, 0=保留
  const bitrateBits = (buf[offset + 2] >> 4) & 0x0f;
  const sampleRateBits = (buf[offset + 2] >> 2) & 0x03;
  if (
    versionBits === 1 ||
    layerBits === 0 ||
    bitrateBits === 0 ||
    bitrateBits === 15 ||
    sampleRateBits === 3
  ) {
    return null;
  }
  const family: 1 | 2 = versionBits === 3 ? 1 : 2;
  const layer = (4 - layerBits) as 1 | 2 | 3;
  // 表按真实层号排（0=Layer I / 1=II / 2=III），别用 layerBits 直接索引（顺序相反）
  const bitrateKbps = MPEG_BITRATE_KBPS[family][layer - 1][bitrateBits];
  const sampleRateIndex = versionBits === 3 ? 0 : versionBits === 2 ? 1 : 2;
  const sampleRate = MPEG_SAMPLE_RATES[sampleRateIndex][sampleRateBits];
  if (!bitrateKbps || !sampleRate) return null;
  return {
    offset,
    family,
    layer,
    bitrateKbps,
    sampleRate,
    samplesPerFrame: MPEG_SAMPLES_PER_FRAME[family][layer - 1],
    // 单声道是 3（单声道），其余（立体声/联合/双声道）侧信息更长
    mono: ((buf[offset + 3] >> 6) & 0x03) === 3,
    padding: (buf[offset + 2] >> 1) & 0x01,
  };
}

/** 从 `from` 起找第一个合法的 MPEG 帧头（找不到返回 null）。 */
function findMpegFrame(buf: Uint8Array, from: number): MpegFrame | null {
  const end = Math.min(buf.length - 4, from + MPEG_SCAN_WINDOW);
  for (let i = Math.max(0, from); i <= end; i++) {
    const frame = parseMpegFrame(buf, i);
    if (frame) return frame;
  }
  return null;
}

/** MPEG 一帧的字节数（Layer I 的 padding 以 4 字节为单位，实际文件几乎见不到）。 */
function mpegFrameLength(frame: MpegFrame): number {
  const slotBytes = frame.layer === 1 ? 4 : 1;
  return (
    Math.floor((frame.samplesPerFrame / 8) * frame.bitrateKbps * 1000 / frame.sampleRate) +
    frame.padding * slotBytes
  );
}

/** Xing/Info 帧里的总帧数 → 时长（精确，LAME/大多数编码器都会写）。 */
function mp3FrameDuration(buf: Uint8Array, audioStart: number): number | null {
  const frame = findMpegFrame(buf, audioStart);
  if (!frame) return null;
  // Xing 头在帧头 + 4 字节（CRC 位置）+ 侧信息之后；侧信息长度只与版本和声道数有关
  const sideInfo = frame.family === 1 ? (frame.mono ? 17 : 32) : frame.mono ? 9 : 17;
  const at = frame.offset + 4 + sideInfo;
  if (at + 12 > buf.length) return null;
  const tag = String.fromCharCode(buf[at], buf[at + 1], buf[at + 2], buf[at + 3]);
  if (tag !== 'Xing' && tag !== 'Info') return null;
  if ((be32(buf, at + 4) & 0x01) === 0) return null; // 没有帧数字段
  const frames = be32(buf, at + 8);
  if (frames === 0) return null;
  return (frames * frame.samplesPerFrame) / frame.sampleRate;
}

/**
 * CBR 估算：只有前 40 帧码率完全一致才认（真 CBR 文件的帧长固定，用文件大小
 * 反推误差 < 1 帧）。**VBR 且没有 Xing 头时首帧码率毫无代表性**——按它估会差
 * 2~4 倍（实测最大差 1125 秒），所以宁可留空等播放期回填。
 */
function mp3CbrDuration(buf: Uint8Array, audioStart: number, fileSize: number | undefined): number | null {
  if (!fileSize || fileSize <= audioStart) return null;
  const first = findMpegFrame(buf, audioStart);
  if (!first) return null;
  let offset = first.offset;
  for (let i = 0; i < CBR_PROBE_FRAMES; i++) {
    const frame = parseMpegFrame(buf, offset);
    if (!frame || frame.bitrateKbps !== first.bitrateKbps || frame.sampleRate !== first.sampleRate) {
      return null;
    }
    const length = mpegFrameLength(frame);
    if (length < 4) return null;
    offset += length;
  }
  return ((fileSize - audioStart) * 8) / (first.bitrateKbps * 1000);
}

/**
 * APE（Monkey's Audio）音频时长：`MAC ` 描述符就在文件最前面（与文件尾的
 * APEv2 标签是两回事）。3.98 之后头部布局固定；更老的版本布局不同，不猜。
 */
function apeAudioDuration(buf: Uint8Array): number | null {
  if (buf.length < 76) return null;
  if (!(buf[0] === 0x4d && buf[1] === 0x41 && buf[2] === 0x43 && buf[3] === 0x20)) return null;
  const version = buf[4] | (buf[5] << 8);
  if (version < 3980) return null;
  const blocksPerFrame = le32(buf, 56);
  const finalFrameBlocks = le32(buf, 60);
  const totalFrames = le32(buf, 64);
  const sampleRate = le32(buf, 72);
  if (!blocksPerFrame || !totalFrames || !sampleRate) return null;
  const samples =
    totalFrames > 1 ? (totalFrames - 1) * blocksPerFrame + finalFrameBlocks : finalFrameBlocks;
  if (samples <= 0) return null;
  return samples / sampleRate;
}

/** 解析结果是否在合理区间（挡住解析错位得到的离谱数字）。 */
function plausibleDuration(seconds: number | null): number | null {
  if (seconds === null || !Number.isFinite(seconds)) return null;
  return seconds >= MIN_DURATION_SEC && seconds <= MAX_DURATION_SEC ? seconds : null;
}

/** ID3 文本按编码字节解出字符串（支持 0/1/2/3 四种编码）。 */
function decodeText(encoding: number, raw: Uint8Array): string {
  try {
    if (encoding === 0) {
      return new TextDecoder('latin1').decode(raw).replace(/\u0000+$/, '').trim();
    }
    if (encoding === 1) {
      let text = raw;
      // BOM 缺失时按 UTF-16LE（实践中的主流写法）
      if (raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe) text = raw.subarray(2);
      else if (raw.length >= 2 && raw[0] === 0xfe && raw[1] === 0xff)
        return new TextDecoder('utf-16be').decode(raw.subarray(2)).replace(/\u0000+$/, '').trim();
      return new TextDecoder('utf-16le').decode(text).replace(/\u0000+$/, '').trim();
    }
    if (encoding === 2) {
      return new TextDecoder('utf-16be').decode(raw).replace(/\u0000+$/, '').trim();
    }
    return new TextDecoder('utf-8').decode(raw).replace(/\u0000+$/, '').trim();
  } catch {
    return '';
  }
}

/** "3/12" → 3；"3" → 3；非法 → undefined。 */
function parsePair(value: string): number | undefined {
  const m = value.match(/^(\d+)/);
  return m ? Number(m[1]) : undefined;
}

function parseId3(buf: Uint8Array, fileSize?: number): ParsedAudioTags | null {
  if (buf.length < 10) return null;
  if (!(buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33)) return null; // "ID3"
  const major = buf[3];
  if (major !== 3 && major !== 4 && major !== 2) return null;
  const tagSize = synchsafe(buf, 6);
  if (tagSize <= 0 || 10 + tagSize > buf.length) {
    // 截断：只解析存在的部分，由调用方决定保留多少
  }
  const limit = Math.min(10 + tagSize, buf.length);
  let pos = 10;
  const out: ParsedAudioTags = { hasCover: false, format: 'id3v2' };
  let sawFrame = false;

  while (pos + (major === 2 ? 6 : 10) <= limit) {
    let id: string;
    let size: number;
    if (major === 2) {
      id = String.fromCharCode(buf[pos], buf[pos + 1], buf[pos + 2]);
      size = (buf[pos + 3] << 16) | (buf[pos + 4] << 8) | buf[pos + 5];
      pos += 6;
    } else {
      id = String.fromCharCode(buf[pos], buf[pos + 1], buf[pos + 2], buf[pos + 3]);
      // v2.4 用 synchsafe；v2.3 用普通 32 位（常见书写差异都兼容）
      size = major === 4 ? synchsafe(buf, pos + 4) : be32(buf, pos + 4);
      pos += 10; // id(4)+size(4)+flags(2)
    }
    if (!/^[A-Z0-9]+$/.test(id) || size <= 0 || pos + size > limit) break;
    sawFrame = true;
    const frameData = buf.subarray(pos, pos + size);
    const encoding = frameData[0];
    switch (id) {
      case 'TIT2':
      case 'TT2':
        out.title = out.title ?? decodeText(encoding, frameData.subarray(1));
        break;
      case 'TPE1':
      case 'TP1':
        out.artist = out.artist ?? decodeText(encoding, frameData.subarray(1));
        break;
      case 'TALB':
      case 'TAL':
        out.album = out.album ?? decodeText(encoding, frameData.subarray(1));
        break;
      case 'TPE2':
      case 'TP2':
        out.albumartist = out.albumartist ?? decodeText(encoding, frameData.subarray(1));
        break;
      case 'TRCK':
      case 'TRK':
        out.trackNo = out.trackNo ?? parsePair(decodeText(encoding, frameData.subarray(1)));
        break;
      case 'TPOS':
        out.discNo = out.discNo ?? parsePair(decodeText(encoding, frameData.subarray(1)));
        break;
      case 'TLEN':
      case 'TLE': {
        // 毫秒（iTunes 等非 LAME 编码器的 VBR 文件只有这个）
        const ms = parsePair(decodeText(encoding, frameData.subarray(1)));
        if (ms !== undefined && ms > 0) out.duration = out.duration ?? ms / 1000;
        break;
      }
      case 'TYER':
      case 'TDRC':
        out.year = out.year ?? parsePair(decodeText(encoding, frameData.subarray(1)));
        break;
      case 'USLT': {
        // enc(1) + lang(3) + descriptor(terminat­ed) + text
        let d = 4;
        while (d < frameData.length && !(frameData[d] === 0 && frameData[d + 1] === 0)) d += encoding === 1 || encoding === 2 ? 2 : 1;
        d += encoding === 1 || encoding === 2 ? 2 : 1;
        const text = decodeText(encoding, frameData.subarray(d));
        out.lyrics = out.lyrics ?? (text || undefined);
        break;
      }
      case 'APIC': {
        // enc(1) + mime(terminated) + type(1) + desc(terminated) + data
        let p = 1;
        while (p < frameData.length && frameData[p] !== 0) p++;
        p++;
        p++; // picture type
        const descTerm = encoding === 1 || encoding === 2 ? 2 : 1;
        while (p + descTerm <= frameData.length && !(frameData[p] === 0 && frameData[p + descTerm - 1] === 0)) p += descTerm;
        p += descTerm;
        if (frameData.subarray(p).length > 8) out.hasCover = true;
        break;
      }
      default:
        break;
    }
    pos += size;
  }
  if (!sawFrame) return null;
  // 时长（QYP3-052）：Xing/Info 的总帧数最准 → 退到 ID3 的 TLEN → 再退到
  // "前 40 帧码率完全一致"的 CBR 估算（VBR 无 Xing 的一律留空，见 mp3CbrDuration）
  if (out.duration !== undefined && plausibleDuration(out.duration) === null) out.duration = undefined;
  if (out.duration === undefined) {
    // 音频起点 = 标签块结束（v2.4 带 footer 时再 +10）
    const audioStart = Math.min(
      limit + (major === 4 && (buf[5] & 0x10) !== 0 ? 10 : 0),
      buf.length
    );
    const fromFrames = plausibleDuration(mp3FrameDuration(buf, audioStart));
    if (fromFrames !== null) out.duration = fromFrames;
    else {
      const cbr = plausibleDuration(mp3CbrDuration(buf, audioStart, fileSize));
      if (cbr !== null) out.duration = cbr;
    }
  }
  return out;
}

/** FLAC：STREAMINFO(时长) + VORBIS_COMMENT + PICTURE。 */
function parseFlac(buf: Uint8Array): ParsedAudioTags | null {
  if (buf.length < 8) return null;
  if (String.fromCharCode(...buf.subarray(0, 4)) !== 'fLaC') return null;
  let pos = 4;
  const out: ParsedAudioTags = { hasCover: false, format: 'flac' };
  while (pos + 4 <= buf.length) {
    const header = buf[pos];
    const last = (header & 0x80) !== 0;
    const kind = header & 0x7f;
    const size = (buf[pos + 1] << 16) | (buf[pos + 2] << 8) | buf[pos + 3];
    pos += 4;
    if (pos + size > buf.length) break;
    const body = buf.subarray(pos, pos + size);
    if (kind === 0 && body.length >= 18) {
      // STREAMINFO: 64 bits @ byte10 = sampleRate(20)|channels(3)|bps(5)|total(36)
      const hi = be32(body, 10);
      const lo = be32(body, 14);
      const sr = hi >>> 12;
      const total = (hi & 0xf) * 0x100000000 + lo;
      if (sr > 0 && total > 0) out.duration = total / sr;
    } else if (kind === 4) {
      let p = 0;
      const vlen = le32(body, 0);
      p += 4 + vlen;
      const count = le32(body, p);
      p += 4;
      for (let i = 0; i < count && p + 4 <= body.length; i++) {
        const clen = le32(body, p);
        p += 4;
        const entry = new TextDecoder('utf-8').decode(body.subarray(p, p + clen));
        p += clen;
        const eq = entry.indexOf('=');
        if (eq === -1) continue;
        const key = entry.slice(0, eq).toUpperCase();
        const value = entry.slice(eq + 1);
        switch (key) {
          case 'TITLE': out.title = out.title ?? value0(value); break;
          case 'ARTIST': out.artist = out.artist ?? value; break;
          case 'ALBUM': out.album = out.album ?? value; break;
          case 'ALBUMARTIST': case 'ALBUM ARTIST': out.albumartist = out.albumartist ?? value; break;
          case 'TRACKNUMBER': out.trackNo = out.trackNo ?? parsePair(value); break;
          case 'DISCNUMBER': out.discNo = out.discNo ?? parsePair(value); break;
          case 'DATE': case 'YEAR': out.year = out.year ?? parsePair(value); break;
          case 'LYRICS': case 'UNSYNCEDLYRICS': case 'UNSYNCED LYRICS': out.lyrics = out.lyrics ?? (value || undefined); break;
          default: break;
        }
      }
    } else if (kind === 6) {
      if (body.length > 32) out.hasCover = true;
    }
    pos += size;
    if (last) break;
  }
  return out;
}
// value0 占位避免 lint：Vorbis 解构用的辅助
function value0(v: string): string {
  return v;
}

/** m4a: 走 atom 树 moov.udta.meta.ilst；时长取 moov.mvhd。 */
function parseM4a(buf: Uint8Array): ParsedAudioTags | null {
  // ftyp 检测（宽松：至少能找到顶层 atom）
  let pos = 0;
  let moov: { start: number; size: number } | null = null;
  while (pos + 8 <= buf.length) {
    const size = be32(buf, pos);
    if (size < 8 || pos + size > buf.length) break;
    const type = String.fromCharCode(buf[pos + 4], buf[pos + 5], buf[pos + 6], buf[pos + 7]);
    if (type === 'moov') moov = { start: pos, size };
    pos += size;
  }
  if (!moov) return null;
  const out: ParsedAudioTags = { hasCover: false, format: 'm4a' };
  const moovBuf = buf.subarray(moov.start + 8, moov.start + moov.size);
  let p = 0;
  let mvhd: number | undefined;
  let ilstBuf: Uint8Array | null = null;
  while (p + 8 <= moovBuf.length) {
    const size = be32(moovBuf, p);
    if (size < 8 || p + size > moovBuf.length) break;
    const type = String.fromCharCode(moovBuf[p + 4], moovBuf[p + 5], moovBuf[p + 6], moovBuf[p + 7]);
    if (type === 'mvhd' && size >= 20) {
      // mvhdBuf 含 8 字节 atom 头；payload: version+flags(4)+ctime(4)+
      // mtime(4)+timescale(4)+duration(4) → timescale@p+16, duration@p+20
      const timescale = be32(moovBuf, p + 16);
      const duration = be32(moovBuf, p + 20);
      if (timescale > 0) mvhd = duration / timescale;
    } else if (type === 'udta') {
      const udtaBuf = moovBuf.subarray(p + 8, p + size);
      let q = 0;
      while (q + 8 <= udtaBuf.length) {
        const s2 = be32(udtaBuf, q);
        if (s2 < 8 || q + s2 > udtaBuf.length) break;
        const t2 = String.fromCharCode(udtaBuf[q + 4], udtaBuf[q + 5], udtaBuf[q + 6], udtaBuf[q + 7]);
        if (t2 === 'meta') {
          // meta: version/flags(4) 然后子 atom
          let r = q + 12;
          while (r + 8 <= q + s2) {
            const s3 = be32(udtaBuf, r);
            if (s3 < 8 || r + s3 > q + s2) break;
            const t3 = String.fromCharCode(udtaBuf[r + 4], udtaBuf[r + 5], udtaBuf[r + 6], udtaBuf[r + 7]);
            if (t3 === 'ilst') ilstBuf = udtaBuf.subarray(r + 8, r + s3);
            r += s3;
          }
        }
        q += s2;
      }
    }
    p += size;
  }
  if (mvhd !== undefined) out.duration = mvhd;
  if (!ilstBuf) return out;
  // ilst 内条目：每个是 type atom，内嵌 data atom（type+flags+locale+payload）
  let q = 0;
  while (q + 8 <= ilstBuf.length) {
    const size = be32(ilstBuf, q);
    if (size < 8 || q + size > ilstBuf.length) break;
    const typRaw = ilstBuf.subarray(q + 4, q + 8);
    const typ = String.fromCharCode(...typRaw);
    // data atom: size(4) 'data' flags(4) locale(4) payload
    const dsize = be32(ilstBuf, q + 8);
    const flags = be32(ilstBuf, q + 16) & 0xffffff;
    const payload = ilstBuf.subarray(q + 24, q + 8 + dsize);
    const key = typRaw[0] === 0xa9 ? `©${String.fromCharCode(...typRaw.subarray(1))}` : typ;
    switch (key) {
      case '©nam': out.title = out.title ?? textOf(payload); break;
      case '©ART': out.artist = out.artist ?? textOf(payload); break;
      case 'aART': out.albumartist = out.albumartist ?? textOf(payload); break;
      case '©alb': out.album = out.album ?? textOf(payload); break;
      case 'trkn': {
        // box: track(2 BE) + total(2 BE)，标准整数序
        const n = payload.length >= 2 ? (payload[0] << 8) | payload[1] : 0;
        if (n > 0) out.trackNo = out.trackNo ?? n;
        break;
      }
      case 'disk': {
        const n = payload.length >= 2 ? (payload[0] << 8) | payload[1] : 0;
        if (n > 0) out.discNo = out.discNo ?? n;
        break;
      }
      case '©day': out.year = out.year ?? parsePair(textOf(payload)); break;
      case '©lyr': out.lyrics = out.lyrics ?? (textOf(payload) || undefined); break;
      case 'covr': if (flags === 13 || flags === 14 || payload.length > 8) out.hasCover = true; break;
      default: break;
    }
    q += size;
  }
  return out;
}

function textOf(buf: Uint8Array): string {
  return new TextDecoder('utf-8').decode(buf).replace(/\u0000+$/, '').trim();
}

/** APEv2 文件尾（ape/wv/部分 mp3）：只读 UTF-8 文本项。 */
function parseApe(buf: Uint8Array): ParsedAudioTags | null {
  // footer: "APETAGEX" + version(4) + size(4) + itemCount(4) + flags(4)
  const needle = 'APETAGEX';
  let found = -1;
  for (let i = buf.length - 32; i >= 0; i--) {
    if (String.fromCharCode(...buf.subarray(i, i + 8)) === needle) {
      found = i;
      break;
    }
  }
  if (found === -1 || found + 32 > buf.length) return null;
  const tagSize = be32(buf, found + 12);
  const start = Math.max(0, found + 32 - tagSize);
  const body = buf.subarray(start, found + 32);
  const itemCount = be32(buf, found + 16);
  let p = 0;
  const out: ParsedAudioTags = { hasCover: false, format: 'ape' };
  let saw = false;
  for (let i = 0; i < itemCount && p + 8 <= body.length; i++) {
    const vsize = be32(body, p);
    const flags = be32(body, p + 4);
    let klen = 0;
    while (p + 8 + klen < body.length && body[p + 8 + klen] !== 0) klen++;
    const key = new TextDecoder('latin1').decode(body.subarray(p + 8, p + 8 + klen)).toUpperCase();
    p += 8 + klen + 1;
    if (p + vsize > body.length) break;
    const value = body.subarray(p, p + vsize);
    p += vsize;
    if ((flags & 0x6) !== 0) continue; // 只读 UTF-8 文本
    const text = new TextDecoder('utf-8').decode(value).replace(/\u0000.*$/, '').trim();
    if (!text) continue;
    saw = true;
    switch (key) {
      case 'TITLE': out.title = out.title ?? text; break;
      case 'ARTIST': out.artist = out.artist ?? text; break;
      case 'ALBUM': out.album = out.album ?? text; break;
      case 'TRACK': out.trackNo = out.trackNo ?? parsePair(text); break;
      case 'YEAR': out.year = out.year ?? parsePair(text); break;
      case 'LYRICS': out.lyrics = out.lyrics ?? text; break;
      case 'COVER ART': out.hasCover = true; break;
      default: break;
    }
  }
  if (!saw) return null;
  return out;
}

function mergeFilenameFallback(
  parsed: ParsedAudioTags,
  fallback?: { title?: string; artist?: string; trackNo?: number }
): ParsedAudioTags {
  if (!parsed.title && fallback?.title) parsed.title = fallback.title;
  if (!parsed.artist && fallback?.artist) parsed.artist = fallback.artist;
  if (parsed.trackNo === undefined && fallback?.trackNo !== undefined) parsed.trackNo = fallback.trackNo;
  return parsed;
}

/**
 * 解析音频文件标签。任何失败（不存在/损坏/未知格式）都返回可用的
 * 部分结果而不是 throw；调用方负责用文件名推断兜底（fallback）。
 */
export async function parseAudioTags(
  filePath: string,
  fallback?: { title?: string; artist?: string; trackNo?: number }
): Promise<ParsedAudioTags> {
  let buf: Buffer;
  try {
    buf = await readFile(filePath);
  } catch {
    return mergeFilenameFallback({ hasCover: false, format: 'unknown' }, fallback);
  }
  return parseAudioTagsFromBuffer(buf, fallback, buf.length);
}

/**
 * 缓冲区入口：扫描器已经把字节读在手里时避免二次 IO。
 *
 * `fileSize` 是**完整文件大小**（缓冲区可能只有头部 512 KiB）：CBR mp3 靠它
 * 反推时长，缺省就不做这个估算（宁可留空）。
 */
export function parseAudioTagsFromBuffer(
  buf: Buffer,
  fallback?: { title?: string; artist?: string; trackNo?: number },
  fileSize?: number
): ParsedAudioTags {
  try {
    const parsed =
      parseId3(buf, fileSize) ??
      parseFlac(buf) ??
      parseM4a(buf) ??
      parseApe(buf) ??
      ({ hasCover: false, format: 'unknown' } as ParsedAudioTags);
    if (parsed.duration === undefined) {
      // APE 音频（`MAC ` 头）与"没有 ID3 头的裸 mp3"：时长不在标签里，单独取
      const ape = plausibleDuration(apeAudioDuration(buf));
      if (ape !== null) parsed.duration = ape;
      else if (parsed.format === 'ape' || parsed.format === 'unknown') {
        const bare = plausibleDuration(mp3FrameDuration(buf, 0));
        if (bare !== null) parsed.duration = bare;
        else {
          const cbr = plausibleDuration(mp3CbrDuration(buf, 0, fileSize));
          if (cbr !== null) parsed.duration = cbr;
        }
      }
    }
    return mergeFilenameFallback(parsed, fallback);
  } catch {
    return mergeFilenameFallback({ hasCover: false, format: 'unknown' }, fallback);
  }
}
