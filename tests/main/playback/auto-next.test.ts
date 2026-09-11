import { describe, expect, it } from 'vitest';
import {
  AutoNextController,
  pickNextEpisode,
  type AutoNextEpisodeLike,
  type AutoNextEvent,
} from '../../../src/main/modules/playback-state/auto-next';

/**
 * QYP2-035 表驱动测试（plan §12.3）：EOF 去重、非自然 EOF 不触发、
 * 设置关闭、取消、下一集选择（跨季/特别篇）。
 */

function episodes(): AutoNextEpisodeLike[] {
  return [
    { itemId: 's1e1', seasonNumber: 1, episodeNumber: 1, title: '第一集' },
    { itemId: 's1e2', seasonNumber: 1, episodeNumber: 2, title: '第二集' },
    { itemId: 'sp', seasonNumber: 0, episodeNumber: 1, title: '特别篇' },
    { itemId: 's2e1', seasonNumber: 2, episodeNumber: 1, title: '第二季第一集' },
  ];
}

describe('pickNextEpisode (下一集选择, 纯函数)', () => {
  it('same-season next', () => {
    expect(pickNextEpisode(episodes(), 1, 1)?.itemId).toBe('s1e2');
  });

  it('season finale → next season episode 1', () => {
    expect(pickNextEpisode(episodes(), 1, 2)?.itemId).toBe('s2e1');
  });

  it('specials (S0) participate in the same ordering', () => {
    expect(pickNextEpisode(episodes(), 0, 1)?.itemId).toBe('s1e1');
  });

  it('missing current season/episode → earliest episode', () => {
    expect(pickNextEpisode(episodes(), null, null)?.itemId).toBe('sp');
  });

  it('last episode → null (renderer must not show a countdown)', () => {
    expect(pickNextEpisode(episodes(), 2, 1)).toBeNull();
    expect(pickNextEpisode([], 1, 1)).toBeNull();
  });
});

interface Harness {
  events: AutoNextEvent[];
  controller: AutoNextController;
  fireTimers: () => void;
}

function makeController(over: { enabled?: boolean } = {}): Harness {
  const events: AutoNextEvent[] = [];
  const timers: Array<() => void> = [];
  const controller = new AutoNextController({
    isEnabled: () => over.enabled ?? true,
    broadcast: (event) => events.push(event),
    setTimer: (fn) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimer: () => undefined,
  });
  return {
    events,
    controller,
    fireTimers: () => {
      const pending = [...timers];
      timers.length = 0;
      pending.forEach((fn) => fn());
    },
  };
}

const EPISODE_MEDIA = {
  mediaType: 'jellyfin',
  mediaId: 'ep-2',
  seriesName: '示例剧集',
  seasonNumber: 1,
  episodeNumber: 2,
};

describe('AutoNextController (§12.3)', () => {
  it('natural EOF → countdown broadcast (5s) → fire', () => {
    const { controller, events, fireTimers } = makeController();
    controller.markLoaded(EPISODE_MEDIA);
    controller.handleEof();
    expect(events).toEqual([{ type: 'countdown', seconds: 5, media: EPISODE_MEDIA }]);
    fireTimers();
    expect(events[1]).toEqual({ type: 'fire', media: EPISODE_MEDIA });
  });

  it('duplicate EOF for the same media fires only once (eof-reached repeats)', () => {
    const { controller, events, fireTimers } = makeController();
    controller.markLoaded(EPISODE_MEDIA);
    controller.handleEof();
    controller.handleEof();
    controller.handleEof();
    fireTimers();
    const countdowns = events.filter((e) => e.type === 'countdown');
    const fires = events.filter((e) => e.type === 'fire');
    expect(countdowns).toHaveLength(1);
    expect(fires).toHaveLength(1);
    expect(events.filter((e) => e.type === 'ignored' && e.reason === 'duplicate')).toHaveLength(2);
  });

  it('a NEW loadfile resets the dedupe anchor (next EOF counts again)', () => {
    const { controller, events, fireTimers } = makeController();
    controller.markLoaded(EPISODE_MEDIA);
    controller.handleEof();
    fireTimers();
    const next = { ...EPISODE_MEDIA, mediaId: 'ep-3', episodeNumber: 3 };
    controller.markLoaded(next);
    controller.handleEof();
    expect(events.filter((e) => e.type === 'countdown')).toHaveLength(2);
    fireTimers();
    expect(events[events.length - 1]).toEqual({ type: 'fire', media: next });
  });

  it('movies (no season/episode/series) never trigger — ignored, not cancelled', () => {
    const { controller, events } = makeController();
    controller.markLoaded({ mediaType: 'local', mediaId: '/path/movie.mkv' });
    controller.handleEof();
    expect(events).toEqual([{ type: 'ignored', reason: 'not-episode' }]);
  });

  it('setting disabled → no countdown (explicit cancelled-by-setting event)', () => {
    const { controller, events } = makeController({ enabled: false });
    controller.markLoaded(EPISODE_MEDIA);
    controller.handleEof();
    expect(events).toEqual([{ type: 'cancelled', reason: 'setting' }]);
  });

  it('user cancel during countdown → cancelled, timer cleared, no fire', () => {
    const { controller, events, fireTimers } = makeController();
    controller.markLoaded(EPISODE_MEDIA);
    controller.handleEof();
    controller.cancel('user');
    fireTimers();
    expect(events.filter((e) => e.type === 'cancelled' && e.reason === 'user')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'fire')).toHaveLength(0);
  });

  it('renderer reports no-next-episode (最后一集) → cancelled, no fire', () => {
    const { controller, events, fireTimers } = makeController();
    controller.markLoaded(EPISODE_MEDIA);
    controller.handleEof();
    controller.cancel('no-next-episode');
    fireTimers();
    expect(events.filter((e) => e.type === 'cancelled' && e.reason === 'no-next-episode')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'fire')).toHaveLength(0);
  });

  it('cancel with nothing pending is a no-op (no stray events)', () => {
    const { controller, events } = makeController();
    controller.cancel('user');
    expect(events).toEqual([]);
  });

  it('eof before any loadfile is ignored (no current media)', () => {
    const { controller, events } = makeController();
    controller.handleEof();
    expect(events).toEqual([]);
  });

  it('new loadfile during a pending countdown replaces it (无进度串集)', () => {
    const { controller, events, fireTimers } = makeController();
    controller.markLoaded(EPISODE_MEDIA);
    controller.handleEof();
    const next = { ...EPISODE_MEDIA, mediaId: 'ep-3', episodeNumber: 3 };
    // 用户在倒计时期间手动点了另一集
    controller.markLoaded(next);
    fireTimers();
    expect(events.filter((e) => e.type === 'fire')).toHaveLength(0);
    expect(events.filter((e) => e.type === 'countdown')).toHaveLength(1);
  });
});
