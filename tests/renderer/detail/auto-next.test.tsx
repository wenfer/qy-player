// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import NextEpisodeCountdown from '../../../src/renderer/components/NextEpisodeCountdown';
import { useAutoNextStore } from '../../../src/renderer/stores/auto-next-store';

/**
 * QYP2-035 renderer tests (plan §12.3): 最后一集不倒计时（立即取消）、
 * 取消、fire 后播放下一集、无 provider 时静默。
 */

type PushHandler = (event: unknown) => void;
const onAutoNextEvent = vi.fn();
const autoNextCancel = vi.fn();
const registeredHandlers: PushHandler[] = [];

vi.stubGlobal('electronAPI', { onAutoNextEvent, autoNextCancel });

beforeEach(() => {
  vi.clearAllMocks();
  useAutoNextStore.getState().setProvider(null);
  // capture the registered push handler
  registeredHandlers.length = 0;
  onAutoNextEvent.mockImplementation((cb: PushHandler) => {
    registeredHandlers.push(cb);
    return () => undefined;
  });
});

async function push(event: unknown): Promise<void> {
  await act(async () => {
    registeredHandlers.forEach((cb) => cb(event));
  });
}

const MEDIA = { mediaType: 'jellyfin', mediaId: 'ep-2', seasonNumber: 1, episodeNumber: 2 };

describe('NextEpisodeCountdown (§12.3)', () => {
  it('countdown with a next episode → shows 5s overlay; cancel calls main', async () => {
    useAutoNextStore.getState().setProvider(async () => ({
      itemId: 'ep-3',
      title: '第三集',
      provider: 'jellyfin',
      serverId: 7,
    }));
    render(<NextEpisodeCountdown onPlayNext={vi.fn()} />);
    await push({ type: 'countdown', seconds: 5, media: MEDIA });
    expect(await screen.findByText('5 秒后播放下一集')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: '取消自动播放' })[0]);
    await waitFor(() => expect(autoNextCancel).toHaveBeenCalledWith('user'));
  });

  it('最后一集 → provider returns null → immediate cancel, no countdown shown', async () => {
    useAutoNextStore.getState().setProvider(async () => null);
    render(<NextEpisodeCountdown onPlayNext={vi.fn()} />);
    await push({ type: 'countdown', seconds: 5, media: MEDIA });
    await waitFor(() => expect(autoNextCancel).toHaveBeenCalledWith('no-next-episode'));
    expect(screen.queryByText(/秒后播放下一集/)).toBeNull();
  });

  it('fire → plays the picked next episode through the handoff (explicit 0)', async () => {
    const onPlayNext = vi.fn();
    useAutoNextStore.getState().setProvider(async () => ({
      itemId: 'ep-3',
      mediaSourceId: 'ms-3',
      provider: 'jellyfin',
      serverId: 7,
    }));
    render(<NextEpisodeCountdown onPlayNext={onPlayNext} />);
    await push({ type: 'countdown', seconds: 5, media: MEDIA });
    await push({ type: 'fire', media: MEDIA });
    await waitFor(() =>
      expect(onPlayNext).toHaveBeenCalledWith({ itemId: 'ep-3', mediaSourceId: 'ms-3', position: 0 })
    );
    expect(screen.queryByText(/秒后播放下一集/)).toBeNull();
  });

  it('no provider registered (离开剧集页) → countdown is silently ignored', async () => {
    render(<NextEpisodeCountdown onPlayNext={vi.fn()} />);
    await push({ type: 'countdown', seconds: 5, media: MEDIA });
    expect(screen.queryByText(/秒后播放下一集/)).toBeNull();
    expect(autoNextCancel).not.toHaveBeenCalled();
  });

  it('cancelled event hides the overlay without toasts', async () => {
    useAutoNextStore.getState().setProvider(async () => ({ itemId: 'ep-3', provider: 'jellyfin', serverId: 7 }));
    render(<NextEpisodeCountdown onPlayNext={vi.fn()} />);
    await push({ type: 'countdown', seconds: 5, media: MEDIA });
    expect(screen.getByText('5 秒后播放下一集')).toBeTruthy();
    await push({ type: 'cancelled', reason: 'user' });
    expect(screen.queryByText(/秒后播放下一集/)).toBeNull();
  });
});
