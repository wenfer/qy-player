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
 */

const listSources = vi.fn();

vi.stubGlobal('electronAPI', {
  getServers: vi.fn(async () => [{ id: 1, type: 'jellyfin', name: '家里', base_url: 'http://nas', is_active: 1 }]),
  isSecretsPersistent: vi.fn(async () => true),
  saveServer: vi.fn(),
  listSources,
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

describe('MediaSourcesPage domain split (QYP3-041)', () => {
  it('video mode shows only video sources', async () => {
    listSources.mockResolvedValue(MIXED);
    renderPage('video');
    await waitFor(() => expect(screen.getByText('影片盘')).toBeTruthy());
    expect(screen.queryByText('音乐盘')).not.toBeTruthy();
  });

  it('music mode shows only music sources', async () => {
    listSources.mockResolvedValue(MIXED);
    renderPage('music');
    await waitFor(() => expect(screen.getByText('音乐盘')).toBeTruthy());
    expect(screen.queryByText('影片盘')).not.toBeTruthy();
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
