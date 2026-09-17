import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  extractCoverBytes,
  readLyricsCache,
  registerCoversPartition,
  registerLyricsPartition,
  resolveCoverFileName,
  saveCoverFromTags,
  saveLyricsFromTags,
} from '../../../src/main/modules/library-scanner/cover-service';
import { CacheManager } from '../../../src/main/modules/cache/cache-manager';

const dir = join(__dirname, '../../fixtures/audio');
const tmpRoots: string[] = [];
afterAll(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
});

describe('cover service (QYP3-005)', () => {
  it('extracts ID3 APIC bytes from the head buffer', () => {
    const buf = readFileSync(join(dir, 'sample-id3v23.mp3'));
    const cover = extractCoverBytes(buf);
    expect(cover).not.toBeNull();
    expect(cover!.data.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47])); // PNG magic
  });

  it('extracts FLAC PICTURE and m4a covr', () => {
    const flac = extractCoverBytes(readFileSync(join(dir, 'sample.flac')));
    expect(flac).not.toBeNull();
    expect(flac!.data.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const m4a = extractCoverBytes(readFileSync(join(dir, 'sample.m4a')));
    expect(m4a).not.toBeNull();
    expect(m4a!.data.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  it('returns null for tagless/garbage buffers', () => {
    expect(extractCoverBytes(readFileSync(join(dir, 'notags.mp3')))).toBeNull();
    expect(extractCoverBytes(readFileSync(join(dir, 'garbage.bin')))).toBeNull();
  });

  it('saves cover to coversDir and registers sweepable partition', async () => {
    const coversDir = mkdtempSync(join(tmpdir(), 'qy-covers-'));
    tmpRoots.push(coversDir);
    const buf = readFileSync(join(dir, 'sample-id3v23.mp3'));
    const saved = await saveCoverFromTags(12, buf, coversDir);
    expect(saved).toEqual({ file: '12.png', bytes: expect.any(Number) });
    const files = readdirSync(coversDir);
    expect(files).toEqual(['12.png']);
    expect(statSync(join(coversDir, '12.png')).size).toBeGreaterThan(8);

    const cm = new CacheManager();
    registerCoversPartition(cm, coversDir);
    const partitions = cm.list();
    expect(partitions.map((p) => p.id)).toContain('covers');
    expect(partitions.find((p) => p.id === 'covers')!.sweepable).toBe(true);
    // 清扫到 0 预算 = 全删（派生数据可再生成）
    const result = cm.sweep('covers', 1024 * 1024 * 1024);
    expect(result.deletedFiles).toBe(1);
    expect(readdirSync(coversDir)).toEqual([]);
  });

  it('returns null when the track has no embedded cover', async () => {
    const coversDir = mkdtempSync(join(tmpdir(), 'qy-covers-'));
    tmpRoots.push(coversDir);
    const saved = await saveCoverFromTags(1, readFileSync(join(dir, 'notags.mp3')), coversDir);
    expect(saved).toBeNull();
  });

  it('saves tag lyrics and registers the protected lyrics partition', async () => {
    const lyricsDir = mkdtempSync(join(tmpdir(), 'qy-lyrics-'));
    tmpRoots.push(lyricsDir);
    expect(await saveLyricsFromTags(9, lyricsDir, '[00:01.00]第一行')).toBe(true);
    expect(readdirSync(lyricsDir)).toEqual(['9.lrc']);
    expect(await readLyricsCache(9, lyricsDir)).toBe('[00:01.00]第一行');
    expect(await readLyricsCache(404, lyricsDir)).toBeNull();
    // 空歌词不落盘（has_lyrics 仍由标签决定）
    expect(await saveLyricsFromTags(9, lyricsDir, '   ')).toBe(false);

    const cm = new CacheManager();
    registerLyricsPartition(cm, lyricsDir);
    const partition = cm.list().find((p) => p.id === 'lyrics')!;
    expect(partition.sweepable).toBe(false);
    // 受保护：即使清扫也不删（人工可编辑资产）
    expect(cm.sweep('lyrics', 0).deletedFiles).toBe(0);
    expect(readdirSync(lyricsDir)).toEqual(['9.lrc']);
  });

  /**
   * QYP3-028：真实 MP3 的 APIC 几乎都是 image/jpeg，所以落盘名是
   * `<id>.jpg` 而非 `.png`。夹具里三张封面全是 PNG，这条用例专门补上
   * 唯一被漏掉的格式，避免"渲染层按 .png 请求、盘上是 .jpg"再回潮。
   */
  it('writes a .jpg file when the embedded picture is JPEG', async () => {
    const coversDir = mkdtempSync(join(tmpdir(), 'qy-covers-'));
    tmpRoots.push(coversDir);
    const buf = mp3WithApic('image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8]));

    const saved = await saveCoverFromTags(21, buf, coversDir);
    expect(saved).toEqual({ file: '21.jpg', bytes: 12 });
    expect(readdirSync(coversDir)).toEqual(['21.jpg']);
    expect(readFileSync(join(coversDir, '21.jpg')).subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  });
});

/**
 * QYP3-028：渲染层按 `<trackId>.png` 请求封面（它无从得知内嵌图片的
 * 真实格式），主进程必须按"原名→同名其他扩展名"解析。安全边界在调用方
 * 提供的 `isServed`（协议层在那里做目录包含校验），这里只验证名字解析。
 */
describe('cover file name resolution (QYP3-028)', () => {
  const served = (names: string[]) => (fileName: string) => names.includes(fileName);

  it('prefers the exact requested name', () => {
    expect(resolveCoverFileName('12.png', served(['12.png', '12.jpg']))).toBe('12.png');
    expect(resolveCoverFileName('12.jpg', served(['12.jpg', '12.png']))).toBe('12.jpg');
  });

  it('falls back to the real extension when the disk file is jpeg', () => {
    expect(resolveCoverFileName('12.png', served(['12.jpg']))).toBe('12.jpg');
  });

  it('returns null when nothing is on disk', () => {
    expect(resolveCoverFileName('12.png', served([]))).toBeNull();
  });

  it('refuses names that are not plain file names', () => {
    const always = () => true;
    expect(resolveCoverFileName('../secret', always)).toBeNull();
    expect(resolveCoverFileName('a/b.png', always)).toBeNull();
    expect(resolveCoverFileName('a\\b.png', always)).toBeNull();
    expect(resolveCoverFileName('', always)).toBeNull();
  });
});

/** 合成一个只含 APIC 帧的 ID3v2.3 头部（够 extractCoverBytes 解析）。 */
function mp3WithApic(mime: string, data: Buffer): Buffer {
  const body = Buffer.concat([
    Buffer.from([0x00]), // 编码：latin1
    Buffer.from(mime, 'latin1'),
    Buffer.from([0x00]), // MIME 结束
    Buffer.from([0x03]), // 图片类型：封面
    Buffer.from([0x00]), // 空描述
    data,
  ]);
  const frame = Buffer.concat([
    Buffer.from('APIC', 'latin1'),
    be32(body.length),
    Buffer.from([0x00, 0x00]), // flags
    body,
  ]);
  const header = Buffer.concat([
    Buffer.from('ID3', 'latin1'),
    Buffer.from([0x03, 0x00, 0x00]),
    synchsafe(frame.length),
  ]);
  return Buffer.concat([header, frame]);
}

function be32(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(value, 0);
  return buf;
}

function synchsafe(value: number): Buffer {
  return Buffer.from([(value >> 21) & 0x7f, (value >> 14) & 0x7f, (value >> 7) & 0x7f, value & 0x7f]);
}
