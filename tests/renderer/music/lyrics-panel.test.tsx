// @vitest-environment jsdom
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import LyricsPanel from '../../../src/renderer/components/LyricsPanel';

const getMusicLyrics = vi.fn();
const importMusicLyrics = vi.fn();

vi.stubGlobal('electronAPI', { getMusicLyrics, importMusicLyrics });
// jsdom 未实现 scrollIntoView（Electron/Chromium 有）
Element.prototype.scrollIntoView = vi.fn();

const LRC = ['[00:01.00]第一行', '[00:05.00]第二行', '[00:09.00]第三行'].join('\n');

beforeEach(() => {
  vi.clearAllMocks();
  getMusicLyrics.mockResolvedValue({ ok: true, data: { hasLyrics: true, content: LRC } });
});

describe('LyricsPanel (QYP3-021)', () => {
  it('highlights the line matching the playback position', async () => {
    render(<LyricsPanel trackId={7} title="晴天" position={6} onSeek={vi.fn()} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('第二行')).toBeTruthy());
    expect(getMusicLyrics).toHaveBeenCalledWith(7);
    const active = screen.getByText('第二行');
    expect(active.className).toContain('font-medium');
    expect(screen.getByText('第一行').className).not.toContain('font-medium');
  });

  it('seeks to the clicked line time', async () => {
    const onSeek = vi.fn();
    render(<LyricsPanel trackId={7} title="晴天" position={0} onSeek={onSeek} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('第三行')).toBeTruthy());
    fireEvent.click(screen.getByText('第三行'));
    expect(onSeek).toHaveBeenCalledWith(9);
  });

  it('shows import hint when the track has no lyrics', async () => {
    getMusicLyrics.mockResolvedValue({ ok: true, data: { hasLyrics: false, content: null } });
    render(<LyricsPanel trackId={7} title="晴天" position={0} onSeek={vi.fn()} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/还没有歌词/)).toBeTruthy());
  });

  it('imports a .lrc: failure keeps the old lyrics, success replaces them', async () => {
    render(<LyricsPanel trackId={7} title="晴天" position={0} onSeek={vi.fn()} onClose={vi.fn()} />);
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
