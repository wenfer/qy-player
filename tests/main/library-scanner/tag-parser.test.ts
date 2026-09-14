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
