// @vitest-environment jsdom
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MusicSettings, { parseEqPresets } from '../../../src/renderer/pages/Settings/MusicSettings';

const getSettings = vi.fn();
const setSettings = vi.fn();

vi.stubGlobal('electronAPI', { getSettings, setSettings });

const flat = new Array(10).fill(0);

beforeEach(() => {
  vi.clearAllMocks();
  getSettings.mockImplementation((key: string) => {
    if (key === 'playback.eqPresets') {
      return Promise.resolve({
        ok: true,
        data: [{ id: 'custom-1', label: '我的低音', gains: [6, 5, 3, 1, 0, 0, 0, 0, 0, 0] }],
      });
    }
    return Promise.resolve({ ok: true, data: null });
  });
  setSettings.mockResolvedValue({ ok: true });
});

describe('EQ preset editor (QYP3-012a)', () => {
  it('rejects malformed preset payloads', () => {
    expect(parseEqPresets(null)).toEqual([]);
    expect(parseEqPresets([{ label: 'x', gains: [1, 2] }])).toEqual([]);
    expect(parseEqPresets([{ label: 'x', gains: [...flat, 'a'] }])).toEqual([]);
    expect(parseEqPresets([{ label: 'ok', gains: flat }])).toEqual([
      { id: 'custom-0', label: 'ok', gains: flat },
    ]);
  });

  it('renders built-in and custom presets, custom ones are deletable', async () => {
    render(<MusicSettings />);
    await waitFor(() => expect(screen.getByRole('button', { name: '我的低音' })).toBeTruthy());
    expect(screen.getByRole('button', { name: '摇滚' })).toBeTruthy(); // 内置
    expect(screen.getByRole('button', { name: '删除预设 我的低音' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '删除预设 摇滚' })).toBeNull();
  });

  it('applies a preset by writing playback.eqGains', async () => {
    render(<MusicSettings />);
    await waitFor(() => expect(screen.getByRole('button', { name: '我的低音' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '我的低音' }));
    await waitFor(() =>
      expect(setSettings).toHaveBeenCalledWith('playback.eqGains', [6, 5, 3, 1, 0, 0, 0, 0, 0, 0])
    );
  });

  it('saves the current sliders as a named preset', async () => {
    render(<MusicSettings />);
    await waitFor(() => expect(screen.getByRole('button', { name: '我的低音' })).toBeTruthy());
    fireEvent.change(screen.getByLabelText('自定义预设名称'), { target: { value: '深夜' } });
    fireEvent.click(screen.getByRole('button', { name: '保存当前为预设' }));
    await waitFor(() => {
      const call = setSettings.mock.calls.find((c) => c[0] === 'playback.eqPresets');
      expect(call).toBeTruthy();
      const saved = call![1] as Array<{ label: string; gains: number[] }>;
      expect(saved.map((p) => p.label)).toEqual(['我的低音', '深夜']);
    });
  });

  it('rejects empty and duplicate preset names', async () => {
    render(<MusicSettings />);
    await waitFor(() => expect(screen.getByRole('button', { name: '我的低音' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '保存当前为预设' }));
    expect(setSettings).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('自定义预设名称'), { target: { value: '我的低音' } });
    fireEvent.click(screen.getByRole('button', { name: '保存当前为预设' }));
    expect(setSettings).not.toHaveBeenCalled();
  });

  it('deletes a custom preset', async () => {
    render(<MusicSettings />);
    await waitFor(() => expect(screen.getByRole('button', { name: '删除预设 我的低音' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '删除预设 我的低音' }));
    await waitFor(() => expect(setSettings).toHaveBeenCalledWith('playback.eqPresets', []));
  });
});
