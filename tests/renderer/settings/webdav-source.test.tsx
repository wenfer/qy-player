// @vitest-environment jsdom
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Settings from '../../../src/renderer/pages/Settings';
import SourceForm from '../../../src/renderer/pages/Settings/SourceForm';

const saveSource = vi.fn();
const testSource = vi.fn();
const listSources = vi.fn();
const isSecretsPersistent = vi.fn(async () => true);
const removeSource = vi.fn(async () => ({ ok: true }));
const startScan = vi.fn(async () => ({ ok: true }));
const cancelScan = vi.fn(async () => ({ ok: true }));

type ScanListener = (event: unknown) => void;
const scanListeners = new Set<ScanListener>();
const onScanProgress = vi.fn((cb: ScanListener) => {
  scanListeners.add(cb);
  return () => scanListeners.delete(cb);
});

vi.stubGlobal('electronAPI', {
  getServers: vi.fn(async () => []),
  isSecretsPersistent,
  listSources,
  saveSource,
  testSource,
  removeSource,
  startScan,
  cancelScan,
  sourceHealth: vi.fn(),
  pickDirectory: vi.fn(),
  onScanProgress,
});

beforeEach(() => {
  vi.clearAllMocks();
  scanListeners.clear();
  listSources.mockResolvedValue([]);
  saveSource.mockResolvedValue({ ok: true, data: { sourceId: 9, root: 'https://example.com/dav', name: 'home' } });
  testSource.mockResolvedValue({
    ok: true,
    data: { canSeek: true, canDelete: false, supportsEtag: true, supportsRange: true },
  });
});

function fillWebDavForm(url: string): void {
  // Switch to the WebDAV tab first.
  fireEvent.click(screen.getByRole('tab', { name: /WebDAV/ }));
  const urlInput = screen.getByLabelText(/服务器地址/);
  fireEvent.input(urlInput, { target: { value: url } });
}

describe('WebDAV source form', () => {
  it('saves a WebDAV source with credentials and plaintext consent only when confirmed', async () => {
    // Returning false keeps the form state so both save attempts are visible.
    const onSave = vi.fn(async () => false);
    render(
      <SourceForm
        saving={false}
        testing={false}
        formError={null}
        persistentSecrets={true}
        onPick={vi.fn()}
        onTest={testSource}
        onSave={onSave}
        onCancel={() => undefined}
      />
    );
    fillWebDavForm('http://example.com/dav');
    fireEvent.click(screen.getByRole('button', { name: '添加来源' }));
    // http without consent: the checkbox exists, main would refuse; the
    // form itself must not silently send confirmHttpPlaintext=true.
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'webdav',
          url: 'http://example.com/dav',
          confirmHttpPlaintext: false,
        })
      )
    );
    // After explicit consent the flag flips.
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: '添加来源' }));
    await waitFor(() =>
      expect(onSave).toHaveBeenLastCalledWith(
        expect.objectContaining({ kind: 'webdav', confirmHttpPlaintext: true })
      )
    );
  });

  it('keeps the password field un-echoed and autocomplete-safe', () => {
    render(
      <SourceForm
        saving={false}
        testing={false}
        formError={null}
        persistentSecrets={true}
        onPick={vi.fn()}
        onTest={testSource}
        onSave={vi.fn(async () => true)}
        onCancel={() => undefined}
      />
    );
    fillWebDavForm('https://example.com/dav');
    const password = screen.getByLabelText(/密码/) as HTMLInputElement;
    expect(password.type).toBe('password');
    expect(password.getAttribute('autocomplete')).toBe('new-password');
    expect(password.value).toBe(''); // nothing stored is ever echoed back
  });

  it('reports client-side URL problems without calling test', async () => {
    const onTest = vi.fn();
    render(
      <SourceForm
        saving={false}
        testing={false}
        formError={null}
        persistentSecrets={true}
        onPick={vi.fn()}
        onTest={onTest}
        onSave={vi.fn(async () => true)}
        onCancel={() => undefined}
      />
    );
    fillWebDavForm('http://user:pass@example.com/dav');
    await waitFor(() => expect(screen.getByText(/userinfo/)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /测试连接/ }));
    await waitFor(() => expect(onTest).not.toHaveBeenCalled());
  });

  it('shows the capability line after a successful test', async () => {
    render(
      <SourceForm
        saving={false}
        testing={false}
        formError={null}
        persistentSecrets={true}
        onPick={vi.fn()}
        onTest={vi.fn(async () => ({
          ok: true,
          capabilities: { canSeek: true, canDelete: false, supportsEtag: true, supportsRange: true },
        }))}
        onSave={vi.fn(async () => true)}
        onCancel={() => undefined}
      />
    );
    fillWebDavForm('https://example.com/dav');
    fireEvent.click(screen.getByRole('button', { name: /测试连接/ }));
    await waitFor(() => expect(screen.getByText(/连接成功 ✓/)).toBeTruthy());
    expect(screen.getByText(/拖动\/续播: 支持/)).toBeTruthy();
    expect(screen.getByText(/删除已禁用/)).toBeTruthy();
  });

  it('tells the truth about session-only secret storage', () => {
    render(
      <SourceForm
        saving={false}
        testing={false}
        formError={null}
        persistentSecrets={false}
        onPick={vi.fn()}
        onTest={testSource}
        onSave={vi.fn(async () => true)}
        onCancel={() => undefined}
      />
    );
    fillWebDavForm('https://example.com/dav');
    expect(screen.getByText(/仅保存在本次会话，重启后需要重新输入/)).toBeTruthy();
  });
});

describe('Settings page: WebDAV source rows', () => {
  it('renders capabilities, credential state and the plaintext badge', async () => {
    listSources.mockResolvedValue([
      {
        id: 9,
        kind: 'webdav',
        name: '家庭云盘',
        root: 'http://home.example.com:5005/dav',
        readOnly: true,
        capabilities: { canSeek: true, canDelete: false, supportsEtag: true, supportsRange: true },
        hasCredential: true,
      },
    ]);
    render(
      <MemoryRouter>
        <Settings />
      </MemoryRouter>
    );
    await waitFor(() => expect(screen.getByText('家庭云盘')).toBeTruthy());
    expect(screen.getByText('WebDAV')).toBeTruthy();
    expect(screen.getByText('http 明文')).toBeTruthy();
    expect(screen.getByText('凭据已保存')).toBeTruthy();
    expect(screen.getByText('可拖动/续播')).toBeTruthy();
    expect(screen.getByText('ETag')).toBeTruthy();
    expect(screen.getByText('删除已禁用')).toBeTruthy();
    // Backend ready: WebDAV sources are scannable since QYP2-014.
    const scanButton = screen.getByRole('button', { name: /扫描 家庭云盘/ });
    expect((scanButton as HTMLButtonElement).disabled).toBe(false);
  });

  it('saves through the page handler and refreshes the list', async () => {
    render(
      <MemoryRouter>
        <Settings />
      </MemoryRouter>
    );
    const sourcesSection = await screen.findByRole('region', { name: '本地媒体来源' });
    const addButton = sourcesSection.querySelector('button.bg-primary') as HTMLButtonElement;
    expect(addButton).toBeTruthy();
    fireEvent.click(addButton);
    fillWebDavForm('https://example.com/dav');
    fireEvent.click(screen.getByRole('button', { name: '添加来源' }));
    await waitFor(() =>
      expect(saveSource).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'webdav', url: 'https://example.com/dav' })
      )
    );
    await waitFor(() => expect(listSources).toHaveBeenCalled());
  });
});
