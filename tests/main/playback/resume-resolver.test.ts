import { describe, expect, it } from 'vitest';
import {
  hasValidProgress,
  isProgressFinished,
  resolveSeriesResume,
  resolveSingleResume,
} from '../../../src/main/modules/playback-state/resume-resolver';
import type { ResumeEpisodeInput, ResumeProgress } from '../../../src/shared/types/playback';

/**
 * QYP2-033 表驱动测试（plan §12.1/§12.2 验收全覆盖）：
 * 30s 门槛、90% 完成、看完→下一集、特别篇、全剧完成、0/null 不覆盖。
 */

function progress(over: Partial<ResumeProgress> = {}): ResumeProgress {
  return { position: 600, duration: 2400, updatedAt: 1000, ...over };
}

function ep(
  itemId: number,
  seasonNumber: number | null,
  episodeNumber: number | null,
  prog?: ResumeProgress | null
): ResumeEpisodeInput {
  return { itemId, seasonNumber, episodeNumber, progress: prog };
}

describe('resolveSingleResume (电影/单集, §12.1)', () => {
  const cases: Array<{
    name: string;
    progress: ResumeProgress | null | undefined;
    expectPosition: number;
    expectReason: 'resume' | 'start';
  }> = [
    { name: 'no history → start 0', progress: null, expectPosition: 0, expectReason: 'start' },
    { name: 'undefined history → start 0', progress: undefined, expectPosition: 0, expectReason: 'start' },
    {
      name: 'position 0 is not valid history (0 never wins)',
      progress: progress({ position: 0 }),
      expectPosition: 0,
      expectReason: 'start',
    },
    {
      name: 'below 30s threshold → start 0',
      progress: progress({ position: 29 }),
      expectPosition: 0,
      expectReason: 'start',
    },
    {
      name: 'exactly 30s → resume',
      progress: progress({ position: 30 }),
      expectPosition: 30,
      expectReason: 'resume',
    },
    {
      name: 'mid-episode → resume at position',
      progress: progress({ position: 1234, duration: 2400 }),
      expectPosition: 1234,
      expectReason: 'resume',
    },
    {
      name: '90% ratio → finished → start 0',
      progress: progress({ position: 2161, duration: 2400 }), // 90.04%
      expectPosition: 0,
      expectReason: 'start',
    },
    {
      name: 'exactly 90% is not finished (strictly greater)',
      progress: progress({ position: 2160, duration: 2400 }),
      expectPosition: 2160,
      expectReason: 'resume',
    },
    {
      name: 'isFinished flag wins over a low ratio (server-side finish)',
      progress: progress({ position: 120, duration: 2400, isFinished: true }),
      expectPosition: 0,
      expectReason: 'start',
    },
    {
      name: 'invalid duration with real position still resumes (never swallow real progress)',
      progress: progress({ position: 500, duration: 0 }),
      expectPosition: 500,
      expectReason: 'resume',
    },
    {
      name: 'NaN position is not history',
      progress: progress({ position: Number.NaN }),
      expectPosition: 0,
      expectReason: 'start',
    },
    {
      name: 'negative position is not history',
      progress: progress({ position: -5 }),
      expectPosition: 0,
      expectReason: 'start',
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const result = resolveSingleResume(c.progress);
      expect(result).toEqual({ position: c.expectPosition, reason: c.expectReason });
    });
  }
});

describe('isProgressFinished / hasValidProgress edge table', () => {
  it('duration invalid → never finished by ratio', () => {
    expect(isProgressFinished(progress({ duration: 0 }))).toBe(false);
    expect(isProgressFinished(progress({ duration: Number.NaN }))).toBe(false);
  });

  it('isFinished false does not force finish, ratio still applies', () => {
    expect(isProgressFinished(progress({ position: 2300, duration: 2400, isFinished: false }))).toBe(true);
  });

  it('hasValidProgress rejects finished snapshots even above 30s', () => {
    expect(hasValidProgress(progress({ isFinished: true }))).toBe(false);
    expect(hasValidProgress(progress())).toBe(true);
  });
});

describe('resolveSeriesResume (剧集主按钮, §12.2 规则 1–4)', () => {
  it('rule 1: last watched unfinished → resume that episode at its position', () => {
    const episodes = [
      ep(1, 1, 1, progress({ position: 2400, duration: 2400, updatedAt: 100 })), // finished
      ep(2, 1, 2, progress({ position: 700, duration: 2400, updatedAt: 900 })), // last watched
      ep(3, 1, 3, null),
    ];
    expect(resolveSeriesResume(episodes)).toEqual({
      itemId: 2,
      position: 700,
      reason: 'resume',
      seasonNumber: 1,
      episodeNumber: 2,
    });
  });

  it('rule 2: last watched finished and next exists → next episode from 0', () => {
    const episodes = [
      ep(1, 1, 1, progress({ position: 2400, duration: 2400, updatedAt: 100 })),
      ep(2, 1, 2, progress({ position: 2399, duration: 2400, updatedAt: 900 })), // 99.96% finished
      ep(3, 1, 3, null),
      ep(4, 1, 4, null),
    ];
    expect(resolveSeriesResume(episodes)).toEqual({
      itemId: 3,
      position: 0,
      reason: 'next-episode',
      seasonNumber: 1,
      episodeNumber: 3,
    });
  });

  it('rule 2 across seasons: season finale → next season episode 1', () => {
    const episodes = [
      ep(1, 1, 1, progress({ position: 2000, duration: 2400, updatedAt: 100 })),
      ep(2, 1, 2, progress({ position: 2400, duration: 2400, updatedAt: 500 })), // finished finale
      ep(3, 2, 1, null),
      ep(4, 2, 2, null),
    ];
    expect(resolveSeriesResume(episodes)).toMatchObject({
      itemId: 3,
      position: 0,
      reason: 'next-episode',
      seasonNumber: 2,
      episodeNumber: 1,
    });
  });

  it('rule 3: no valid history → first episode (sorted) from 0', () => {
    const episodes = [
      ep(2, 2, 1, null),
      ep(1, 1, 1, progress({ position: 10, duration: 2400, updatedAt: 50 })), // <30s = no history
      ep(3, 0, 1, null), // 特别篇
    ];
    expect(resolveSeriesResume(episodes)).toEqual({
      itemId: 3,
      position: 0,
      reason: 'start',
      seasonNumber: 0,
      episodeNumber: 1,
    });
  });

  it('特别篇 (S0) sorts before season 1 for next-episode ordering', () => {
    const episodes = [
      ep(1, 1, 1, progress({ position: 2400, duration: 2400, updatedAt: 100 })),
      ep(2, 0, 1, progress({ position: 1200, duration: 1800, updatedAt: 900 })), // special, last watched, unfinished
    ];
    expect(resolveSeriesResume(episodes)).toMatchObject({
      itemId: 2,
      reason: 'resume',
      position: 1200,
    });
  });

  it('special after finished special: next is S01E01, not another special', () => {
    const episodes = [
      ep(1, 1, 1, null),
      ep(2, 0, 2, progress({ position: 1800, duration: 1800, updatedAt: 300 })), // special 2 finished
      ep(3, 0, 1, progress({ position: 1800, duration: 1800, updatedAt: 200 })), // special 1 finished earlier
    ];
    expect(resolveSeriesResume(episodes)).toMatchObject({
      itemId: 1,
      position: 0,
      reason: 'next-episode',
      seasonNumber: 1,
      episodeNumber: 1,
    });
  });

  it('rule 4: everything finished → replay from the first episode', () => {
    const episodes = [
      ep(1, 1, 1, progress({ position: 2400, duration: 2400, updatedAt: 100 })),
      ep(2, 1, 2, progress({ position: 2400, duration: 2400, updatedAt: 200 })),
      ep(3, 2, 1, progress({ position: 3000, duration: 3000, updatedAt: 300 })),
    ];
    expect(resolveSeriesResume(episodes)).toEqual({
      itemId: 1,
      position: 0,
      reason: 'replay',
      seasonNumber: 1,
      episodeNumber: 1,
    });
  });

  it('unfinished episodes with <30s progress never win "last watched"', () => {
    const episodes = [
      ep(1, 1, 1, progress({ position: 2400, duration: 2400, updatedAt: 100 })), // finished
      ep(2, 1, 2, progress({ position: 5, duration: 2400, updatedAt: 999 })), // too small → ignored
      ep(3, 1, 3, null),
    ];
    expect(resolveSeriesResume(episodes)).toMatchObject({
      itemId: 2,
      reason: 'next-episode',
      position: 0,
    });
  });

  it('missing season/episode numbers sort as specials and do not crash', () => {
    const episodes = [
      ep(9, null, null, null),
      ep(1, 1, 1, progress({ position: 2400, duration: 2400, updatedAt: 100 })),
      ep(2, null, null, progress({ position: 300, duration: 2400, updatedAt: 200 })),
    ];
    const result = resolveSeriesResume(episodes);
    expect(result).toMatchObject({ itemId: 2, reason: 'resume' });
  });

  it('null progress entries are treated as unplayed (0/null never fabricates history)', () => {
    const episodes = [
      ep(1, 1, 1, null),
      ep(2, 1, 2, progress({ position: 0, updatedAt: 999 })), // position 0 = nothing
    ];
    expect(resolveSeriesResume(episodes)).toMatchObject({ itemId: 1, reason: 'start', position: 0 });
  });

  it('empty/invalid input → null (caller decides no-playable-content UX)', () => {
    expect(resolveSeriesResume([])).toBeNull();
    expect(resolveSeriesResume(null as unknown as ResumeEpisodeInput[])).toBeNull();
  });

  it('updatedAt ties fall back to watch order (first of the max wins deterministically)', () => {
    const episodes = [
      ep(1, 1, 1, progress({ position: 1000, duration: 2400, updatedAt: 500 })),
      ep(2, 1, 2, progress({ position: 800, duration: 2400, updatedAt: 500 })),
    ];
    expect(resolveSeriesResume(episodes)).toMatchObject({ itemId: 1, position: 1000, reason: 'resume' });
  });
});
