import { describe, expect, it } from 'vitest';
import {
  SkipController,
  parseMediaSegments,
  resolveSkipAction,
  type SkipSegment,
} from '../../../src/main/modules/playback-state/skip-segments';

const INTRO: SkipSegment = { type: 'intro', start: 0, end: 90 };
const OUTRO: SkipSegment = { type: 'outro', start: 1150, end: 1200 };

function makeController(
  opts: Partial<{ enabledIntro: boolean; enabledOutro: boolean; onSkip: (a: { type: string }) => void }>
) {
  const fired: Array<{ type: string; seekTo: number }> = [];
  const controller = new SkipController({
    isEnabled: (type) => (type === 'intro' ? opts.enabledIntro ?? true : opts.enabledOutro ?? false),
    onSkip: (a) => {
      fired.push(a);
      opts.onSkip?.(a);
    },
  });
  return { controller, fired };
}

describe('parseMediaSegments (Jellyfin MediaSegments → SkipSegment)', () => {
  it('maps Intro→intro and Credits/Outro→outro, converts 100ns ticks', () => {
    const segs = parseMediaSegments({
      items: [
        { Type: 'Intro', StartTicks: 0, EndTicks: 900_000_000 }, // 90s
        { Type: 'Credits', StartTicks: 11_500_000_000, EndTicks: 12_000_000_000 },
        { Type: 'Outro', StartTicks: 12_100_000_000, EndTicks: 12_200_000_000 },
      ],
    });
    expect(segs).toEqual([
      { type: 'intro', start: 0, end: 90 },
      { type: 'outro', start: 1150, end: 1200 },
      { type: 'outro', start: 1210, end: 1220 },
    ]);
  });

  it('drops unknown types, invalid ticks and too-short segments (fail-open)', () => {
    const segs = parseMediaSegments({
      items: [
        { Type: 'Preview', StartTicks: 0, EndTicks: 100 },
        { Type: 'Intro', StartTicks: -5, EndTicks: 100 },
        { Type: 'Intro', StartTicks: 10, EndTicks: 5 }, // 倒挂
        { Type: 'Intro', StartTicks: 0, EndTicks: 10_000_000 }, // 1s < 3s 最短
        'garbage',
      ],
    });
    expect(segs).toEqual([]);
  });

  it('returns empty array for malformed payloads', () => {
    expect(parseMediaSegments(null)).toEqual([]);
    expect(parseMediaSegments({})).toEqual([]);
    expect(parseMediaSegments({ items: 'no' })).toEqual([]);
  });
});

describe('resolveSkipAction（纯函数）', () => {
  it('resume at 0 with intro [0,90] → seek to 90 immediately', () => {
    expect(resolveSkipAction([INTRO], 0, 1200)).toEqual({ type: 'intro', seekTo: 90 });
  });

  it('position inside intro range fires; at/after intro end does not', () => {
    expect(resolveSkipAction([INTRO], 45, 1200)).toEqual({ type: 'intro', seekTo: 90 });
    expect(resolveSkipAction([INTRO], 90, 1200)).toBeNull();
    expect(resolveSkipAction([INTRO], 89.7, 1200)).toBeNull(); // 0.5s 边缘保护
  });

  it('outro near file end lands at duration-0.8 (自然 EOF → 保存先于连播)', () => {
    expect(resolveSkipAction([OUTRO], 1160, 1200)).toEqual({ type: 'outro', seekTo: 1199.2 });
  });

  it('outro not reaching file end seeks to segment end (credits 中段)', () => {
    const seg: SkipSegment = { type: 'outro', start: 600, end: 640 };
    expect(resolveSkipAction([seg], 610, 1200)).toEqual({ type: 'outro', seekTo: 639.5 });
  });

  it('no segments / position outside all segments → null', () => {
    expect(resolveSkipAction([], 10, 1200)).toBeNull();
    expect(resolveSkipAction([INTRO], 95, 1200)).toBeNull();
  });
});

describe('SkipController（一次性触发 + 开关 + 换集重置）', () => {
  it('fires once per segment type, honors switches, resets on begin()', () => {
    const { controller, fired } = makeController({});
    controller.begin('ep1');
    controller.setSegments('ep1', [INTRO, OUTRO]);
    expect(controller.onTime(10, 1200)?.type).toBe('intro');
    expect(controller.onTime(20, 1200)).toBeNull(); // 已触发不再重复
    expect(fired).toEqual([{ type: 'intro', seekTo: 90 }]);

    controller.begin('ep2');
    controller.setSegments('ep2', [INTRO]);
    expect(controller.onTime(5, 1200)?.type).toBe('intro'); // 换集后重新可用
  });

  it('disabled type never fires; enabled switch resumes firing', () => {
    const { controller, fired } = makeController({ enabledIntro: false });
    controller.begin('ep1');
    controller.setSegments('ep1', [INTRO]);
    expect(controller.onTime(10, 1200)).toBeNull();
    expect(fired).toEqual([]);
  });

  it('segments arriving before begin() survive the loadfile reset (fetch 竞态)', () => {
    const { controller } = makeController({});
    // resolve 时即 fetch → setSegments 先于 LOAD_FILE 的 begin()
    controller.setSegments('ep1', [INTRO]);
    controller.begin('ep1');
    expect(controller.onTime(10, 1200)?.type).toBe('intro');
  });

  it('inactive key (movies/local) never fires even with stale segments', () => {
    const { controller, fired } = makeController({});
    controller.setSegments('ep1', [INTRO]);
    controller.begin(null); // 电影/本地 → null
    expect(controller.onTime(10, 1200)).toBeNull();
    expect(fired).toEqual([]);
  });

  it('outro seek lands at duration-0.8 so eof fires before auto-next countdown', () => {
    const { controller, fired } = makeController({ enabledOutro: true });
    controller.begin('ep1');
    controller.setSegments('ep1', [OUTRO]);
    const action = controller.onTime(1160, 1200);
    expect(action).toEqual({ type: 'outro', seekTo: 1199.2 });
    expect(fired).toEqual([{ type: 'outro', seekTo: 1199.2 }]);
  });
});
