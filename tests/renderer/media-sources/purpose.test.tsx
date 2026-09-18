// @vitest-environment jsdom
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import MediaSourcesPage from '../../../src/renderer/pages/MediaSources/MediaSourcesPage';
import SourceForm from '../../../src/renderer/pages/MediaSources/SourceForm';
import type { SourceListEntry } from '../../../src/shared/types';

/**
 * 来源用途的 UI 行为（QYP3-039/040）：页面按模式过滤来源、表单带用途
 * 预选、列表内联修改用途触发主进程更新。
 */

const listSources = vi.fn();
const updateSourcePurpose = vi.fn();

vi.stubGlobal('electronAPI', {
  getServers: vi.fn(async () => []),
  isSecretsPersistent: vi.fn(async () => true),
  saveServer: vi.fn(),
  listSources,
  updateSourcePurpose,
  saveSource: vi.fn(async () => ({ ok: true, data: { sourceId: 1 } })),
  testSource: vi.fn(async () => ({ ok: true, data: { canSeek: true, canDelete: false, supportsEtag: true, supportsRange: true } })),
  removeSource: vi.fn(),
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

describe('MediaSourcesPage mode filtering (QYP3-040)', () => {
  it('video mode hides music-only sources and shows the rest', async () => {
    listSources.mockResolvedValue([entry(1, '音乐盘', 'music'), entry(2, '影片盘', 'video'), entry(3, '混合盘', 'all')]);
    renderPage('video');
    await waitFor(() => expect(screen.getByText('影片盘')).toBeTruthy());
    expect(screen.getByText('混合盘')).toBeTruthy();
    expect(screen.queryByText('音乐盘')).not.toBeTruthy();
  });

  it('music mode hides video-only sources and shows the rest', async () => {
    listSources.mockResolvedValue([entry(1, '音乐盘', 'music'), entry(2, '影片盘', 'video'), entry(3, '混合盘', 'all')]);
    renderPage('music');
    await waitFor(() => expect(screen.getByText('音乐盘')).toBeTruthy());
    expect(screen.getByText('混合盘')).toBeTruthy();
    expect(screen.queryByText('影片盘')).not.toBeTruthy();
  });

  it('updates a source purpose through the IPC and reloads', async () => {
    listSources.mockResolvedValue([entry(1, '混合盘', 'all')]);
    updateSourcePurpose.mockResolvedValue({ ok: true });
    renderPage('video');
    await waitFor(() => expect(screen.getByText('混合盘')).toBeTruthy());
    const select = screen.getByLabelText('用途 混合盘') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'music' } });
    await waitFor(() => expect(updateSourcePurpose).toHaveBeenCalledWith(1, 'music'));
    await waitFor(() => expect(listSources.mock.calls.length).toBeGreaterThanOrEqual(2));
  });
});

describe('SourceForm purpose (QYP3-039)', () => {
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

  function renderForm(defaultPurpose?: 'all' | 'music' | 'video'): void {
    render(<SourceForm {...baseProps} defaultPurpose={defaultPurpose} />);
  }

  it("prefers 'video' by default when given", async () => {
    renderForm('video');
    fireEvent.click(screen.getByText('选择目录'));
    await waitFor(() => expect(baseProps.onPick).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: '添加来源' }));
    await waitFor(() =>
      expect(baseProps.onSave).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'local', root: '/data/picked', purpose: 'video' })
      )
    );
  });

  it('defaults to all when no defaultPurpose given, and allows switching to music', async () => {
    renderForm();
    fireEvent.click(screen.getByText('选择目录'));
    await waitFor(() => expect(baseProps.onPick).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('radio', { name: '仅音乐' }));
    fireEvent.click(screen.getByRole('button', { name: '添加来源' }));
    await waitFor(() =>
      expect(baseProps.onSave).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'local', purpose: 'music' })
      )
    );
  });

  it('applies the chosen purpose to webdav payloads too', async () => {
    renderForm('music');
    fireEvent.click(screen.getByRole('tab', { name: 'WebDAV' }));
    fireEvent.change(screen.getByLabelText(/服务器地址/), { target: { value: 'https://dav.example.com' } });
    fireEvent.click(screen.getByRole('button', { name: '添加来源' }));
    await waitFor(() =>
      expect(baseProps.onSave).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'webdav', purpose: 'music', confirmHttpPlaintext: false })
      )
    );
  });
});
