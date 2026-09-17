import { describe, expect, it } from 'vitest';
import { parseLrc, findCurrentLine, findNextLine } from '../../../src/main/modules/playback-engine/lrc-parser';

const SAMPLE = `[ti:晴天]
[ar:周杰伦]
[al:叶惠美]
[offset:500]
[00:01.50]以父之名
[00:16.90][01:30.20]多时间标签行
[00:32.43]开不了口
[00:45.00]<00:45.00>逐<00:45.50>字<00:46.00>行
[03:21.00]结尾行
`;

describe('lrc parser (QYP3-018)', () => {
  it('parses metadata, timestamps, offset and sorts lines', () => {
    const { lines, meta, warnings } = parseLrc(SAMPLE);
    expect(meta).toMatchObject({ title: '晴天', artist: '周杰伦', album: '叶惠美', offset: 500 });
    expect(lines).toHaveLength(6);
    // 500ms 偏移提前（正 offset = 提前）
    expect(lines[0]).toMatchObject({ time: 1, text: '以父之名' });
    // 多时间标签 → 同文本两行
    expect(lines.map((l) => l.text)).toContain('多时间标签行');
    expect(lines.filter((l) => l.text === '多时间标签行')).toHaveLength(2);
    expect(lines[lines.length - 1]).toMatchObject({ time: 200.5, text: '结尾行' });
    expect(warnings).toEqual([]);
  });

  it('captures per-word times from enhanced LRC', () => {
    const { lines } = parseLrc(SAMPLE);
    const wordLine = lines.find((l) => l.words !== undefined)!;
    expect(wordLine.text).toBe('逐字行');
    expect(wordLine.words).toHaveLength(3);
    expect(wordLine.words![0]).toMatchObject({ time: 45, text: '逐' });
  });

  it('tolerates junk lines without failing', () => {
    const { warnings, lines } = parseLrc('garbage line\n[01:00.00]正常\n');
    expect(lines).toHaveLength(1);
    expect(warnings).toEqual(['garbage line']);
  });

  it('findCurrentLine / findNextLine binary search semantics', () => {
    const { lines } = parseLrc('[00:10.00]A\n[00:20.00]B\n[00:30.00]C\n');
    expect(findCurrentLine(lines, 0)).toBe(-1);
    expect(findCurrentLine(lines, 10)).toBe(0);
    expect(findCurrentLine(lines, 19.99)).toBe(0);
    expect(findCurrentLine(lines, 20.01)).toBe(1);
    expect(findCurrentLine(lines, 100)).toBe(2);
    expect(findNextLine(lines, 0)).toBe(0); // 下一行被 clamp
    expect(findNextLine(lines, 20.01)).toBe(2);
  });

  it('negative offset shifts lines later', () => {
    const { lines } = parseLrc('[offset:-1000]\n[00:10.00]A\n');
    expect(lines[0].time).toBe(11);
  });

  it('strips UTF-8 BOM before parsing', () => {
    const { lines, warnings } = parseLrc('﻿[00:01.00]A\n');
    expect(lines).toHaveLength(1);
    expect(lines[0].time).toBe(1);
    expect(warnings).toEqual([]);
  });

  it('handles CRLF endings and skips blank lines', () => {
    const { lines, warnings } = parseLrc('[00:01.00]A\r\n\r\n   \r\n[00:02.00]B\r\n');
    expect(lines.map((l) => l.text)).toEqual(['A', 'B']);
    expect(warnings).toEqual([]);
  });

  it('supports minutes beyond 99 and colon fraction separator', () => {
    const { lines } = parseLrc('[123:45:20]长音频\n');
    expect(lines[0].time).toBeCloseTo(123 * 60 + 45 + 0.2, 6);
  });

  it('parses fractional seconds with 1/2/3 digits', () => {
    const { lines } = parseLrc('[00:01.5]A\n[00:02.05]B\n[00:03.005]C\n');
    expect(lines[0].time).toBeCloseTo(1.5, 6);
    expect(lines[1].time).toBeCloseTo(2.05, 6);
    expect(lines[2].time).toBeCloseTo(3.005, 6);
  });

  it('sorts out-of-order lines by time', () => {
    const { lines } = parseLrc('[00:30.00]C\n[00:10.00]A\n[00:20.00]B\n');
    expect(lines.map((l) => l.text)).toEqual(['A', 'B', 'C']);
  });

  it('ignores known non-lyric meta tags but warns on unknown brackets', () => {
    const { lines, warnings, meta } = parseLrc('[by:某人]\n[re:editor]\n[ve:1.0]\n[foo:bar]\n[00:01.00]A\n');
    expect(lines).toHaveLength(1);
    expect(meta.offset).toBe(0);
    expect(warnings).toEqual(['[foo:bar]']);
  });

  it('ignores non-numeric offset values', () => {
    const { meta, lines } = parseLrc('[offset:abc]\n[00:10.00]A\n');
    expect(meta.offset).toBe(0);
    expect(lines[0].time).toBe(10);
  });

  it('keeps timestamp-only lines as instrumental markers', () => {
    const { lines, warnings } = parseLrc('[00:10.00]\n[00:20.00]B\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ time: 10, text: '' });
    expect(warnings).toEqual([]);
  });

  it('keeps inline bracket text that is not at line start', () => {
    const { lines } = parseLrc('[00:10.00]说 [01:00] 什么\n');
    expect(lines[0].text).toBe('说 [01:00] 什么');
  });

  it('expands multi-time tags on enhanced lines to one line per tag', () => {
    const { lines } = parseLrc('[00:45.00][01:45.00]<00:45.00>逐<00:45.50>字\n');
    expect(lines).toHaveLength(2);
    expect(lines[0].time).toBe(45);
    expect(lines[1].time).toBe(105);
    expect(lines[0].words).toHaveLength(2);
    expect(lines[1].words).toHaveLength(2);
  });

  it('preserves duplicate timestamps in stable order', () => {
    const { lines } = parseLrc('[00:10.00]A\n[00:10.00]B\n');
    expect(lines.map((l) => l.text)).toEqual(['A', 'B']);
  });

  it('returns empty structure for empty content', () => {
    const { lines, meta, warnings } = parseLrc('');
    expect(lines).toEqual([]);
    expect(meta.offset).toBe(0);
    expect(warnings).toEqual([]);
    expect(findCurrentLine(lines, 5)).toBe(-1);
  });

  it('clamps negative line time to zero after offset', () => {
    const { lines } = parseLrc('[offset:2000]\n[00:01.00]A\n');
    expect(lines[0].time).toBe(0);
  });

  it('keeps leading text before the first word tag in line text', () => {
    const { lines } = parseLrc('[00:10.00]你好<00:10.50>世<00:11.00>界\n');
    expect(lines[0].text).toBe('你好世界');
    expect(lines[0].words).toEqual([
      { time: 10.5, text: '世' },
      { time: 11, text: '界' },
    ]);
  });
});
