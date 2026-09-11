// @vitest-environment jsdom
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SeriesResumeButton from '../../../src/renderer/pages/Detail/SeriesResumeButton';
import EpisodeGrid from '../../../src/renderer/pages/Detail/EpisodeGrid';
import type { ResumeTarget } from '../../../src/shared/types/playback';

/**
 * QYP2-034 renderer tests: 按钮文案（继续/下一集/第一集/重新播放）、
 * 两段式重播确认、单集卡进度与从头播放、focus 静默刷新。
 * 算法在 main 侧（resolveSeriesResume IPC），这里 mock 目标结果。
 */

const { addToast } = vi.hoisted(() => ({ addToast: vi.fn() }));
vi.mock('../../../src/renderer/stores/toast-store', () => ({
  useToastStore: (selector: (s: { addToast: unknown }) => unknown) => selector({ addToast }),
}));

vi.stubGlobal('electronAPI', {});

function target(over: Partial<ResumeTarget> = {}): ResumeTarget {
  return { itemId: 'ep-2', position: 700, reason: 'resume', seasonNumber: 1, episodeNumber: 2, title: '第二集', ...over };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('SeriesResumeButton 文案与行为 (§12.2)', () => {
  it('resume → 「继续播放 S01E02 · 11:40」', async () => {
    const resolve = vi.fn().mockResolvedValue(target());
    const onPlay = vi.fn();
    render(<SeriesResumeButton resolve={resolve} onPlay={onPlay} />);
    const btn = await screen.findByRole('button', { name: /继续播放 S01E02 · 11:40/ });
    fireEvent.click(btn);
    expect(onPlay).toHaveBeenCalledWith(expect.objectContaining({ itemId: 'ep-2', position: 700 }));
  });

  it('next-episode → 「播放下一集 S01E03」', async () => {
    const resolve = vi.fn().mockResolvedValue(target({ reason: 'next-episode', itemId: 'ep-3', position: 0, episodeNumber: 3 }));
    render(<SeriesResumeButton resolve={resolve} onPlay={vi.fn()} />);
    expect(await screen.findByRole('button', { name: /播放下一集 S01E03/ })).toBeTruthy();
  });

  it('start → 「播放第一集 S01E01」', async () => {
    const resolve = vi.fn().mockResolvedValue(target({ reason: 'start', itemId: 'ep-1', position: 0, episodeNumber: 1 }));
    render(<SeriesResumeButton resolve={resolve} onPlay={vi.fn()} />);
    expect(await screen.findByRole('button', { name: /播放第一集 S01E01/ })).toBeTruthy();
  });

  it('replay → 两段式确认：先「重新播放」再「确认重播」', async () => {
    const resolve = vi.fn().mockResolvedValue(target({ reason: 'replay', itemId: 'ep-1', position: 0, episodeNumber: 1 }));
    const onPlay = vi.fn();
    render(<SeriesResumeButton resolve={resolve} onPlay={onPlay} />);
    const first = await screen.findByRole('button', { name: /重新播放/ });
    fireEvent.click(first);
    // 未确认不触发播放
    expect(onPlay).not.toHaveBeenCalled();
    const confirm = await screen.findByRole('button', { name: /重新播放/ });
    fireEvent.click(confirm);
    expect(onPlay).toHaveBeenCalledTimes(1);
    expect(onPlay).toHaveBeenCalledWith(expect.objectContaining({ itemId: 'ep-1' }));
  });

  it('hour-formatted resume time and missing season code fall back cleanly', async () => {
    const resolve = vi.fn().mockResolvedValue(target({ position: 7325, seasonNumber: 2, episodeNumber: 15 }));
    render(<SeriesResumeButton resolve={resolve} onPlay={vi.fn()} />);
    expect(await screen.findByRole('button', { name: /继续播放 S02E15 · 2:02:05/ })).toBeTruthy();
  });

  it('null target renders nothing; focus refresh re-resolves silently', async () => {
    let result: ResumeTarget | null = target();
    const resolve = vi.fn().mockImplementation(async () => result);
    const { unmount } = render(<SeriesResumeButton resolve={resolve} onPlay={vi.fn()} />);
    await screen.findByRole('button', { name: /继续播放/ });
    expect(resolve).toHaveBeenCalledTimes(1);
    // focus：主进程重解析（播放回来/eof 后）
    result = target({ reason: 'next-episode', itemId: 'ep-3', position: 0, episodeNumber: 3 });
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(resolve).toHaveBeenCalledTimes(2));
    await screen.findByRole('button', { name: /播放下一集 S01E03/ });
    unmount();
  });

  it('null target → no button (无可播内容交给集列表)', async () => {
    const resolve = vi.fn().mockResolvedValue(null);
    render(<SeriesResumeButton resolve={resolve} onPlay={vi.fn()} />);
    await waitFor(() => expect(resolve).toHaveBeenCalled());
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('EpisodeGrid 单集进度与从头播放', () => {
  const getImageUrl = vi.fn(() => undefined);
  const baseEp = {
    Id: 'ep-1',
    Name: '第一集',
    IndexNumber: 1,
    ParentIndexNumber: 1,
    RunTimeTicks: 24_000_000_000, // 2400s
    MediaSources: [{ Id: 'ms-1' }],
  };

  it('unfinished episode shows progress bar percentage and no 已看完 badge', () => {
    const episodes = [{ ...baseEp, UserData: { PlaybackPositionTicks: 12_000_000_000, Played: false } }];
    render(<EpisodeGrid episodes={episodes} getImageUrl={getImageUrl} onPlay={vi.fn()} onPlayFromStart={vi.fn()} />);
    const bar = document.querySelector('[class*="bg-primary"][style*="50%"]');
    expect(bar).toBeTruthy();
    expect(screen.queryByText('已看完')).toBeNull();
    expect(screen.getByRole('button', { name: /从头播放第 1 集/ })).toBeTruthy();
  });

  it('finished episode (Played) shows the badge and hides the progress bar', () => {
    const episodes = [{ ...baseEp, UserData: { PlaybackPositionTicks: 24_000_000_000, Played: true } }];
    render(<EpisodeGrid episodes={episodes} getImageUrl={getImageUrl} onPlay={vi.fn()} onPlayFromStart={vi.fn()} />);
    expect(screen.getByText('已看完')).toBeTruthy();
    expect(document.querySelector('[style*="50%"]')).toBeNull();
  });

  it('从头播放 passes startPosition 0; normal click keeps resume semantics', () => {
    const onPlay = vi.fn();
    const onPlayFromStart = vi.fn();
    const episodes = [{ ...baseEp, UserData: { PlaybackPositionTicks: 6_000_000_000, Played: false } }];
    render(<EpisodeGrid episodes={episodes} getImageUrl={getImageUrl} onPlay={onPlay} onPlayFromStart={onPlayFromStart} />);
    fireEvent.click(screen.getByRole('button', { name: /从头播放第 1 集/ }));
    expect(onPlayFromStart).toHaveBeenCalledWith(expect.objectContaining({ Id: 'ep-1' }));
    fireEvent.click(screen.getByRole('button', { name: /^播放第 1 集/ }));
    expect(onPlay).toHaveBeenCalledWith(expect.objectContaining({ Id: 'ep-1' }));
  });

  it('unplayed episodes show no 从头播放 affordance', () => {
    render(<EpisodeGrid episodes={[baseEp]} getImageUrl={getImageUrl} onPlay={vi.fn()} onPlayFromStart={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /从头播放/ })).toBeNull();
  });
});
