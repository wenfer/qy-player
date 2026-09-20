// @vitest-environment jsdom
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import MediaSourcesPage from '../../../src/renderer/pages/MediaSources/MediaSourcesPage';
import SourceForm from '../../../src/renderer/pages/MediaSources/SourceForm';
import type { SourceListEntry, SourcePurpose } from '../../../src/shared/types';

/**
 * 媒体库按域分离（QYP3-041）：一个来源只属于音乐域或影视域，两个媒体库页
 * 各管各的、互不显示；用途由所在模式决定，表单不再让用户选。
 *
 * QYP3-055：拆域遗留需要一个恢复入口——不属于本域的目录/WebDAV 来源列在
 * 「其它来源」转域区，可一键改成音乐/影视来源（已索引内容不动）。
 */

const listSources = vi.fn();
const setSourcePurpose = vi.fn();

vi.stubGlobal('electronAPI', {
  getServers: vi.fn(async () => [{ id: 1, type: 'jellyfin', name: '家里', base_url: 'http://nas', is_active: 1 }]),
  isSecretsPersistent: vi.fn(async () => true),
  saveServer: vi.fn(),
  listSources,
  saveSource: vi.fn(async () => ({ ok: true, data: { sourceId: 1 } })),
  testSource: vi.fn(async () => ({ ok: true, data: { canSeek: true, canDelete: false, supportsEtag: true, supportsRange: true } })),
  removeSource: vi.fn(),
  setSourcePurpose,
  sourceHealth: vi.fn(),
  startScan: vi.fn(async () => ({ ok: true })),
  cancelScan: vi.fn(),
  pickDirectory: vi.fn(async () => null),
  onScanProgress: vi.fn(() => () => undefined),
});

const entry = (id: number, name: string, purpose: SourceListEntry['purpose']): SourceListEntry => ({
  id,
  kind: 'local',
  name,
  root: `/data/${name}`,
  readOnly: true,
  capabilities: { canSeek: true, canDelete: true, supportsEtag: false, supportsRange: true },
  hasCredential: false,
  purpose,
});

const MIXED = [entry(1, '音乐盘', 'music'), entry(2, '影片盘', 'video')];

function renderPage(mode: 'video' | 'music'): void {
  render(
    <MemoryRouter>
      <MediaSourcesPage mode={mode} />
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('MediaSourcesPage domain split (QYP3-041/055)', () => {
  it('video mode shows only video sources in its own list', async () => {
    listSources.mockResolvedValue(MIXED);
    renderPage('video');
    await waitFor(() => expect(screen.getByText('影片盘')).toBeTruthy());
    // 音乐盘出现在「其它来源」转域区，不进本域管理区
    expect(screen.getByLabelText('其它来源')).toBeTruthy();
    expect(screen.getByLabelText('媒体来源').textContent).not.toContain('音乐盘');
  });

  it('music mode shows only music sources in its own list', async () => {
    listSources.mockResolvedValue(MIXED);
    renderPage('music');
    await waitFor(() => expect(screen.getByText('音乐盘')).toBeTruthy());
    // 影视盘出现在「其它来源」转域区，不进本域管理区
    expect(screen.getByLabelText('其它来源')).toBeTruthy();
    expect(screen.getByLabelText('媒体来源').textContent).not.toContain('影片盘');
  });

  it('offers a one-click conversion for foreign sources (QYP3-055)', async () => {
    listSources.mockResolvedValue([entry(5, 'Music', 'video'), entry(6, '老片盘', 'video')]);
    window.confirm = vi.fn(() => true);
    setSourcePurpose.mockResolvedValue({ ok: true, data: { purpose: 'music' } });
    renderPage('music');
    await waitFor(() => expect(screen.getByText('Music')).toBeTruthy());
    expect(screen.getAllByRole('button', { name: '改为音乐来源' })).toHaveLength(2);

    fireEvent.click(screen.getAllByRole('button', { name: '改为音乐来源' })[0]);
    await waitFor(() => expect(setSourcePurpose).toHaveBeenCalledWith(5, 'music'));
    // 转换成功后回读来源列表（转过去的来源从此出现在本域管理区）
    await waitFor(() => expect(listSources.mock.calls.length).toBeGreaterThan(1));
  });

  it('cancelling the confirm dialog never calls the IPC', async () => {
    listSources.mockResolvedValue([entry(5, 'Music', 'video')]);
    window.confirm = vi.fn(() => false);
    renderPage('music');
    await waitFor(() => expect(screen.getByText('Music')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '改为音乐来源' }));
    await waitFor(() => expect(window.confirm).toHaveBeenCalled());
    expect(setSourcePurpose).not.toHaveBeenCalled();
  });

  it('music mode does not manage media servers, video mode does', async () => {
    listSources.mockResolvedValue([]);
    renderPage('music');
    await waitFor(() => expect(screen.getByText('音乐媒体库')).toBeTruthy());
    expect(screen.queryByRole('region', { name: '媒体服务器' })).not.toBeTruthy();
    expect(screen.queryByLabelText('媒体服务器')).not.toBeTruthy();
    expect(screen.getByText(/影视模式的「媒体库」里管理/)).toBeTruthy();
  });

  it('video mode still lists servers', async () => {
    listSources.mockResolvedValue([]);
    renderPage('video');
    await waitFor(() => expect(screen.getByText('家里')).toBeTruthy());
    expect(screen.getByLabelText('媒体服务器')).toBeTruthy();
  });
});

describe('SourceForm purpose (QYP3-041)', () => {
  const baseProps = {
    saving: false,
    testing: false,
    formError: null,
    persistentSecrets: true,
    onPick: vi.fn(async () => '/data/picked'),
    onTest: vi.fn(async () => ({ ok: true })),
    onSave: vi.fn(async () => true),
    onCancel: vi.fn(),
  };

  function renderForm(purpose: SourcePurpose): void {
    render(<SourceForm {...baseProps} purpose={purpose} />);
  }

  it('submits the purpose given by the owning page, with no purpose picker', async () => {
    renderForm('music');
    expect(screen.queryByRole('radiogroup', { name: '来源用途' })).not.toBeTruthy();
    fireEvent.click(screen.getByText('选择目录'));
    await waitFor(() => expect(baseProps.onPick).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: '添加来源' }));
    await waitFor(() =>
      expect(baseProps.onSave).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'local', root: '/data/picked', purpose: 'music' })
      )
    );
  });

  it('applies the same purpose to webdav payloads', async () => {
    renderForm('video');
    fireEvent.click(screen.getByRole('tab', { name: 'WebDAV' }));
    fireEvent.change(screen.getByLabelText(/服务器地址/), { target: { value: 'https://dav.example.com' } });
    fireEvent.click(screen.getByRole('button', { name: '添加来源' }));
    await waitFor(() =>
      expect(baseProps.onSave).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'webdav', purpose: 'video', confirmHttpPlaintext: false })
      )
    );
  });
});
