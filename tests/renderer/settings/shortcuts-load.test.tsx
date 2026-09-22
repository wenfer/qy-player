// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ShortcutsContent } from '../../../src/renderer/pages/Shortcuts';
import { GLOBAL_SHORTCUTS, MPV_BINDINGS } from '../../../src/shared/shortcut-defs';

/**
 * 快捷键配置的**读回**（QYP3-068v 回归）。
 *
 * `SETTINGS.GET` 直接返回解码后的对象、不包 `{ ok, data }`。本页以前读
 * `?.data`，于是永远加载成默认值——更糟的是保存时会把"默认值 + 这一处改动"
 * 写回，**静默丢掉用户其余的绑定**（改一个键丢一片）。这里钉住"已存的覆盖
 * 值会被显示出来"。
 */

/** 取两个可改的项来验（全局项排除 fixed；mpv 项全部可改）。 */
const globalDef = GLOBAL_SHORTCUTS.find((d) => !d.fixed)!;
const mpvDef = MPV_BINDINGS[0];

const api = {
  getSettings: vi.fn((_key: string): Promise<unknown> => Promise.resolve(null)),
  setSettings: vi.fn((_key: string, _value: unknown) => Promise.resolve(undefined)),
  applyShortcuts: vi.fn(() => Promise.resolve({ failed: [] as string[] })),
  applyMpvShortcuts: vi.fn(() => Promise.resolve({ failed: [] as string[] })),
  platform: 'linux',
};

vi.stubGlobal('electronAPI', api);

beforeEach(() => {
  vi.clearAllMocks();
  api.getSettings.mockImplementation((key: string) => {
    if (key === 'shortcuts') return Promise.resolve({ [globalDef.id]: 'Alt+P' });
    if (key === 'mpv-shortcuts') return Promise.resolve({ [mpvDef.id]: 'Ctrl+Alt+M' });
    return Promise.resolve(null);
  });
});

describe('shortcuts page settings (QYP3-068v)', () => {
  it('shows the stored global override instead of the default', async () => {
    render(<ShortcutsContent />);
    await waitFor(() => expect(api.getSettings).toHaveBeenCalledWith('shortcuts'));
    // 覆盖值被格式化后显示（CommandOrControl → Ctrl；这里没有 mod 前缀，原样 Alt+P）
    await waitFor(() =>
      expect(screen.getAllByText('Alt+P').length).toBeGreaterThan(0)
    );
    // 默认值不该再出现在这一行（媒体键标签是符号，不受影响）
    expect(screen.queryByText(globalDef.defaultAccelerator)).toBeNull();
  });

  it('shows the stored mpv binding override too', async () => {
    render(<ShortcutsContent />);
    await waitFor(() => expect(api.getSettings).toHaveBeenCalledWith('mpv-shortcuts'));
    await waitFor(() =>
      expect(screen.getAllByText('Ctrl+Alt+M').length).toBeGreaterThan(0)
    );
  });

  it('writes the merged overrides on save (never a bare default set)', async () => {
    render(<ShortcutsContent />);
    await waitFor(() => expect(screen.getAllByText('Alt+P').length).toBeGreaterThan(0));
    // 「恢复默认」会以当前 ref（含已读回的覆盖值）为基准写盘
    const resetButton = screen.getByRole('button', { name: new RegExp(`恢复默认 ${globalDef.label}`) });
    resetButton.click();
    await waitFor(() => expect(api.setSettings).toHaveBeenCalled());
    const call = api.setSettings.mock.calls.find((c) => c[0] === 'shortcuts');
    expect(call).toBeTruthy();
    // 覆盖值被重置为默认（这正是本次操作的目的），键集合仍然完整
    expect(Object.keys(call![1] as Record<string, string>)).toContain(globalDef.id);
  });
});
