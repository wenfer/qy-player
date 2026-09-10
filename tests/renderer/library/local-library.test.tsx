// @vitest-environment jsdom
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Local from '../../../src/renderer/pages/Local';
import LibraryBrowse from '../../../src/renderer/pages/LibraryBrowse';

const electronAPI = {
  // Local page
  listSources: vi.fn(),
  startScan: vi.fn(),
  cancelScan: vi.fn(),
  onScanProgress: vi.fn(() => () => undefined),
  getRecentlyPlayed: vi.fn(async () => []),
  onPlayerStateChange: vi.fn(() => () => undefined),
  openFile: vi.fn(),
  openFolder: vi.fn(),
  playerLoadFile: vi.fn(),
  getProgress: vi.fn(),
  deleteHistoryItem: vi.fn(),
  clearHistory: vi.fn(),
  // LibraryBrowse (catalog mode)
  browseCatalog: vi.fn(),
  searchCatalog: vi.fn(),
  getCatalogItem: vi.fn(),
  resolveCatalogMedia: vi.fn(),
};

vi.stubGlobal('electronAPI', electronAPI);
vi.stubGlobal('confirm', vi.fn(() => true));
vi.stubGlobal('alert', vi.fn());

beforeEach(() => {
  vi.clearAllMocks();
  electronAPI.listSources.mockResolvedValue([]);
  electronAPI.browseCatalog.mockResolvedValue({ ok: true, data: { items: [], page: 1, pageSize: 60 } });
  electronAPI.playerLoadFile.mockResolvedValue(undefined);
});

describe('Local page: 本地媒体库 section', () => {
  it('lists sources with scan state and links into the catalog browser', async () => {
    electronAPI.listSources.mockResolvedValue([
      {
        id: 7,
        kind: 'local',
        name: '电影收藏',
        root: '/data/movies',
        readOnly: true,
        capabilities: { canSeek: true, canDelete: false, supportsEtag: false, supportsRange: true },
        hasCredential: false,
        lastRun: { status: 'completed', processed: 42, total: 42, at: Date.now() },
      },
    ]);
    render(
      <MemoryRouter>
        <Local />
      </MemoryRouter>
    );
    await waitFor(() => expect(screen.getByText('电影收藏')).toBeTruthy());
    expect(screen.getByText(/已扫描 42 项/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '浏览 电影收藏' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '扫描 电影收藏' })).toBeTruthy();
  });

  it('shows an empty state pointing at settings when no source exists', async () => {
    render(
      <MemoryRouter>
        <Local />
      </MemoryRouter>
    );
    await waitFor(() => expect(screen.getByText('还没有媒体库来源')).toBeTruthy());
    expect(screen.getByRole('button', { name: '前往设置' })).toBeTruthy();
  });

  it('keeps single-file playback available', () => {
    render(
      <MemoryRouter>
        <Local />
      </MemoryRouter>
    );
    expect(screen.getByRole('button', { name: '打开文件' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '打开文件夹' })).toBeTruthy();
  });
});

function renderCatalogRoute(initial: string): void {
  render(
    <MemoryRouter initialEntries={[initial]}>
      <Routes>
        <Route path="/browse/:sourceId" element={<LibraryBrowse />} />
        <Route path="/browse/:sourceId/item/:itemId" element={<LibraryBrowse />} />
      </Routes>
    </MemoryRouter>
  );
}

describe('LibraryBrowse: catalog mode', () => {
  it('renders catalog items with progress and opens the detail view', async () => {
    electronAPI.browseCatalog.mockResolvedValue({
      ok: true,
      data: {
        items: [
          {
            ref: { provider: 'catalog', sourceId: 7, itemId: '101' },
            kind: 'movie',
            title: '流浪地球',
            year: 2019,
            rating: 7.9,
            availability: 'online',
            progress: { position: 300, duration: 4500, isFinished: false },
          },
          {
            ref: { provider: 'catalog', sourceId: 7, itemId: '202' },
            kind: 'series',
            title: '绝命毒师',
            availability: 'online',
          },
        ],
        page: 1,
        pageSize: 60,
      },
    });
    renderCatalogRoute('/browse/7');
    await waitFor(() => expect(screen.getByText('流浪地球')).toBeTruthy());
    expect(screen.getByText('绝命毒师')).toBeTruthy();
    // Progress badge from catalog_user_state.
    expect(screen.getByText(/5:00 \/ 1:15:00/)).toBeTruthy();
  });

  it('plays a movie through containment-checked path resolution', async () => {
    electronAPI.browseCatalog.mockResolvedValue({
      ok: true,
      data: {
        items: [
          {
            ref: { provider: 'catalog', sourceId: 7, itemId: '101' },
            kind: 'movie',
            title: '流浪地球',
            availability: 'online',
            progress: { position: 300, duration: 4500, isFinished: false },
          },
        ],
        page: 1,
        pageSize: 60,
      },
    });
    electronAPI.resolveCatalogMedia.mockResolvedValue({
      ok: true,
      data: { path: '/data/movies/流浪地球 (2019)/流浪地球 (2019).mkv', title: '流浪地球', position: 300 },
    });
    renderCatalogRoute('/browse/7');
    await waitFor(() => expect(screen.getByText('流浪地球')).toBeTruthy());
    // Card play affordance (PosterCard exposes an onPlay action button).
    const playButtons = screen.getAllByRole('button');
    fireEvent.click(playButtons[playButtons.length - 1]);
    await waitFor(() => expect(electronAPI.resolveCatalogMedia).toHaveBeenCalledWith(7, 101));
    await waitFor(() =>
      expect(electronAPI.playerLoadFile).toHaveBeenCalledWith(
        '/data/movies/流浪地球 (2019)/流浪地球 (2019).mkv',
        300,
        undefined,
        expect.objectContaining({ mediaType: 'local', title: '流浪地球' })
      )
    );
  });

  it('shows the empty state for an unscanned source', async () => {
    renderCatalogRoute('/browse/9');
    await waitFor(() => expect(screen.getByText('该来源尚未扫描或暂无内容')).toBeTruthy());
  });

  it('shows a retry affordance on error', async () => {
    electronAPI.browseCatalog.mockResolvedValue({ ok: false, error: { code: 'INTERNAL', message: '浏览目录失败' } });
    renderCatalogRoute('/browse/7');
    await waitFor(() => expect(screen.getByText('浏览目录失败')).toBeTruthy());
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
  });

  it('load-more requests the next integer page', async () => {
    const items = Array.from({ length: 60 }, (_, i) => ({
      ref: { provider: 'catalog', sourceId: 7, itemId: String(i + 1) },
      kind: 'movie',
      title: `电影${i}`,
      availability: 'online',
    }));
    electronAPI.browseCatalog.mockResolvedValue({
      ok: true,
      data: { items, page: 1, pageSize: 60, nextCursor: '2' },
    });
    renderCatalogRoute('/browse/7');
    await waitFor(() => expect(screen.getByText('电影0')).toBeTruthy());
    electronAPI.browseCatalog.mockResolvedValue({
      ok: true,
      data: { items: [], page: 2, pageSize: 60 },
    });
    fireEvent.click(screen.getByRole('button', { name: /加载更多/ }));
    await waitFor(() =>
      expect(electronAPI.browseCatalog).toHaveBeenLastCalledWith(
        expect.objectContaining({ sourceId: 7, page: 2, pageSize: 60 })
      )
    );
  });

  it('searches within the source', async () => {
    electronAPI.browseCatalog.mockResolvedValue({ ok: true, data: { items: [], page: 1, pageSize: 60 } });
    electronAPI.searchCatalog.mockResolvedValue({
      ok: true,
      data: {
        items: [
          {
            ref: { provider: 'catalog', sourceId: 7, itemId: '101' },
            kind: 'movie',
            title: '流浪地球',
            availability: 'online',
          },
        ],
        page: 1,
        pageSize: 60,
      },
    });
    renderCatalogRoute('/browse/7');
    await waitFor(() => expect(screen.getByLabelText('在媒体库中搜索')).toBeTruthy());
    fireEvent.input(screen.getByLabelText('在媒体库中搜索'), { target: { value: '流浪' } });
    fireEvent.click(screen.getByRole('button', { name: '搜索' }));
    await waitFor(() => expect(electronAPI.searchCatalog).toHaveBeenCalledWith(
      expect.objectContaining({ sourceId: 7, query: '流浪' })
    ));
    await waitFor(() => expect(screen.getByText('流浪地球')).toBeTruthy());
  });
});
