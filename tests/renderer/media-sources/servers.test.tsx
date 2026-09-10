// @vitest-environment jsdom
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MediaSources from '../../../src/renderer/pages/MediaSources';

const getServers = vi.fn();
const saveServer = vi.fn();
const testServer = vi.fn();

vi.stubGlobal('electronAPI', {
  getServers,
  saveServer,
  testServer,
  listSources: vi.fn(async () => []),
  isSecretsPersistent: vi.fn(async () => true),
  sourceHealth: vi.fn(),
  startScan: vi.fn(async () => ({ ok: true })),
  cancelScan: vi.fn(async () => ({ ok: true })),
  pickDirectory: vi.fn(),
  onScanProgress: vi.fn(() => () => undefined),
});

// Toast store: a STABLE addToast (vi.hoisted) — a fresh vi.fn() per
// selector call would change the slice reference each render and loop
// React forever.
const { addToast } = vi.hoisted(() => ({ addToast: vi.fn() }));
vi.mock('../../../src/renderer/stores/toast-store', () => ({
  useToastStore: (selector: (s: { addToast: (msg: string, type?: string) => void }) => unknown) =>
    selector({ addToast }),
}));

const SERVER = {
  id: 1,
  type: 'jellyfin',
  name: '家庭 NAS',
  base_url: 'http://192.168.1.10:8096',
  hasCredential: true,
  username: 'demo',
  user_id: 'u-1',
  is_active: 1,
};

function renderPage() {
  return render(
    <MemoryRouter>
      <MediaSources />
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  getServers.mockResolvedValue([SERVER]);
  saveServer.mockResolvedValue(undefined);
});

describe('MediaSources page: 媒体服务器 section', () => {
  it('lists servers with login state and credentials never echo', async () => {
    renderPage();
    expect(await screen.findByText('家庭 NAS')).toBeTruthy();
    expect(screen.getByText('已登录')).toBeTruthy();
    expect(screen.getByText(/JELLYFIN/)).toBeTruthy();
    expect(document.body.textContent).not.toContain('password');
  });

  it('shows the empty state without servers', async () => {
    getServers.mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText(/暂无服务器/)).toBeTruthy();
  });

  it('opens the server form via 添加 and saves through saveServer', async () => {
    testServer.mockResolvedValue({ ok: true, userId: 'u-9' });
    saveServer.mockResolvedValue(undefined);
    renderPage();
    const section = await screen.findByRole('region', { name: '媒体服务器' });
    const addButton = section.querySelector('button.bg-primary') as HTMLButtonElement;
    fireEvent.click(addButton);
    fireEvent.change(screen.getByLabelText(/^类型$/), { target: { value: 'emby' } });
    fireEvent.change(screen.getByLabelText(/^名称$/), { target: { value: 'Emby 测试' } });
    fireEvent.change(screen.getByLabelText(/服务器地址/), { target: { value: 'http://emby.example.com' } });
    fireEvent.change(screen.getByLabelText(/^用户名$/), { target: { value: 'alice' } });
    fireEvent.change(screen.getByLabelText(/^密码$/), { target: { value: 'secret-1' } });
    fireEvent.click(screen.getByRole('button', { name: /保存$/ }));
    await waitFor(() =>
      expect(saveServer).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'emby',
          name: 'Emby 测试',
          baseUrl: 'http://emby.example.com',
          username: 'alice',
          password: 'secret-1',
          userId: undefined,
        })
      )
    );
    // The password travels to saveServer (main-side auth) but the list
    // refresh must re-read servers, never carry the password forward.
    await waitFor(() => expect(getServers).toHaveBeenCalled());
  });

  it('delete calls saveServer with isActive:false (soft delete)', async () => {
    renderPage();
    await screen.findByText('家庭 NAS');
    fireEvent.click(screen.getByRole('button', { name: '删除 家庭 NAS' }));
    await waitFor(() =>
      expect(saveServer).toHaveBeenCalledWith(expect.objectContaining({ id: 1, isActive: false }))
    );
  });

  it('edit prefills the form without echoing a stored password', async () => {
    renderPage();
    await screen.findByText('家庭 NAS');
    fireEvent.click(screen.getByRole('button', { name: '编辑 家庭 NAS' }));
    const name = screen.getByLabelText(/^名称$/) as HTMLInputElement;
    expect(name.value).toBe('家庭 NAS');
    const password = screen.getByLabelText(/^密码$/) as HTMLInputElement;
    expect(password.value).toBe('');
  });

  it('shows a form error when auth fails on save', async () => {
    testServer.mockResolvedValue({ ok: false });
    renderPage();
    const section = await screen.findByRole('region', { name: '媒体服务器' });
    fireEvent.click(section.querySelector('button.bg-primary') as HTMLButtonElement);
    fireEvent.change(screen.getByLabelText(/^名称$/), { target: { value: 'X' } });
    fireEvent.change(screen.getByLabelText(/服务器地址/), { target: { value: 'http://x' } });
    fireEvent.change(screen.getByLabelText(/^用户名$/), { target: { value: 'a' } });
    fireEvent.change(screen.getByLabelText(/^密码$/), { target: { value: 'b' } });
    fireEvent.click(screen.getByRole('button', { name: /保存$/ }));
    await waitFor(() => expect(screen.getByText(/认证失败/)).toBeTruthy());
    expect(saveServer).not.toHaveBeenCalled();
  });
});
