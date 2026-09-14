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

export interface ParsedAudioTags {
  title?: string;
  artist?: string;
  album?: string;
  albumartist?: string;
  trackNo?: number;
  discNo?: number;
  year?: number;
  /** FLAC STREAMINFO / m4a mvhd；mp3 不可靠故不估。 */
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

function parseId3(buf: Uint8Array): ParsedAudioTags | null {
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
  try {
    const parsed =
      parseId3(buf) ??
      parseFlac(buf) ??
      parseM4a(buf) ??
      parseApe(buf) ??
      ({ hasCover: false, format: 'unknown' } as ParsedAudioTags);
    return mergeFilenameFallback(parsed, fallback);
  } catch {
    return mergeFilenameFallback({ hasCover: false, format: 'unknown' }, fallback);
  }
}
