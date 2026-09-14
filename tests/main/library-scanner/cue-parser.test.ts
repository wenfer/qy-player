import { describe, expect, it } from 'vitest';
import { cueTimeToSeconds, parseCue, validateCueAudioFiles } from '../../../src/main/modules/library-scanner/cue-parser';

const SAMPLE = `
REM GENRE Rock
PERFORMER "周杰伦"
TITLE "叶惠美"
FILE "叶惠美.wav" WAVE
  TRACK 01 AUDIO
    TITLE "以父之名"
    INDEX 01 00:00:00
  TRACK 02 AUDIO
    TITLE "懦夫"
    INDEX 01 05:10:00
  TRACK 03 AUDIO
    TITLE "晴天"
    INDEX 01 10:20:00
  TRACK 04 AUDIO
    TITLE "三分时间"
    INDEX 01 15:30:00
`;

describe('cue parser (QYP3-006)', () => {
  it('parses tracks with indices and closes adjacent intervals', () => {
    const { entries, warnings } = parseCue(SAMPLE);
    expect(warnings).toEqual([]);
    expect(entries).toHaveLength(4);
    expect(entries[0]).toMatchObject({ position: 0, title: '以父之名', start: 0, end: 310 });
    expect(entries[1]).toMatchObject({ position: 1, title: '懦夫', start: 310, end: 620 });
    expect(entries[2]).toMatchObject({ title: '晴天', start: 620, end: 930 });
    // 最后一条 end=null（播到文件末尾）
    expect(entries[3]).toMatchObject({ title: '三分时间', start: 930, end: null });
    expect(entries.every((e) => e.audioFile === '叶惠美.wav')).toBe(true);
  });

  it('converts MM:SS:FF with frame precision', () => {
    expect(cueTimeToSeconds('00:00:00')).toBe(0);
    expect(cueTimeToSeconds('01:02:37')).toBeCloseTo(62 + 37 / 75, 3);
    expect(cueTimeToSeconds('10:20:00')).toBe(620);
    expect(cueTimeToSeconds('10:2:00')).toBeUndefined();
    expect(cueTimeToSeconds('xx')).toBeUndefined();
  });

  it('tolerates missing titles/indices without failing', () => {
    const { entries, warnings } = parseCue(`
FILE "a.flac" WAVE
  TRACK 01 AUDIO
    INDEX 01 00:00:00
  TRACK 02 AUDIO
    TITLE "第二轨"
    INDEX 01 03:00:00
    TITLE "重复 TITLE 行取最后"
`);
    expect(entries.map((e) => e.title)).toEqual(['Track 1', '重复 TITLE 行取最后']);
    expect(entries[0].start).toBe(0);
    expect(entries[0].end).toBe(180);
    expect(warnings).toEqual([]);
  });

  it('sorts out-of-order entries', () => {
    const { entries } = parseCue(`
FILE "a.flac" WAVE
  TRACK 02 AUDIO
    TITLE "B"
    INDEX 01 05:00:00
  TRACK 01 AUDIO
    TITLE "A"
    INDEX 01 00:00:00
`);
    expect(entries.map((e) => e.title)).toEqual(['A', 'B']);
    expect(entries.map((e) => e.position)).toEqual([0, 1]);
  });

  it('strict validation reports referenced audio files missing from the scan batch', () => {
    const { entries } = parseCue(SAMPLE);
    const ok = validateCueAudioFiles({ entries, warnings: [] }, new Set(['叶惠美.wav']));
    expect(ok).toEqual([]);
    const missing = validateCueAudioFiles({ entries, warnings: [] }, new Set(['other.wav']));
    expect(missing).toEqual(['叶惠美.wav']);
  });
});
