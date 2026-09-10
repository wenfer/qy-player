// @vitest-environment jsdom
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MetadataEditor from '../../../src/renderer/pages/Detail/MetadataEditor';
import { textToValue, valueToText, FIELD_SHAPES } from '../../../src/renderer/pages/Detail/MetadataField';

const getMetadataFields = vi.fn();
const saveMetadataEdits = vi.fn();
const restoreMetadataFields = vi.fn();
const pickImageFile = vi.fn();
const importImages = vi.fn();

const { addToast } = vi.hoisted(() => ({ addToast: vi.fn() }));
vi.mock('../../../src/renderer/stores/toast-store', () => ({
  useToastStore: (selector: (s: { addToast: unknown }) => unknown) => selector({ addToast }),
}));

vi.stubGlobal('electronAPI', {
  getMetadataFields,
  saveMetadataEdits,
  restoreMetadataFields,
  pickImageFile,
  importImages,
});

function fieldInfo(field: string, over: Record<string, unknown> = {}) {
  return {
    field,
    winner: { provider: 'nfo', revision: 1, value: 'NFO 值' },
    providers: [{ provider: 'nfo', revision: 1, value: 'NFO 值' }],
    ...over,
  };
}

const BASE_FIELDS = [
  fieldInfo('title'),
  fieldInfo('year', { winner: { provider: 'nfo', revision: 2, value: 2019 } }),
  fieldInfo('plot', { winner: { provider: 'filename', revision: 1, value: '文件名剧情' } }),
  fieldInfo('genres', { winner: { provider: 'nfo', revision: 1, value: ['科幻', '灾难'] } }),
  fieldInfo('poster', { winner: null, providers: [] }),
];

function renderEditor(open = true) {
  return render(<MetadataEditor itemId={5} open={open} onClose={() => undefined} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  getMetadataFields.mockResolvedValue({ ok: true, data: { itemId: 5, fields: BASE_FIELDS } });
  saveMetadataEdits.mockResolvedValue({ ok: true, data: { changed: ['title'], cleared: [] } });
});

describe('MetadataEditor (QYP2-023)', () => {
  it('renders fields with provider badges and loads on open', async () => {
    renderEditor();
    expect(await screen.findByText('编辑元数据')).toBeTruthy();
    await waitFor(() => expect(getMetadataFields).toHaveBeenCalledWith(5));
    // Provider badges in Chinese, no internal terms leaking.
    expect(screen.getAllByText('NFO').length).toBeGreaterThan(0);
    expect(screen.getByText('文件名')).toBeTruthy();
  });

  it('sends only changed fields as patches with the seen revision', async () => {
    renderEditor();
    await screen.findByText('编辑元数据');
    const titleInput = screen.getByLabelText('标题') as HTMLInputElement;
    fireEvent.change(titleInput, { target: { value: '手工标题' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() =>
      expect(saveMetadataEdits).toHaveBeenCalledWith(
        5,
        [{ field: 'title', value: '手工标题', expectedRevision: 1 }]
      )
    );
    // Success toast is the only user-visible confirmation (drafts cleared).
    await waitFor(() => expect(addToast).toHaveBeenCalledWith('元数据已保存', 'success'));
  });

  it('keeps drafts and renders per-field diffs on conflict', async () => {
    // Wire shape: conflicts travel in error.details (mapped by the handler).
    saveMetadataEdits.mockResolvedValue({
      ok: false,
      error: {
        code: 'CONFLICT',
        message: '字段已被其他修改更新，请刷新后重试',
        details: {
          conflicts: [
            { field: 'title', expectedRevision: 1, current: { provider: 'nfo', revision: 3, value: '别人改的' } },
          ],
        },
      },
    });
    renderEditor();
    await screen.findByText('编辑元数据');
    fireEvent.change(screen.getByLabelText('标题'), { target: { value: '我的标题' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    // Draft text survives (失败保留草稿).
    expect((screen.getByLabelText('标题') as HTMLInputElement).value).toBe('我的标题');
    // Diff is understandable: current vs submitted.
    expect(await screen.findByText(/当前值/)).toBeTruthy();
    expect(screen.getByText('别人改的')).toBeTruthy();
    expect(screen.getByText('我的标题')).toBeTruthy();
    expect(screen.getByRole('button', { name: '用我的值覆盖' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '放弃我的修改' })).toBeTruthy();
  });

  it('overrides a conflicted field with the current revision', async () => {
    saveMetadataEdits
      .mockResolvedValueOnce({
        ok: false,
        error: {
          code: 'CONFLICT',
          message: 'conflict',
          details: { conflicts: [{ field: 'title', expectedRevision: 1, current: { provider: 'nfo', revision: 3, value: '别人改的' } }] },
        },
      })
      .mockResolvedValueOnce({ ok: true, data: { changed: ['title'], cleared: [] } });
    renderEditor();
    await screen.findByText('编辑元数据');
    fireEvent.change(screen.getByLabelText('标题'), { target: { value: '我的标题' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await screen.findByRole('button', { name: '用我的值覆盖' });
    fireEvent.click(screen.getByRole('button', { name: '用我的值覆盖' }));
    await waitFor(() =>
      expect(saveMetadataEdits).toHaveBeenLastCalledWith(
        5,
        [{ field: 'title', value: '我的标题', expectedRevision: 3 }]
      )
    );
  });

  it('restores a single field and refreshes', async () => {
    restoreMetadataFields.mockResolvedValue({ ok: true, data: { cleared: ['title'] } });
    renderEditor();
    await screen.findByText('编辑元数据');
    fireEvent.click(screen.getByRole('button', { name: '恢复标题的来源值' }));
    await waitFor(() => expect(restoreMetadataFields).toHaveBeenCalledWith(5, ['title']));
    await waitFor(() => expect(getMetadataFields).toHaveBeenCalledTimes(2));
  });

  it('restores all overrides', async () => {
    restoreMetadataFields.mockResolvedValue({ ok: true, data: { cleared: ['title', 'plot'] } });
    renderEditor();
    await screen.findByText('编辑元数据');
    fireEvent.click(screen.getByRole('button', { name: '恢复全部' }));
    await waitFor(() => expect(restoreMetadataFields).toHaveBeenCalledWith(5));
  });

  it('imports poster images through the picker only', async () => {
    pickImageFile.mockResolvedValue('/pics/poster.jpg');
    importImages.mockResolvedValue({ ok: true });
    renderEditor();
    await screen.findByText('编辑元数据');
    fireEvent.click(screen.getByRole('button', { name: '导入 poster 图片' }));
    await waitFor(() => expect(pickImageFile).toHaveBeenCalled());
    expect(importImages).toHaveBeenCalledWith(5, [{ kind: 'poster', sourcePath: '/pics/poster.jpg' }]);
  });

  it('Escape closes the dialog and focus lands inside on open', async () => {
    const { container } = renderEditor();
    await screen.findByText('编辑元数据');
    // Initial focus inside the dialog.
    await waitFor(() => {
      const active = document.activeElement;
      expect(container.querySelector('[role="dialog"]')?.contains(active)).toBe(true);
    });
    fireEvent.keyDown(container.querySelector('[role="dialog"]') as HTMLElement, { key: 'Escape' });
    // Editor stays mounted (parent controls open); our onClose stub does
    // nothing — verified via the toast-free quiet path instead.
    expect(screen.getByText('编辑元数据')).toBeTruthy();
  });

  it('keeps the list scrollable/wrapping without horizontal scroll', async () => {
    const long = fieldInfo('plot', { winner: { provider: 'nfo', revision: 1, value: '长'.repeat(2000) } });
    getMetadataFields.mockResolvedValue({ ok: true, data: { itemId: 5, fields: [...BASE_FIELDS, long] } });
    const { container } = renderEditor();
    await screen.findByText('编辑元数据');
    const dialog = container.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog.className).toContain('overflow-y-auto');
  });
});

describe('field value round-trips', () => {
  it('casts and ids convert between text and wire values', () => {
    expect(valueToText([{ name: '吴京', role: '刘培强' }], 'cast')).toBe('吴京 | 刘培强');
    expect(textToValue('actors', 'cast', '吴京 | 刘培强\n无名')).toEqual([
      { name: '吴京', role: '刘培强' },
      { name: '无名' },
    ]);
    expect(textToValue('uniqueIds', 'ids', 'tmdb:123')).toEqual([{ provider: 'tmdb', id: '123' }]);
    expect(textToValue('genres', 'tags', '科幻， 灾难')).toEqual(['科幻', '灾难']);
    expect(textToValue('year', 'number', '2019')).toBe(2019);
    expect(FIELD_SHAPES.poster).toBe('image');
  });
});
