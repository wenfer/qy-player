// @vitest-environment jsdom
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import LyricsPanel from '../../../src/renderer/components/LyricsPanel';

const getMusicLyrics = vi.fn();
const importMusicLyrics = vi.fn();
const getServerLyrics = vi.fn();

vi.stubGlobal('electronAPI', { getMusicLyrics, importMusicLyrics, getServerLyrics });
// jsdom 未实现 scrollIntoView（Electron/Chromium 有）
Element.prototype.scrollIntoView = vi.fn();

const LRC = ['[00:01.00]第一行', '[00:05.00]第二行', '[00:09.00]第三行'].join('\n');
const local = { trackId: 7 };
const server = { trackId: 0, serverId: 1, itemId: 't2' };

beforeEach(() => {
  vi.clearAllMocks();
  getMusicLyrics.mockResolvedValue({ ok: true, data: { hasLyrics: true, content: LRC } });
  getServerLyrics.mockResolvedValue({ ok: true, data: { hasLyrics: true, content: LRC } });
});

describe('LyricsPanel (QYP3-021)', () => {
  it('highlights the line matching the playback position', async () => {
    render(<LyricsPanel source={local} title="晴天" position={6} onSeek={vi.fn()} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('第二行')).toBeTruthy());
    expect(getMusicLyrics).toHaveBeenCalledWith(7);
    const active = screen.getByText('第二行');
    expect(active.className).toContain('font-medium');
    expect(screen.getByText('第一行').className).not.toContain('font-medium');
  });

  it('seeks to the clicked line time', async () => {
    const onSeek = vi.fn();
    render(<LyricsPanel source={local} title="晴天" position={0} onSeek={onSeek} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('第三行')).toBeTruthy());
    fireEvent.click(screen.getByText('第三行'));
    expect(onSeek).toHaveBeenCalledWith(9);
  });

  it('shows import hint when the track has no lyrics', async () => {
    getMusicLyrics.mockResolvedValue({ ok: true, data: { hasLyrics: false, content: null } });
    render(<LyricsPanel source={local} title="晴天" position={0} onSeek={vi.fn()} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/还没有歌词/)).toBeTruthy());
  });

  it('imports a .lrc: failure keeps the old lyrics, success replaces them', async () => {
    render(<LyricsPanel source={local} title="晴天" position={0} onSeek={vi.fn()} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('第一行')).toBeTruthy());

    // 失败（空文件/读取失败）：Toast 由 App 层统一渲染，这里只验证歌词未被替换
    importMusicLyrics.mockResolvedValue({ ok: false, error: { message: '歌词文件为空' } });
    fireEvent.click(screen.getByRole('button', { name: '导入歌词' }));
    await waitFor(() => expect(importMusicLyrics).toHaveBeenCalledWith(7));
    expect(screen.getByText('第一行')).toBeTruthy();

    importMusicLyrics.mockResolvedValue({ ok: true, data: { imported: true, content: '[00:02.00]新歌词' } });
    fireEvent.click(screen.getByRole('button', { name: '导入歌词' }));
    await waitFor(() => expect(screen.getByText('新歌词')).toBeTruthy());
  });
});

describe('LyricsPanel server tracks (QYP3-020b)', () => {
  it('reads server lyrics by serverId + itemId, never the local cache', async () => {
    render(<LyricsPanel source={server} title="以父之名" position={6} onSeek={vi.fn()} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('第二行')).toBeTruthy());
    expect(getServerLyrics).toHaveBeenCalledWith(1, 't2');
    expect(getMusicLyrics).not.toHaveBeenCalled();
    expect(importMusicLyrics).not.toHaveBeenCalled();
  });

  it('hides the import button and explains server tracks without lyrics', async () => {
    getServerLyrics.mockResolvedValue({ ok: true, data: { hasLyrics: false, content: null } });
    render(<LyricsPanel source={server} title="以父之名" position={0} onSeek={vi.fn()} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/服务器上没有这首曲目的歌词/)).toBeTruthy());
    expect(screen.queryByRole('button', { name: '导入歌词' })).toBeNull();
  });
});

describe('LyricsPanel placement (QYP3-058)', () => {
  // 按语义角色定位（不是按样式类）：面板的视觉类会随 UI 调整变化
  const rootClass = (): string =>
    document.querySelector('[aria-label="歌词面板"]')?.className ?? '';

  it('defaults to above-bar: above the spectrum-bearing mini bar, higher z-index', async () => {
    render(<LyricsPanel source={local} title="晴天" position={0} onSeek={vi.fn()} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('晴天')).toBeTruthy());
    const cls = rootClass();
    // 播放条带频谱行后高约 150px：面板悬在它上方，且 z-50 盖过播放条的 z-40
    expect(cls).toContain('bottom-44');
    expect(cls).toContain('z-50');
    expect(cls).not.toContain('bottom-20');
    expect(cls).not.toContain('z-40');
  });

  it('overlay fills the compact floating window (no centering/width, no max-h clamp)', async () => {
    render(<LyricsPanel placement="overlay" source={local} title="晴天" position={0} onSeek={vi.fn()} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('晴天')).toBeTruthy());
    const cls = rootClass();
    expect(cls).toContain('top-10');
    expect(cls).toContain('bottom-3');
    expect(cls).toContain('z-50');
    expect(cls).not.toContain('translate-x-1/2');
    expect(cls).not.toContain('max-h-');
  });
});
