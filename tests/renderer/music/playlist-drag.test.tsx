// @vitest-environment jsdom
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PlaylistsPage from '../../../src/renderer/pages/Playlists';

const api = {
  listPlaylists: vi.fn(),
  getPlaylistItems: vi.fn(),
  createPlaylist: vi.fn(),
  renamePlaylist: vi.fn(),
  deletePlaylist: vi.fn(),
  removeFromPlaylist: vi.fn(),
  reorderPlaylistItem: vi.fn(),
  exportPlaylistM3u8: vi.fn(),
  exportPlaylistXspf: vi.fn(),
};

vi.stubGlobal('electronAPI', api);

const items = [
  { id: 11, position: 0, item_ref: 'music:1:1', track: { id: 1, source_id: 1, path: '/a.mp3', title: '晴天', artist: '周杰伦', albumartist: '周杰伦', duration: 260, codec: 'mp3' } },
  { id: 12, position: 1, item_ref: 'music:1:2', track: { id: 2, source_id: 1, path: '/b.mp3', title: '懦夫', artist: '周杰伦', albumartist: '周杰伦', duration: 200, codec: 'mp3' } },
  { id: 13, position: 2, item_ref: 'music:1:3', track: { id: 3, source_id: 1, path: '/c.mp3', title: '以父之名', artist: '周杰伦', albumartist: '周杰伦', duration: 300, codec: 'mp3' } },
];

/** jsdom 不实现 DataTransfer：只提供本组件用到的字段。 */
function dataTransfer() {
  const store: Record<string, string> = {};
  return {
    effectAllowed: '',
    dropEffect: '',
    setData: (k: string, v: string) => {
      store[k] = v;
    },
    getData: (k: string) => store[k] ?? '',
  };
}

const titles = (): string[] =>
  Array.from(document.querySelectorAll('div.flex.flex-col.gap-1 > div')).map(
    (row) => row.querySelector('p')?.textContent ?? ''
  );

beforeEach(() => {
  vi.clearAllMocks();
  api.listPlaylists.mockResolvedValue({
    ok: true,
    data: { playlists: [{ id: 5, name: '华语', track_count: 3, created_at: 1, updated_at: 1 }] },
  });
  api.getPlaylistItems.mockResolvedValue({ ok: true, data: { items } });
  api.reorderPlaylistItem.mockResolvedValue({ ok: true, data: { reordered: true } });
});

describe('playlist drag reordering (QYP3-015a)', () => {
  it('moves a dragged item to the dropped position', async () => {
    render(<PlaylistsPage />);
    await waitFor(() => expect(screen.getByText('华语')).toBeTruthy());
    fireEvent.click(screen.getByText('华语'));
    await waitFor(() => expect(screen.getByText('晴天')).toBeTruthy());
    expect(titles()).toEqual(['晴天', '懦夫', '以父之名']);

    const rows = Array.from(document.querySelectorAll('div.flex.flex-col.gap-1 > div'));
    const dt = dataTransfer();
    fireEvent.dragStart(rows[0], { dataTransfer: dt });
    fireEvent.dragOver(rows[2], { dataTransfer: dt });
    fireEvent.drop(rows[2], { dataTransfer: dt });

    await waitFor(() => expect(api.reorderPlaylistItem).toHaveBeenCalledWith(5, 0, 2));
    // 乐观重排：拖到第 3 行后顺序变为 懦夫 / 以父之名 / 晴天
    expect(titles()).toEqual(['懦夫', '以父之名', '晴天']);
  });

  it('rolls back when the reorder fails', async () => {
    api.reorderPlaylistItem.mockResolvedValue({ ok: true, data: { reordered: false } });
    render(<PlaylistsPage />);
    await waitFor(() => expect(screen.getByText('华语')).toBeTruthy());
    fireEvent.click(screen.getByText('华语'));
    await waitFor(() => expect(screen.getByText('晴天')).toBeTruthy());

    const rows = Array.from(document.querySelectorAll('div.flex.flex-col.gap-1 > div'));
    const dt = dataTransfer();
    fireEvent.dragStart(rows[0], { dataTransfer: dt });
    fireEvent.drop(rows[1], { dataTransfer: dt });

    await waitFor(() => expect(api.reorderPlaylistItem).toHaveBeenCalled());
    expect(titles()).toEqual(['晴天', '懦夫', '以父之名']);
  });

  it('keeps the up/down buttons working as a fallback', async () => {
    render(<PlaylistsPage />);
    await waitFor(() => expect(screen.getByText('华语')).toBeTruthy());
    fireEvent.click(screen.getByText('华语'));
    await waitFor(() => expect(screen.getByText('晴天')).toBeTruthy());

    fireEvent.click(screen.getAllByRole('button', { name: '下移' })[0]);
    await waitFor(() => expect(api.reorderPlaylistItem).toHaveBeenCalledWith(5, 0, 1));
    expect(titles()).toEqual(['懦夫', '晴天', '以父之名']);
  });
});
