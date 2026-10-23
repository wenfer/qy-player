// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import Home from '../../../src/renderer/pages/Home';

const { addToast } = vi.hoisted(() => ({ addToast: vi.fn() }));
vi.mock('../../../src/renderer/stores/toast-store', () => ({
  useToastStore: (selector: (s: { addToast: unknown }) => unknown) => selector({ addToast }),
}));

const unifiedContinueWatching = vi.fn();
const unifiedRecent = vi.fn();
const getServers = vi.fn();
const getLibraries = vi.fn();
const getItems = vi.fn();

vi.stubGlobal('electronAPI', {
  unifiedContinueWatching,
  unifiedRecent,
  getServers,
  getLibraries,
  getItems,
  resolvePlayback: vi.fn(),
  playerLoadFile: vi.fn(),
  getProgress: vi.fn().mockResolvedValue({ ok: true, data: null }),
  onPlayerStateChange: vi.fn().mockReturnValue(() => undefined),
  getPlayerState: vi.fn().mockResolvedValue({ ok: true, data: {} }),
  playerGetState: vi.fn().mockResolvedValue({ ok: true, data: {} }),
});

const mockServers = [
  { id: 1, name: 'HomeServer', type: 'jellyfin', base_url: 'http://localhost:8096', is_active: 1 },
  { id: 2, name: 'CatServer', type: 'emby', base_url: 'http://cat:8096', is_active: 1 },
];

const mockLibrariesServer1 = [
  {
    serverId: 1,
    serverName: 'HomeServer',
    serverType: 'jellyfin',
    baseUrl: 'http://localhost:8096',
    views: [
      { Id: 'lib-movies-1', Name: '本地电影', CollectionType: 'movies' },
    ],
  },
];

const mockLibrariesServer2 = [
  {
    serverId: 2,
    serverName: 'CatServer',
    serverType: 'emby',
    baseUrl: 'http://cat:8096',
    views: [
      { Id: 'lib-tv-2', Name: '猫猫剧集', CollectionType: 'tvshows' },
    ],
  },
];

const mockAllLibraries = [...mockLibrariesServer1, ...mockLibrariesServer2];

describe('Home server switching and on-demand library loading', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    getServers.mockResolvedValue(mockServers);
    getLibraries.mockImplementation((targetServerId?: number) => {
      if (targetServerId === 1) return Promise.resolve(mockLibrariesServer1);
      if (targetServerId === 2) return Promise.resolve(mockLibrariesServer2);
      return Promise.resolve(mockAllLibraries);
    });
    unifiedContinueWatching.mockResolvedValue({
      ok: true,
      data: [
        { ref: { provider: 'jellyfin', serverId: 1, itemId: 'cw-1' }, title: '服务器1片子', kind: 'Movie' },
        { ref: { provider: 'emby', serverId: 2, itemId: 'cw-2' }, title: '服务器2剧集', kind: 'Series' },
      ],
    });
    unifiedRecent.mockResolvedValue({
      ok: true,
      data: [
        { ref: { provider: 'jellyfin', serverId: 1, itemId: 'rec-1' }, title: '服务器1最新', kind: 'Movie' },
        { ref: { provider: 'emby', serverId: 2, itemId: 'rec-2' }, title: '服务器2最新', kind: 'Series' },
      ],
    });
  });

  it('renders server tablist when multiple servers exist with [全部] selected by default', async () => {
    render(
      <MemoryRouter>
        <Home />
      </MemoryRouter>
    );

    expect(await screen.findByRole('tablist', { name: '服务端切换' })).toBeTruthy();
    const allTab = screen.getByRole('tab', { name: /全部/i });
    const srv1Tab = screen.getByRole('tab', { name: /HomeServer/i });
    const srv2Tab = screen.getByRole('tab', { name: /CatServer/i });

    expect(allTab.getAttribute('aria-selected')).toBe('true');
    expect(srv1Tab.getAttribute('aria-selected')).toBe('false');
    expect(srv2Tab.getAttribute('aria-selected')).toBe('false');

    // 展示全部服务器的媒体库与条目
    expect(await screen.findByText('本地电影')).toBeTruthy();
    expect(screen.getByText('猫猫剧集')).toBeTruthy();
    expect(screen.getByText('服务器1片子')).toBeTruthy();
    expect(screen.getByText('服务器2剧集')).toBeTruthy();
  });

  it('switches to a specific server on click, fetches only that server and filters content', async () => {
    render(
      <MemoryRouter>
        <Home />
      </MemoryRouter>
    );

    expect(await screen.findByRole('tablist', { name: '服务端切换' })).toBeTruthy();
    const srv2Tab = screen.getByRole('tab', { name: /CatServer/i });

    // 点击切换到 CatServer (id: 2)
    fireEvent.click(srv2Tab);

    // 标签状态更新
    expect(srv2Tab.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: /全部/i }).getAttribute('aria-selected')).toBe('false');

    // 验证持久化到了 localStorage
    expect(window.localStorage.getItem('qy_home_selected_server')).toBe('2');

    // 仅针对目标服务器发起 getLibraries 请求
    await waitFor(() => {
      expect(getLibraries).toHaveBeenCalledWith(2);
    });

    // 仅呈现 CatServer 的媒体库与条目
    await waitFor(() => {
      expect(screen.getByText('猫猫剧集')).toBeTruthy();
      expect(screen.queryByText('本地电影')).toBeNull();
      expect(screen.getByText('服务器2剧集')).toBeTruthy();
      expect(screen.queryByText('服务器1片子')).toBeNull();
    });
  });

  it('restores previously selected server from localStorage on mount', async () => {
    window.localStorage.setItem('qy_home_selected_server', '1');

    render(
      <MemoryRouter>
        <Home />
      </MemoryRouter>
    );

    // 自动激活 HomeServer
    await waitFor(() => {
      const srv1Tab = screen.getByRole('tab', { name: /HomeServer/i });
      expect(srv1Tab.getAttribute('aria-selected')).toBe('true');
    });

    // 仅拉取目标服务器 1
    await waitFor(() => {
      expect(getLibraries).toHaveBeenCalledWith(1);
      expect(screen.getByText('本地电影')).toBeTruthy();
      expect(screen.queryByText('猫猫剧集')).toBeNull();
      expect(screen.getByText('服务器1片子')).toBeTruthy();
      expect(screen.queryByText('服务器2剧集')).toBeNull();
    });
  });

  it('does not render server tablist if only 1 server is configured', async () => {
    getServers.mockResolvedValue([mockServers[0]]);

    render(
      <MemoryRouter>
        <Home />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('已连接 1 个服务器')).toBeTruthy();
    });

    expect(screen.queryByRole('tablist', { name: '服务端切换' })).toBeNull();
  });
});
