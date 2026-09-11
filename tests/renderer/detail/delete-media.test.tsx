// @vitest-environment jsdom
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DeleteMediaDialog from '../../../src/renderer/pages/Detail/DeleteMediaDialog';
import MediaActions from '../../../src/renderer/pages/Detail/MediaActions';

const previewMediaDeletion = vi.fn();
const executeMediaDeletion = vi.fn();
const { addToast } = vi.hoisted(() => ({ addToast: vi.fn() }));
vi.mock('../../../src/renderer/stores/toast-store', () => ({
  useToastStore: (selector: (s: { addToast: unknown }) => unknown) => selector({ addToast }),
}));

vi.stubGlobal('electronAPI', { previewMediaDeletion, executeMediaDeletion });

const PREVIEW = {
  sourceId: 1,
  itemId: 7,
  itemTitle: '电影A',
  sourceName: '本地库',
  sourceKind: 'local' as const,
  targetDir: '电影A',
  fileCount: 2,
  totalBytes: 52428800,
  method: 'local-trash' as const,
  token: 'tok-123',
  requiresTitleConfirmation: false,
};

function renderDialog(over: Partial<Parameters<typeof DeleteMediaDialog>[0]> = {}) {
  const onClose = vi.fn();
  const onDeleted = vi.fn();
  render(
    <DeleteMediaDialog sourceId={1} itemId={7} open onClose={onClose} onDeleted={onDeleted} {...over} />
  );
  return { onClose, onDeleted };
}

beforeEach(() => {
  vi.clearAllMocks();
  previewMediaDeletion.mockResolvedValue({ ok: true, data: PREVIEW });
  executeMediaDeletion.mockResolvedValue({ ok: true, data: { status: 'trashed', itemId: 7 } });
});

describe('DeleteMediaDialog (QYP2-025)', () => {
  it('shows the real scope: title, source, dir, file count, method', async () => {
    renderDialog();
    // Scope fields render exactly once (媒体 + 目录 both show the name).
    await waitFor(() => expect(screen.getAllByText('电影A').length).toBeGreaterThanOrEqual(1));
    expect(screen.getByText('本地库（本地）')).toBeTruthy();
    expect(screen.getByText(/2 个文件/)).toBeTruthy();
    expect(screen.getByText('移入系统回收站（可恢复）')).toBeTruthy();
    // The renderer never receives or shows absolute paths.
    expect(document.body.textContent).not.toContain('/tmp/');
  });

  it('preview failure shows an honest error with a re-check button', async () => {
    previewMediaDeletion.mockResolvedValue({ ok: false, error: { message: '该目录包含其他条目的文件，不能删除' } });
    renderDialog();
    expect(await screen.findByText(/该目录包含其他条目的文件/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '重新检查' })).toBeTruthy();
    // No execute button without a preview (nothing to run).
    expect(screen.queryByRole('button', { name: /移入回收站/ })).toBeNull();
  });

  it('executes with the token and reports trash success', async () => {
    const { onClose, onDeleted } = renderDialog();
    await waitFor(() => expect(screen.getByRole('button', { name: '移入回收站' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '移入回收站' }));
    await waitFor(() => expect(executeMediaDeletion).toHaveBeenCalledWith({ token: 'tok-123' }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith({ status: 'trashed', itemId: 7 }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('webdav requires typing the real title before enabling execution', async () => {
    previewMediaDeletion.mockResolvedValue({
      ok: true,
      data: {
        ...PREVIEW,
        method: 'webdav-delete',
        sourceName: '云盘',
        sourceKind: 'webdav',
        requiresTitleConfirmation: true,
      },
    });
    renderDialog();
    expect(await screen.findByText('从服务器永久删除（不可恢复）')).toBeTruthy();
    const execute = screen.getByRole('button', { name: '永久删除' }) as HTMLButtonElement;
    expect(execute.disabled).toBe(true); // empty input blocks
    fireEvent.change(screen.getByLabelText('输入媒体标题以确认永久删除'), { target: { value: '错误' } });
    expect((screen.getByRole('button', { name: '永久删除' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('输入媒体标题以确认永久删除'), { target: { value: '电影A' } });
    expect((screen.getByRole('button', { name: '永久删除' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '永久删除' }));
    await waitFor(() =>
      expect(executeMediaDeletion).toHaveBeenCalledWith({ token: 'tok-123', confirmTitle: '电影A' })
    );
  });

  it('failure consumes the token server-side: preview resets, no silent retry', async () => {
    executeMediaDeletion.mockResolvedValue({ ok: false, error: { message: '目标已变化（文件内容或大小改变），请重新预览' } });
    renderDialog();
    await waitFor(() => expect(screen.getByRole('button', { name: '移入回收站' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '移入回收站' }));
    await waitFor(() => expect(screen.getByText(/目标已变化/)).toBeTruthy());
    // The stale token cannot be retried: only 重新检查 (fresh preview) exists.
    expect(screen.queryByRole('button', { name: /移入回收站/ })).toBeNull();
    expect(screen.getByRole('button', { name: '重新检查' })).toBeTruthy();
  });

  it('unknown outcomes do NOT report success — re-probe instead', async () => {
    executeMediaDeletion.mockResolvedValue({ ok: true, data: { status: 'unknown', itemId: 7 } });
    const { onDeleted, onClose } = renderDialog();
    await waitFor(() => expect(screen.getByRole('button', { name: '移入回收站' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '移入回收站' }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith({ status: 'unknown', itemId: 7 }));
    expect(onClose).toHaveBeenCalled();
    expect(addToast).toHaveBeenCalledWith(expect.stringContaining('未知'), 'warning');
  });

  it('disables double execution and close while running', async () => {
    let resolveExecute: (v: unknown) => void = () => undefined;
    executeMediaDeletion.mockImplementation(
      () => new Promise((resolve) => { resolveExecute = resolve; })
    );
    renderDialog();
    await waitFor(() => expect(screen.getByRole('button', { name: '移入回收站' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '移入回收站' }));
    // In-flight: button shows progress and is disabled; close button too.
    const busy = await screen.findByRole('button', { name: /正在删除/ });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '关闭删除对话框' }) as HTMLButtonElement).disabled).toBe(true);
    resolveExecute({ ok: true, data: { status: 'trashed', itemId: 7 } });
    await waitFor(() => expect(screen.getByRole('button', { name: '移入回收站' })).toBeTruthy());
  });
});

describe('MediaActions (entry container)', () => {
  it('opens the dialog on click and forwards definite deletions', async () => {
    const onDeleted = vi.fn();
    render(<MediaActions sourceId={1} itemId={7} onDeleted={onDeleted} />);
    fireEvent.click(screen.getByRole('button', { name: /删除媒体/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: '移入回收站' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '移入回收站' }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith({ status: 'trashed', itemId: 7 }));
  });

  it('unknown outcomes only refresh — onDeleted still fires for re-probe', async () => {
    executeMediaDeletion.mockResolvedValue({ ok: true, data: { status: 'unknown', itemId: 7 } });
    const onDeleted = vi.fn();
    render(<MediaActions sourceId={1} itemId={7} onDeleted={onDeleted} />);
    fireEvent.click(screen.getByRole('button', { name: /删除媒体/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: '移入回收站' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '移入回收站' }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith({ status: 'unknown', itemId: 7 }));
    expect(addToast).toHaveBeenCalledWith(expect.stringContaining('未知'), 'info');
  });
});
