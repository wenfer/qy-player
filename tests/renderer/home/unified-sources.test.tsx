// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import Search from '../../../src/renderer/pages/Search';
import Home from '../../../src/renderer/pages/Home';
import {
  clampPageSize,
  dedupeByMediaRef,
  mediaRefKey,
  paginate,
} from '../../../src/main/modules/catalog/unified-query';
import type { UnifiedCard } from '../../../src/main/modules/catalog/unified-query';
import type { MediaRef } from '../../../src/shared/types/catalog';

/**
 * QYP2-036 mixed-source tests: MediaRef 去重（main 纯函数）+ renderer
 * 统一卡渲染与路由适配（catalog /browse、在线 /detail）。
 */

const { addToast } = vi.hoisted(() => ({ addToast: vi.fn() }));
vi.mock('../../../src/renderer/stores/toast-store', () => ({
  useToastStore: (selector: (s: { addToast: unknown }) => unknown) => selector({ addToast }),
}));

const unifiedContinueWatching = vi.fn();
const unifiedRecent = vi.fn();
const unifiedSearch = vi.fn();
const getServers = vi.fn();
const getLibraries = vi.fn();
const resolvePlayback = vi.fn();
const playerLoadFile = vi.fn();

vi.stubGlobal('electronAPI', {
  unifiedContinueWatching,
  unifiedRecent,
  unifiedSearch,
  getServers,
  getLibraries,
  getItems: vi.fn().mockResolvedValue([]),
  resolvePlayback,
  playerLoadFile,
  getProgress: vi.fn().mockResolvedValue({ ok: true, data: null }),
  onPlayerStateChange: vi.fn().mockReturnValue(() => undefined),
  getPlayerState: vi.fn().mockResolvedValue({ ok: true, data: {} }),
  playerGetState: vi.fn().mockResolvedValue({ ok: true, data: {} }),
});

/* eslint-disable @typescript-eslint/no-unused-vars */

beforeEach(() => {
  vi.clearAllMocks();
  getServers.mockResolvedValue([
    { id: 7, name: 'Jelly', type: 'jellyfin', base_url: 'http://j:8096', is_active: 1 },
  ]);
  getLibraries.mockResolvedValue([]);
  unifiedContinueWatching.mockResolvedValue({ ok: true, data: [] });
  unifiedRecent.mockResolvedValue({ ok: true, data: [] });
});

// ---------------------------------------------------------------------------
// main 纯函数（MediaRef 去重 / ≤200 分页）
// ---------------------------------------------------------------------------

describe('unified-query pure helpers', () => {
  const refA: MediaRef = { provider: 'catalog', sourceId: 1, itemId: '10' };
  const refSameCard: MediaRef = { provider: 'catalog', sourceId: 1, itemId: '10' };
  const refOtherSource: MediaRef = { provider: 'catalog', sourceId: 2, itemId: '10' };
  const refOnline: MediaRef = { provider: 'jellyfin', serverId: 7, itemId: '10' };

  it('mediaRefKey: owner is part of the key (same numeric id ≠ same media)', () => {
    expect(mediaRefKey(refA)).toBe('catalog:s1:10');
    expect(mediaRefKey(refOtherSource)).toBe('catalog:s2:10');
    expect(mediaRefKey(refOnline)).toBe('jellyfin:srv7:10');
    expect(mediaRefKey(refOtherSource)).not.toBe(mediaRefKey(refA));
  });

  it('dedupe by FULL MediaRef — same id in different owners stays (宁可重复不错归属)', () => {
    const items = [{ ref: refA, v: 'a' }, { ref: refSameCard, v: 'dup' }, { ref: refOtherSource }, { ref: refOnline }];
    const deduped = dedupeByMediaRef(items as Array<{ ref: MediaRef; v: string }>);
    expect(deduped).toHaveLength(3);
    expect(deduped[0].v).toBe('a'); // 首个出现者胜出
  });

  it('paginate ≤200: clamp + page math', () => {
    expect(clampPageSize(500)).toBe(200);
    expect(clampPageSize(0)).toBe(60);
  });

  it('paginate: exact slicing', () => {
    const items = Array.from({ length: 450 }, (_, i) => i);
    expect(paginate(items, 1, 200).items).toEqual(items.slice(0, 200));
    expect(paginate(items, 3, 200).items).toEqual(items.slice(400, 450));
    expect(paginate(items, 4, 200).items).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// renderer：统一来源的首页与搜索
// ---------------------------------------------------------------------------

describe('Home unified sources (mixed)', () => {
  it('renders continue-watching cards from catalog AND online sources with per-owner navigation', async () => {
    unifiedContinueWatching.mockResolvedValue({
      ok: true,
      data: [
        { ref: { provider: 'catalog', sourceId: 3, itemId: '42' }, title: '本地电影', kind: 'movie', position: 600, duration: 7000 },
        { ref: { provider: 'jellyfin', serverId: 7, itemId: 'jf-1' }, title: '在线剧集', kind: 'Series', poster: { serverId: 7, itemId: 'jf-1', tag: 'tag-1' } },
      ],
    });
    render(
      <MemoryRouter>
        <Home />
      </MemoryRouter>
    );
    expect(await screen.findByText('继续观看')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('本地电影')).toBeTruthy());
    expect(screen.getByText('在线剧集')).toBeTruthy();
  });

  it('continue-watching episode cards are labelled TV and show SxxExx (not 电影)', async () => {
    unifiedContinueWatching.mockResolvedValue({
      ok: true,
      data: [
        // 在线：kind 是 Jellyfin/Emby 的大小写混合
        {
          ref: { provider: 'emby', serverId: 7, itemId: 'ep-1' },
          title: '第五集',
          kind: 'Episode',
          position: 600,
          duration: 3000,
          seriesName: '绝命毒师',
          seasonNumber: 2,
          episodeNumber: 5,
        },
        // 本地目录：catalog_items.kind 是小写
        {
          ref: { provider: 'catalog', sourceId: 3, itemId: '77' },
          title: '第三集',
          kind: 'episode',
          position: 120,
          duration: 3000,
          seriesName: '本地剧',
          seasonNumber: 1,
          episodeNumber: 3,
        },
      ] as UnifiedCard[],
    });
    render(
      <MemoryRouter>
        <Home />
      </MemoryRouter>
    );
    await waitFor(() => expect(screen.getByText('第五集')).toBeTruthy());

    expect(screen.getByText('绝命毒师 · S02E05')).toBeTruthy();
    expect(screen.getByText('本地剧 · S01E03')).toBeTruthy();
    // 两张都标成「剧集」，一张都没有被兜底成电影
    expect(screen.getAllByText('剧集')).toHaveLength(2);
    expect(screen.queryByText('电影')).toBeNull();
  });

  it('online-only failure of unified endpoints keeps the home page usable', async () => {
    unifiedContinueWatching.mockRejectedValue(new Error('boom'));
    unifiedRecent.mockRejectedValue(new Error('boom'));
    render(
      <MemoryRouter>
        <Home />
      </MemoryRouter>
    );
    await waitFor(() => expect(screen.queryByText('加载中')).toBeNull());
    // 不崩溃：首页其余区块仍渲染
    expect(await screen.findByText(/暂无媒体数据|媒体库/)).toBeTruthy();
  });
});

describe('Search unified (mixed sources + pagination)', () => {
  function makeCards(): UnifiedCard[] {
    return [
      { ref: { provider: 'catalog', sourceId: 3, itemId: '11' }, title: '目录命中', kind: 'movie', year: 2019 },
      { ref: { provider: 'jellyfin', serverId: 7, itemId: 'jf-9' }, title: '在线命中', kind: 'Series', poster: { serverId: 7, itemId: 'jf-9', tag: 't' } },
    ];
  }

  it('searches across sources; page 2 load-more appends', async () => {
    unifiedSearch
      .mockResolvedValueOnce({ ok: true, data: { items: makeCards(), page: 1, total: 3 } })
      .mockResolvedValueOnce({
        ok: true,
        data: { items: [{ ref: { provider: 'catalog', sourceId: 3, itemId: '12' }, title: '第三条', kind: 'movie' }], page: 2, total: 3 },
      });
    render(
      <MemoryRouter>
        <Search />
      </MemoryRouter>
    );
    fireEvent.change(screen.getByLabelText('搜索媒体'), { target: { value: '流浪地球' } });
    fireEvent.click(screen.getByRole('button', { name: /搜索/ }));
    expect(await screen.findByText('目录命中')).toBeTruthy();
    expect(screen.getByText('在线命中')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /加载更多/ }));
    await waitFor(() => expect(screen.getByText('第三条')).toBeTruthy());
    expect(unifiedSearch).toHaveBeenLastCalledWith('流浪地球', 2);
  });

  it('no results shows the honest empty state', async () => {
    unifiedSearch.mockResolvedValue({ ok: true, data: { items: [], page: 1, total: 0 } });
    render(
      <MemoryRouter>
        <Search />
      </MemoryRouter>
    );
    fireEvent.change(screen.getByLabelText('搜索媒体'), { target: { value: '不存在的片子' } });
    fireEvent.click(screen.getByRole('button', { name: /搜索/ }));
    expect(await screen.findByText(/未找到与/)).toBeTruthy();
  });
});
