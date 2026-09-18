// @vitest-environment jsdom
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import HistoryPage from '../../../src/renderer/pages/History';

/**
 * 加载失败要有可重试的错误态（前端审查）：此前失败只弹 Toast，列表落成
 * 「暂无观看记录」，看着像历史真的被清空了。
 */

const getRecentlyPlayed = vi.fn();
const getServers = vi.fn(async () => []);

vi.stubGlobal('electronAPI', { getRecentlyPlayed, getServers });

beforeEach(() => {
  vi.clearAllMocks();
  getServers.mockResolvedValue([]);
});

describe('History page error state', () => {
  it('replaces the empty state with a retryable alert', async () => {
    getRecentlyPlayed.mockRejectedValue(new Error('数据库被占用'));
    render(
      <MemoryRouter>
        <HistoryPage />
      </MemoryRouter>
    );
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByText('没能加载观看历史')).toBeTruthy();
    expect(screen.queryByText('暂无观看记录')).toBeNull();

    getRecentlyPlayed.mockResolvedValue([]);
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(screen.getByText('暂无观看记录')).toBeTruthy());
    expect(getRecentlyPlayed).toHaveBeenCalledTimes(2);
  });
});
