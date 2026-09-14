// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PlaybackSettings from '../../../src/renderer/pages/Settings/PlaybackSettings';

/**
 * 跳过片头/片尾设置（剧集）：开关持久化 + 文案不出现技术术语。
 */
const getAutoNextEnabled = vi.fn();
const setAutoNextEnabled = vi.fn();
const getSkipSettings = vi.fn();
const setSkipSetting = vi.fn();

vi.stubGlobal('electronAPI', {
  getAutoNextEnabled,
  setAutoNextEnabled,
  getSkipSettings,
  setSkipSetting,
});

const addToast = vi.fn();
vi.mock('../../../src/renderer/stores/toast-store', () => ({
  useToastStore: (sel: (s: { addToast: typeof addToast }) => unknown) =>
    sel({ addToast }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  getAutoNextEnabled.mockResolvedValue({ ok: true, data: { enabled: true } });
  getSkipSettings.mockResolvedValue({ ok: true, data: { skipIntro: true, skipOutro: false } });
});

describe('PlaybackSettings 跳过片头/片尾开关', () => {
  it('defaults render from main-side settings (intro on, outro off)', async () => {
    render(<PlaybackSettings />);
    await waitFor(() => expect(screen.getByText('自动跳过片头（剧集）')).toBeTruthy());
    const intro = screen.getByLabelText(/自动跳过片头（剧集）/) as HTMLInputElement;
    const outro = screen.getByLabelText(/自动跳过片尾（剧集）/) as HTMLInputElement;
    expect(intro.checked).toBe(true);
    expect(outro.checked).toBe(false);
  });

  it('toggling outro persists via setSkipSetting and updates state', async () => {
    setSkipSetting.mockResolvedValue({ ok: true, key: 'skipOutro', enabled: true });
    render(<PlaybackSettings />);
    await waitFor(() => expect(screen.getByLabelText(/自动跳过片尾（剧集）/)).toBeTruthy());
    fireEvent.click(screen.getByLabelText(/自动跳过片尾（剧集）/));
    await waitFor(() => expect(setSkipSetting).toHaveBeenCalledWith('skipOutro', true));
    await waitFor(() => {
      expect((screen.getByLabelText(/自动跳过片尾（剧集）/) as HTMLInputElement).checked).toBe(true);
    });
  });

  it('failed save rolls the toggle back and toasts the error', async () => {
    setSkipSetting.mockResolvedValue({ ok: false });
    render(<PlaybackSettings />);
    await waitFor(() => expect(screen.getByLabelText(/自动跳过片头（剧集）/) !== null).toBe(true));
    const intro = screen.getByLabelText(/自动跳过片头（剧集）/) as HTMLInputElement;
    fireEvent.click(intro);
    await waitFor(() => expect(setSkipSetting).toHaveBeenCalledWith('skipIntro', false));
    await waitFor(() => {
      expect((screen.getByLabelText(/自动跳过片头（剧集）/) as HTMLInputElement).checked).toBe(true);
    });
    expect(addToast).toHaveBeenCalledWith('设置保存失败，请重试', 'error');
  });
});
