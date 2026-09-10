// @vitest-environment jsdom
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import MediaSources from '../../../src/renderer/pages/MediaSources';
import SourceForm from '../../../src/renderer/pages/MediaSources/SourceForm';

const listSources = vi.fn();
const saveSource = vi.fn();
const testSource = vi.fn();
const removeSource = vi.fn();
const startScan = vi.fn();
const cancelScan = vi.fn();
const pickDirectory = vi.fn();

type ScanListener = (event: unknown) => void;
const scanListeners = new Set<ScanListener>();
const onScanProgress = vi.fn((cb: ScanListener) => {
  scanListeners.add(cb);
  return () => scanListeners.delete(cb);
});

function emitScanEvent(event: Record<string, unknown>): void {
  act(() => {
    for (const cb of [...scanListeners]) cb(event);
  });
}

// Stub on globalThis (== window in the jsdom environment); replacing the
// whole window object would drop jsdom's prototype chain and crash react-dom.
vi.stubGlobal('electronAPI', {
  getServers: vi.fn(async () => []),
  isSecretsPersistent: vi.fn(async () => true),
  saveServer: vi.fn(),
  listSources,
  saveSource,
  testSource,
  removeSource,
  sourceHealth: vi.fn(),
  startScan,
  cancelScan,
  pickDirectory,
  onScanProgress,
});
vi.stubGlobal('confirm', vi.fn(() => true));
vi.stubGlobal('alert', vi.fn());

beforeEach(() => {
  vi.clearAllMocks();
  scanListeners.clear();
  listSources.mockResolvedValue([]);
  saveSource.mockResolvedValue({ ok: true, data: { sourceId: 1, root: '/data/movies', name: 'Movies' } });
  testSource.mockResolvedValue({ ok: true, data: { canSeek: true, canDelete: false, supportsEtag: false, supportsRange: true } });
  removeSource.mockResolvedValue({ ok: true });
  startScan.mockResolvedValue({ ok: true });
  cancelScan.mockResolvedValue({ ok: true });
  pickDirectory.mockResolvedValue('/data/movies');
});

describe('SourceForm (add local source)', () => {
  it('picks a directory and saves with the selected root', async () => {
    const onSave = vi.fn(async () => true);
    render(
      <SourceForm
        saving={false}
        testing={false}
        formError={null}
        persistentSecrets={true}

        onPick={pickDirectory}
        onTest={testSource}
        onSave={onSave}
        onCancel={() => undefined}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /选择目录/ }));
    await waitFor(() => expect(screen.getByText('/data/movies')).toBeTruthy());

    fireEvent.input(screen.getByLabelText(/名称/), { target: { value: '电影收藏' } });
    fireEvent.click(screen.getByRole('button', { name: /添加来源/ }));

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({ kind: 'local', root: '/data/movies', name: '电影收藏' })
    );
    // 1280x800 no-horizontal-scroll policy: action rows wrap instead.
    expect(document.querySelector('[data-testid="source-form"] .flex-wrap')).toBeTruthy();
  });

  it('shows a validation error without calling save when no directory is picked', async () => {
    const onSave = vi.fn(async () => false);
    render(
      <SourceForm
        saving={false}
        testing={false}
        formError={null}
        persistentSecrets={true}

        onPick={pickDirectory}
        onTest={testSource}
        onSave={onSave}
        onCancel={() => undefined}
      />
    );
    pickDirectory.mockResolvedValue(null);
    fireEvent.click(screen.getByRole('button', { name: /选择目录/ }));
    fireEvent.click(screen.getByRole('button', { name: /添加来源/ }));
    await waitFor(() => expect(onSave).not.toHaveBeenCalled());
  });
});

describe('MediaSources page sources section', () => {
  it('lists sources with scan state and removal wording that promises files stay', async () => {
    listSources.mockResolvedValue([
      {
        id: 1,
        kind: 'local',
        name: '电影收藏',
        root: '/data/movies',
        readOnly: true,
        capabilities: { canSeek: true, canDelete: false, supportsEtag: false, supportsRange: true },
        hasCredential: false,
        lastRun: { status: 'completed', processed: 12, total: 12, at: Date.now() },
      },
    ]);
    render(<MemoryRouter><MediaSources /></MemoryRouter>);

    await waitFor(() => expect(screen.getByText('电影收藏')).toBeTruthy());
    expect(screen.getByText(/完成，共 12 项/)).toBeTruthy();
    // Removal affordance explicitly promises the files are untouched.
    expect(screen.getByTitle('移除（不删除文件）')).toBeTruthy();
    expect(screen.getByLabelText(/移除 电影收藏（不删除文件）/)).toBeTruthy();
  });

  it('starts a scan and reflects the running state from push events', async () => {
    listSources.mockResolvedValue([
      {
        id: 2,
        kind: 'local',
        name: '剧集库',
        root: '/data/tv',
        readOnly: true,
        capabilities: { canSeek: true, canDelete: false, supportsEtag: false, supportsRange: true },
        hasCredential: false,
      },
    ]);
    render(<MemoryRouter><MediaSources /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('剧集库')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /扫描 剧集库/ }));
    await waitFor(() => expect(startScan).toHaveBeenCalledWith(2));

    // Main pushes a progress event; the row flips into a running state.
    emitScanEvent({ sourceId: 2, runId: 1, state: 'indexing', processed: 3, total: 10, at: Date.now() });
    await waitFor(() => expect(screen.getByText(/扫描中/)).toBeTruthy());
    expect(screen.getByText(/3\/10/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /取消扫描 剧集库/ })).toBeTruthy();
  });

  it('shows a completion toast event path without breaking the row', async () => {
    listSources.mockResolvedValue([
      {
        id: 3,
        kind: 'local',
        name: '电影',
        root: '/data/movies',
        readOnly: true,
        capabilities: { canSeek: true, canDelete: false, supportsEtag: false, supportsRange: true },
        hasCredential: false,
      },
    ]);
    render(<MemoryRouter><MediaSources /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('电影')).toBeTruthy());

    emitScanEvent({ sourceId: 3, runId: 1, state: 'completed', processed: 7, total: 7, at: Date.now() });
    await waitFor(() => expect(screen.getByText(/完成，共 7 项/)).toBeTruthy());
  });

  it('removing a source calls removeSource after confirm (files untouched)', async () => {
    listSources.mockResolvedValue([
      {
        id: 4,
        kind: 'local',
        name: '旧库',
        root: '/data/old',
        readOnly: true,
        capabilities: { canSeek: true, canDelete: false, supportsEtag: false, supportsRange: true },
        hasCredential: false,
      },
    ]);
    render(<MemoryRouter><MediaSources /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('旧库')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /移除 旧库（不删除文件）/ }));
    await waitFor(() => expect(removeSource).toHaveBeenCalledWith(4));
    expect((confirm as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain('不会删除磁盘上的媒体文件');
  });
});
