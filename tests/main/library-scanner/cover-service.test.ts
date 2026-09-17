import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  extractCoverBytes,
  readLyricsCache,
  registerCoversPartition,
  registerLyricsPartition,
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
});
