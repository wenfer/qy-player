import { describe, expect, it } from 'vitest';
import { lyricsToLrc } from '../../../src/main/modules/online-connector/lyrics';

/**
 * 服务器歌词 → LRC 归一（QYP3-020b）：Jellyfin 返回结构化行（Text + Start
 * ticks），下游（面板/桌面歌词）只认 LRC 文本。
 */

describe('lyricsToLrc (QYP3-020b)', () => {
  it('stamps ticks as [mm:ss.xx] and keeps order', () => {
    const lrc = lyricsToLrc({
      Lyrics: [
        { Text: '第一行', Start: 10_000_000 }, // 1s
        { Text: '第二行', Start: 655_000_000 }, // 65.5s
      ],
    });
    expect(lrc).toBe('[00:01.00]第一行\n[01:05.50]第二行');
  });

  it('drops empty/blank text lines and trims', () => {
    const lrc = lyricsToLrc({
      Lyrics: [
        { Text: '', Start: 0 },
        { Text: '   ', Start: 1_000_000 },
        { Text: '  有词  ', Start: 2_000_000 },
      ],
    });
    expect(lrc).toBe('[00:00.20]有词');
  });

  it('falls back to 0s for lines without a usable Start', () => {
    const lrc = lyricsToLrc({
      Lyrics: [
        { Text: '无时间' },
        { Text: '负值', Start: -5 },
        { Text: '非数字', Start: Number.NaN },
      ],
    });
    expect(lrc).toBe('[00:00.00]无时间\n[00:00.00]负值\n[00:00.00]非数字');
  });

  it('returns null when there is nothing to show', () => {
    expect(lyricsToLrc(null)).toBeNull();
    expect(lyricsToLrc(undefined)).toBeNull();
    expect(lyricsToLrc({ Lyrics: [] })).toBeNull();
    expect(lyricsToLrc({ Lyrics: [{ Text: '' }] })).toBeNull();
    // Emby 无端点：客户端已返回 null
    expect(lyricsToLrc({ Lyrics: undefined as never })).toBeNull();
  });

  it('produces text the local LRC parser can read back', () => {
    const lrc = lyricsToLrc({ Lyrics: [{ Text: '晴天', Start: 5_000_000 }] })!;
    expect(lrc).toMatch(/^\[\d{2}:\d{2}\.\d{2}\]/);
  });
});
