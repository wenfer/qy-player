// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 手动上一集/下一集（QYP3-068q）：播放条按钮 + 全局快捷键两条路。
 *
 * 「下一集是谁」由剧集页注册的 provider 回答（它手上是整部戏的剧集列表，
 * 排序在主进程纯函数里）；当前在播哪一集由主进程的媒体快照回答。这里钉四件事：
 * 1. 不在剧集页（没有 provider）→ 按钮不渲染、快捷键静默；
 * 2. 点击按钮 → 用「当前集」问 provider（带方向）→ resolvePlayback + loadFile；
 * 3. 换集显式传 0（从头开始，§12.2）；
 * 4. provider 说没有上一集/下一集 → 提示而不是误播。
 */

const api = {
  getMediaContext: vi.fn(),
  resolvePlayback: vi.fn(),
  playerLoadFile: vi.fn((..._args: unknown[]) => Promise.resolve()),
  playerControl: vi.fn(() => Promise.resolve({ ok: true })),
  playerGetTracks: vi.fn(() => Promise.resolve([])),
  onPlayerStateChange: vi.fn(() => () => undefined),
  // 回调形参要写全，否则 mockImplementation 的类型对不上
  onAutoNextCommand: vi.fn((_cb: (direction: 'next' | 'prev') => void) => () => undefined),
};

vi.stubGlobal('electronAPI', api);

import EpisodeSwitchButtons from '../../../src/renderer/pages/Detail/EpisodeSwitchButtons';
import EpisodeShortcutHost from '../../../src/renderer/components/EpisodeShortcutHost';
import { useAutoNextStore } from '../../../src/renderer/stores/auto-next-store';
import { useToastStore } from '../../../src/renderer/stores/toast-store';
import { playAdjacentEpisode } from '../../../src/renderer/utils/play-episode';

const SNAPSHOT = {
  mediaType: 'jellyfin',
  mediaId: 'ep-2',
  title: '第二集',
  seriesName: '某剧',
  seasonNumber: 1,
  episodeNumber: 2,
  mediaSourceId: 'ms-2',
};

function nextEpisodeChoice(itemId = 'ep-3') {
  return { itemId, mediaSourceId: `ms-${itemId}`, provider: 'jellyfin', serverId: 7 };
}

beforeEach(() => {
  vi.clearAllMocks();
  useAutoNextStore.getState().setProvider(null);
  useToastStore.setState({ toasts: [] });
  api.getMediaContext.mockResolvedValue({ ok: true, data: SNAPSHOT });
  api.resolvePlayback.mockResolvedValue({
    ok: true,
    data: { url: 'http://server/ep-3.mkv', mediaContext: { mediaType: 'jellyfin', mediaId: 'ep-3' } },
  });
});

describe('playAdjacentEpisode (QYP3-068q)', () => {
  it('asks the provider with the current episode and the direction, then loads it from 0', async () => {
    const provider = vi.fn(async () => nextEpisodeChoice());
    useAutoNextStore.getState().setProvider(provider);

    const switched = await playAdjacentEpisode('next');

    expect(switched).toBe(true);
    expect(provider).toHaveBeenCalledWith(
      expect.objectContaining({ mediaId: 'ep-2', seasonNumber: 1, episodeNumber: 2 }),
      'next'
    );
    expect(api.resolvePlayback).toHaveBeenCalledWith(
      { provider: 'jellyfin', serverId: 7, itemId: 'ep-3' },
      { mode: 'direct', mediaSourceId: 'ms-ep-3' }
    );
    // 显式 0：LOAD_FILE 靠它区分"从头播"与"未指定"（§12.2）
    expect(api.playerLoadFile).toHaveBeenCalledWith(
      'http://server/ep-3.mkv',
      0,
      undefined,
      { mediaType: 'jellyfin', mediaId: 'ep-3' },
      undefined
    );
  });

  it('passes prev through when going backwards', async () => {
    const provider = vi.fn(async () => nextEpisodeChoice('ep-1'));
    useAutoNextStore.getState().setProvider(provider);
    await playAdjacentEpisode('prev');
    expect(provider).toHaveBeenCalledWith(expect.anything(), 'prev');
  });

  it('does nothing without a provider (不在剧集页：快捷键应当静默)', async () => {
    const switched = await playAdjacentEpisode('next');
    expect(switched).toBe(false);
    expect(api.getMediaContext).not.toHaveBeenCalled();
    expect(api.playerLoadFile).not.toHaveBeenCalled();
  });

  it('keeps playing when the provider has no neighbour (第一集/最后一集)', async () => {
    useAutoNextStore.getState().setProvider(async () => null);
    const switched = await playAdjacentEpisode('next');
    expect(switched).toBe(false);
    expect(api.playerLoadFile).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts.at(-1)?.message).toBe('已经是最后一集');
  });

  it('surfaces a toast when nothing is playing', async () => {
    useAutoNextStore.getState().setProvider(async () => nextEpisodeChoice());
    api.getMediaContext.mockResolvedValue({ ok: true, data: null });
    const switched = await playAdjacentEpisode('next');
    expect(switched).toBe(false);
    expect(useToastStore.getState().toasts.at(-1)?.message).toBe('当前没有正在播放的剧集');
  });
});

describe('剧集页的上一集/下一集按钮 (QYP3-068q)', () => {
  it('clicking 下一集 uses the current episode + direction, then loads it', async () => {
    const provider = vi.fn(async () => nextEpisodeChoice());
    useAutoNextStore.getState().setProvider(provider);
    render(<EpisodeSwitchButtons />);

    fireEvent.click(screen.getByRole('button', { name: '下一集' }));
    await waitFor(() => expect(api.playerLoadFile).toHaveBeenCalled());
    expect(provider).toHaveBeenCalledWith(expect.objectContaining({ mediaId: 'ep-2' }), 'next');
  });

  it('clicking 上一集 passes prev', async () => {
    const provider = vi.fn(async () => nextEpisodeChoice('ep-1'));
    useAutoNextStore.getState().setProvider(provider);
    render(<EpisodeSwitchButtons />);

    fireEvent.click(screen.getByRole('button', { name: '上一集' }));
    await waitFor(() => expect(provider).toHaveBeenCalledWith(expect.anything(), 'prev'));
  });
});

describe('全局快捷键宿主 (QYP3-068q)', () => {
  it('switches on the pushed direction, and stays silent without a provider', async () => {
    let onCommand: ((direction: 'next' | 'prev') => void) | null = null;
    api.onAutoNextCommand.mockImplementation((cb: (direction: 'next' | 'prev') => void) => {
      onCommand = cb;
      return () => undefined;
    });
    const provider = vi.fn(async () => nextEpisodeChoice());
    render(<EpisodeShortcutHost />);

    // 不在剧集页（没有 provider）：快捷键无操作，也不报错
    act(() => onCommand?.('next'));
    expect(provider).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts).toEqual([]);

    act(() => useAutoNextStore.getState().setProvider(provider));
    act(() => onCommand?.('prev'));
    await waitFor(() => expect(provider).toHaveBeenCalledWith(expect.anything(), 'prev'));
  });
});
