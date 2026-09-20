/**
 * 离线频谱缓存文件格式（QYP3-050）。
 *
 * 精确布局（小端）：32 字节头 + `frameCount × bands` 字节帧数据，每帧一字节一频带。
 *
 * ```
 * off 0  magic       4B  'QYSP'
 * off 4  version     u16
 * off 6  bands       u16   48
 * off 8  fps         u16   12
 * off 10 sampleRate  u16   24000
 * off 12 frameCount  u32
 * off 16 fftSize     u16   2048
 * off 18 hopSize     u16   2000
 * off 20 channels    u8    1
 * off 21 flags       u8    0
 * off 22 reserved    10B   全 0
 * ```
 *
 * `fps × hop === sampleRate` **整除**（12 × 2000 = 24000），所以第 i 帧严格对应
 * `t = i / fps`：不需要每帧存时间戳，也不会有累积漂移。
 *
 * 纯函数，无 IO——落盘/读取在 `spectrum-cache.ts`。
 */

export const SPECTRUM_MAGIC = 'QYSP';
export const SPECTRUM_VERSION = 1;
export const SPECTRUM_BANDS = 48;
export const SPECTRUM_FPS = 12;
export const SPECTRUM_SAMPLE_RATE = 24000;
export const SPECTRUM_FFT_SIZE = 2048;
export const SPECTRUM_HOP_SIZE = SPECTRUM_SAMPLE_RATE / SPECTRUM_FPS;
export const SPECTRUM_HEADER_BYTES = 32;

export interface SpectrumHeader {
  version: number;
  bands: number;
  fps: number;
  sampleRate: number;
  frameCount: number;
  fftSize: number;
  hopSize: number;
  channels: number;
  flags: number;
}

export interface SpectrumFile {
  header: SpectrumHeader;
  /** `frameCount × bands` 的视图（不是拷贝）。 */
  frames: Uint8Array;
}

/** 断言帧数与频带数是否落在合理范围（防止损坏的头导致超大分配/索引越界）。 */
function isSane(header: SpectrumHeader): boolean {
  return (
    header.version === SPECTRUM_VERSION &&
    header.bands > 0 &&
    header.bands <= 1024 &&
    header.fps > 0 &&
    header.fps <= 240 &&
    header.sampleRate > 0 &&
    header.fftSize > 0 &&
    header.hopSize > 0 &&
    header.channels > 0 &&
    header.channels <= 8
  );
}

/** 频带矩阵 → 缓存文件字节（头 + 帧）。 */
export function encodeSpectrum(frames: Uint8Array[], bands = SPECTRUM_BANDS): Buffer {
  const buf = Buffer.alloc(SPECTRUM_HEADER_BYTES + frames.length * bands);
  buf.write(SPECTRUM_MAGIC, 0, 'ascii');
  buf.writeUInt16LE(SPECTRUM_VERSION, 4);
  buf.writeUInt16LE(bands, 6);
  buf.writeUInt16LE(SPECTRUM_FPS, 8);
  buf.writeUInt16LE(SPECTRUM_SAMPLE_RATE, 10);
  buf.writeUInt32LE(frames.length, 12);
  buf.writeUInt16LE(SPECTRUM_FFT_SIZE, 16);
  buf.writeUInt16LE(SPECTRUM_HOP_SIZE, 18);
  buf.writeUInt8(1, 20);
  buf.writeUInt8(0, 21);
  for (let i = 0; i < frames.length; i += 1) {
    const frame = frames[i];
    const n = Math.min(bands, frame.length);
    for (let b = 0; b < n; b += 1) buf[SPECTRUM_HEADER_BYTES + i * bands + b] = frame[b];
  }
  return buf;
}

/** 频带矩阵 → 内存中的 `SpectrumFile`（头按常量填，帧拼成连续字节）。 */
export function buildSpectrumFile(frames: Uint8Array[], bands = SPECTRUM_BANDS): SpectrumFile {
  const flat = new Uint8Array(frames.length * bands);
  frames.forEach((frame, i) => {
    flat.set(frame.subarray(0, Math.min(bands, frame.length)), i * bands);
  });
  return {
    header: {
      version: SPECTRUM_VERSION,
      bands,
      fps: SPECTRUM_FPS,
      sampleRate: SPECTRUM_SAMPLE_RATE,
      frameCount: frames.length,
      fftSize: SPECTRUM_FFT_SIZE,
      hopSize: SPECTRUM_HOP_SIZE,
      channels: 1,
      flags: 0,
    },
    frames: flat,
  };
}

/** 解析缓存文件；magic 不符、版本不符、头不自洽或长度不足一律返回 null
 * （调用方按"没有缓存"处理，损坏文件不会让播放/可视化出错）。
 */
export function parseSpectrum(buf: Uint8Array): SpectrumFile | null {
  if (!buf || buf.length < SPECTRUM_HEADER_BYTES) return null;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (String.fromCharCode(buf[0], buf[1], buf[2], buf[3]) !== SPECTRUM_MAGIC) return null;
  const header: SpectrumHeader = {
    version: view.getUint16(4, true),
    bands: view.getUint16(6, true),
    fps: view.getUint16(8, true),
    sampleRate: view.getUint16(10, true),
    frameCount: view.getUint32(12, true),
    fftSize: view.getUint16(16, true),
    hopSize: view.getUint16(18, true),
    channels: view.getUint8(20),
    flags: view.getUint8(21),
  };
  if (!isSane(header)) return null;
  const expected = SPECTRUM_HEADER_BYTES + header.frameCount * header.bands;
  if (buf.length < expected) return null; // 截断（写了一半/磁盘满）
  return {
    header,
    frames: buf.subarray(SPECTRUM_HEADER_BYTES, expected),
  };
}

/** 第 index 帧的视图；越界返回 null。 */
export function frameView(
  file: SpectrumFile,
  index: number
): Uint8Array | null {
  if (!Number.isInteger(index) || index < 0 || index >= file.header.frameCount) return null;
  const { bands } = file.header;
  return file.frames.subarray(index * bands, (index + 1) * bands);
}
