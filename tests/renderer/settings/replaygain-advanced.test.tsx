// @vitest-environment jsdom
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MusicSettings from '../../../src/renderer/pages/Settings/MusicSettings';

/**
 * ReplayGain 高级项（P2）：模式之外还有预增益/兜底增益/削波保护。
 * 关闭时高级项不出现；改动写入 playback.replaygain* 配置。
 */

const getSettings = vi.fn();
const setSettings = vi.fn();

vi.stubGlobal('electronAPI', { getSettings, setSettings });

const values: Record<string, unknown> = {};

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(values)) delete values[k];
  values['playback.replaygain'] = 'track';
  values['playback.replaygainPreamp'] = 3;
  values['playback.replaygainFallback'] = -2.5;
  values['playback.replaygainClip'] = true;
  getSettings.mockImplementation((key: string) =>
    Promise.resolve({ ok: true, data: values[key] ?? null })
  );
  setSettings.mockResolvedValue({ ok: true });
});

describe('ReplayGain advanced settings (P2)', () => {
  it('loads the stored advanced values and writes preamp changes', async () => {
    render(<MusicSettings />);
    const preamp = (await waitFor(() =>
      screen.getByLabelText('ReplayGain 预增益')
    )) as HTMLInputElement;
    expect(preamp.value).toBe('3');
    expect((screen.getByLabelText('ReplayGain 兜底增益') as HTMLInputElement).value).toBe('-2.5');
    expect((screen.getByLabelText('ReplayGain 削波保护') as HTMLInputElement).checked).toBe(true);

    fireEvent.change(preamp, { target: { value: '-4.5' } });
    fireEvent.blur(preamp);
    await waitFor(() =>
      expect(setSettings).toHaveBeenCalledWith('playback.replaygainPreamp', -4.5)
    );
  });

  it('writes the clip toggle immediately', async () => {
    render(<MusicSettings />);
    const clip = (await waitFor(() =>
      screen.getByLabelText('ReplayGain 削波保护')
    )) as HTMLInputElement;
    fireEvent.click(clip);
    await waitFor(() => expect(setSettings).toHaveBeenCalledWith('playback.replaygainClip', false));
  });

  it('hides the advanced block while ReplayGain is off', async () => {
    values['playback.replaygain'] = 'off';
    render(<MusicSettings />);
    await waitFor(() => expect(getSettings).toHaveBeenCalledWith('playback.replaygain'));
    expect(screen.queryByLabelText('ReplayGain 预增益')).toBeNull();
  });
});
