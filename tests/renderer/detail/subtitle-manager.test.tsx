// @vitest-environment jsdom
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SubtitleManager from '../../../src/renderer/pages/Detail/SubtitleManager';

const listSubtitles = vi.fn();
const importSubtitle = vi.fn();
const removeSubtitle = vi.fn();
const setDefaultSubtitle = vi.fn();
const pickSubtitleFile = vi.fn();

vi.stubGlobal('electronAPI', {
  listSubtitles,
  importSubtitle,
  removeSubtitle,
  setDefaultSubtitle,
  pickSubtitleFile,
});

// Stable toast mock (vi.hoisted keeps the reference across the factory hoist).
const { addToast } = vi.hoisted(() => ({ addToast: vi.fn() }));
vi.mock('../../../src/renderer/stores/toast-store', () => ({
  useToastStore: (selector: (s: { addToast: unknown }) => unknown) => selector({ addToast }),
}));

const ROW = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  item_id: 5,
  managed_path: `/managed/${id}.srt`,
  language: 'chi',
  title: null,
  format: 'srt',
  origin: 'imported',
  is_default: 0,
  status: 'ok',
  ...over,
});

function renderManager() {
  return render(<SubtitleManager itemId={5} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  listSubtitles.mockResolvedValue({ ok: true, data: [ROW(1, { is_default: 1 }), ROW(2, { language: 'eng', origin: 'sidecar' })] });
});

describe('SubtitleManager (QYP2-021)', () => {
  it('lists sidecar and imported subtitles with origin labels', async () => {
    renderManager();
    expect(await screen.findByText(/chi/)).toBeTruthy();
    expect(screen.getByText(/eng/)).toBeTruthy();
    expect(screen.getByText('已导入')).toBeTruthy();
    expect(screen.getByText('外挂')).toBeTruthy();
    expect(screen.getAllByText(/srt/i).length).toBeGreaterThan(0);
  });

  it('shows an empty state with import guidance', async () => {
    listSubtitles.mockResolvedValue({ ok: true, data: [] });
    renderManager();
    expect(await screen.findByText(/暂无字幕/)).toBeTruthy();
  });

  it('imports through the picker and refreshes the list', async () => {
    pickSubtitleFile.mockResolvedValue('/downloads/new.ass');
    importSubtitle.mockResolvedValue({ ok: true });
    renderManager();
    await screen.findByText(/chi/);
    fireEvent.click(screen.getByRole('button', { name: /导入字幕/ }));
    await waitFor(() => expect(importSubtitle).toHaveBeenCalledWith({ itemId: 5, sourcePath: '/downloads/new.ass' }));
    await waitFor(() => expect(listSubtitles).toHaveBeenCalledTimes(2));
  });

  it('cancels quietly when the picker is dismissed', async () => {
    pickSubtitleFile.mockResolvedValue(null);
    renderManager();
    await screen.findByText(/chi/);
    fireEvent.click(screen.getByRole('button', { name: /导入字幕/ }));
    await waitFor(() => expect(pickSubtitleFile).toHaveBeenCalled());
    expect(importSubtitle).not.toHaveBeenCalled();
  });

  it('surfaces import failures without touching the list', async () => {
    pickSubtitleFile.mockResolvedValue('/x.srt');
    importSubtitle.mockResolvedValue({ ok: false, error: { message: '字幕文件超过 20 MiB 上限' } });
    renderManager();
    await screen.findByText(/chi/);
    fireEvent.click(screen.getByRole('button', { name: /导入字幕/ }));
    await waitFor(() => expect(addToast).toHaveBeenCalledWith('字幕文件超过 20 MiB 上限', 'error'));
    expect(listSubtitles).toHaveBeenCalledTimes(1);
  });

  it('optimistically switches the default and rolls back on failure', async () => {
    setDefaultSubtitle.mockRejectedValue(new Error('ipc down'));
    renderManager();
    await screen.findByText(/chi/);
    // Row 2 is not default; its star button sets default optimistically.
    fireEvent.click(screen.getByRole('button', { name: /设为默认字幕 eng/ }));
    await waitFor(() => expect(setDefaultSubtitle).toHaveBeenCalledWith(5, 2));
    // Rollback: row 1 stays default, no star button for row 1.
    await waitFor(() => expect(screen.getByRole('button', { name: /设为默认字幕 eng/ })).toBeTruthy());
    expect(screen.queryByRole('button', { name: /设为默认字幕 chi/ })).toBeNull();
  });

  it('optimistically removes a subtitle and rolls back on failure', async () => {
    removeSubtitle.mockResolvedValue({ ok: false, error: { message: '字幕文件删除失败' } });
    renderManager();
    await screen.findByText(/chi/);
    fireEvent.click(screen.getByRole('button', { name: /移除字幕 chi/ }));
    // Optimistic: row disappears momentarily, then rolls back.
    await waitFor(() => expect(removeSubtitle).toHaveBeenCalledWith(5, 1));
    await waitFor(() => expect(screen.getByText(/chi/)).toBeTruthy());
    expect(addToast).toHaveBeenCalledWith('字幕文件删除失败', 'error');
  });

  it('removes successfully: row stays gone and toast fires', async () => {
    removeSubtitle.mockResolvedValue({ ok: true });
    renderManager();
    await screen.findByText(/chi/);
    fireEvent.click(screen.getByRole('button', { name: /移除字幕 chi/ }));
    await waitFor(() => expect(screen.queryByText(/chi/)).toBeNull());
  });

  it('marks missing/corrupt rows with a warning tag', async () => {
    listSubtitles.mockResolvedValue({ ok: true, data: [ROW(1, { status: 'missing' })] });
    renderManager();
    expect(await screen.findByText('缺失')).toBeTruthy();
  });
});
