import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'events';
import {
  AutoNextController,
  pickNextEpisode,
  wireAutoNext,
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

  it('new loadfile during a pending countdown REPLACES it and broadcasts cancelled', () => {
    const { controller, events, fireTimers } = makeController();
    controller.markLoaded(EPISODE_MEDIA);
    controller.handleEof();
    const next = { ...EPISODE_MEDIA, mediaId: 'ep-3', episodeNumber: 3 };
    controller.markLoaded(next);
    fireTimers();
    expect(events.filter((e) => e.type === 'fire')).toHaveLength(0);
    expect(events.filter((e) => e.type === 'cancelled')).toHaveLength(1); // overlay must hide
    // 新集的 EOF 再次正常工作
    controller.handleEof();
    expect(events.filter((e) => e.type === 'countdown')).toHaveLength(2);
  });

  it('markLoaded for a non-episode while pending also broadcasts cancelled', () => {
    const { controller, events } = makeController();
    controller.markLoaded(EPISODE_MEDIA);
    controller.handleEof();
    controller.markLoaded({ mediaType: 'local', mediaId: '/movies/x.mkv' });
    expect(events.filter((e) => e.type === 'cancelled')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// plan §12.3 强制回归：time-pos null 与退出/断开竞态
// ---------------------------------------------------------------------------

describe('auto-next wiring regressions (§12.3 强制项)', () => {
  it('REGRESSION: the final progress save always precedes the countdown (EventEmitter order)', () => {
    // 复刻 main 侧真实注册顺序：playback-state 的 eof 保存先注册，
    // wireAutoNext 后注册 → 保存必然在倒计时广播之前执行。
    const player = new EventEmitter();
    const calls: string[] = [];
    const timers: Array<() => void> = [];
    player.on('eof', () => calls.push('save-progress'));
    const controller = new AutoNextController({
      isEnabled: () => true,
      broadcast: (event) => {
        void event;
        calls.push('countdown');
      },
      setTimer: (fn) => {
        timers.push(fn);
        return timers.length;
      },
      clearTimer: () => undefined,
    });
    wireAutoNext(player, controller);
    controller.markLoaded(EPISODE_MEDIA);
    player.emit('eof');
    expect(calls).toEqual(['save-progress', 'countdown']);
  });

  it('REGRESSION: disconnect (mpv 关窗/被杀) during countdown cancels — no fire, no resurrect', () => {
    const player = new EventEmitter();
    const { controller, events, fireTimers } = makeController();
    wireAutoNext(player, controller);
    controller.markLoaded(EPISODE_MEDIA);
    player.emit('eof');
    expect(events.filter((e) => e.type === 'countdown')).toHaveLength(1);
    // 用户在倒计时中关掉 mpv 窗口 / mpv 被杀
    player.emit('disconnect');
    fireTimers();
    expect(events.filter((e) => e.type === 'fire')).toHaveLength(0);
    expect(events.filter((e) => e.type === 'cancelled' && e.reason === 'user')).toHaveLength(1);
  });

  it('REGRESSION: crashed (mpv 崩溃/退出) during countdown cancels — no fire', () => {
    const player = new EventEmitter();
    const { controller, events, fireTimers } = makeController();
    wireAutoNext(player, controller);
    controller.markLoaded(EPISODE_MEDIA);
    player.emit('eof');
    player.emit('crashed');
    fireTimers();
    expect(events.filter((e) => e.type === 'fire')).toHaveLength(0);
    expect(events.filter((e) => e.type === 'cancelled')).toHaveLength(1);
  });

  it('REGRESSION: time-pos null at EOF — the countdown media snapshot comes from loadfile context, never from time-pos', () => {
    // AGENTS 硬约束 4：mpv 卸载文件补发 time-pos null 必须保最后真实值。
    // auto-next 的 media 快照来自 loadfile 时的 mediaContext（不消费
    // time-pos），null 无法污染它；重复 markLoaded 同一 media 也不串。
    const { controller, events } = makeController();
    controller.markLoaded(EPISODE_MEDIA);
    controller.markLoaded(EPISODE_MEDIA); // duplicate mark, same media
    controller.handleEof();
    const countdown = events.find((e) => e.type === 'countdown') as { media: typeof EPISODE_MEDIA };
    expect(countdown.media.mediaId).toBe(EPISODE_MEDIA.mediaId);
    expect(countdown.media.seasonNumber).toBe(1);
    expect(countdown.media.episodeNumber).toBe(2);
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
