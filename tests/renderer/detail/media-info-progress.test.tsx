// @vitest-environment jsdom
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MediaInfoPanel, { type ProbePhase } from '../../../src/renderer/pages/Detail/MediaInfoPanel';
import ProgressSummary from '../../../src/renderer/pages/Detail/ProgressSummary';
import Detail from '../../../src/renderer/pages/Detail';
import type { MediaProbeOutcome } from '../../../src/shared/types/media-info';

const OK_OUTCOME: MediaProbeOutcome = {
  status: 'ok',
  fingerprint: 'f1',
  probedAt: 1,
  fromCache: false,
  info: {
    version: '0.32.0',
    duration: 3600.5,
    container: 'Matroska',
    video: { codec: 'h264', width: 1920, height: 1080, fps: 23.976 },
    audio: { codec: 'aac', channels: 6, samplerate: 48000 },
    tracks: [
      { kind: 'video', codec: 'h264' },
      { kind: 'audio', codec: 'aac', language: 'eng', isDefault: true },
      { kind: 'subtitle', codec: 'subrip', language: 'chi', title: '中文' },
    ],
    unsupported: [],
  },
};

const electronAPI = {
  getItemDetails: vi.fn(),
  getItems: vi.fn(async () => []),
  resolvePlayback: vi.fn(),
  probeItem: vi.fn(),
  getProgress: vi.fn(),
  getServerMap: vi.fn(async () => ({})),
  getSettings: vi.fn(async () => null),
  onPlayerStateChange: vi.fn(() => () => undefined),
};

vi.stubGlobal('electronAPI', electronAPI);

// Detail page pulls the server map through utils/server-images.
vi.mock('../../../src/renderer/utils/server-images', () => ({
  getServerMap: vi.fn(async () => new Map()),
}));

const REQUEST = {
  ref: { provider: 'jellyfin', serverId: 1, itemId: 'item-1' },
  mode: 'direct' as const,
  fingerprint: 'f1',
};

beforeEach(() => {
  vi.clearAllMocks();
  electronAPI.probeItem.mockResolvedValue({ ok: true, data: OK_OUTCOME });
  electronAPI.getProgress.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// MediaInfoPanel
// ---------------------------------------------------------------------------

function renderPanel(phase: ProbePhase = 'idle', outcome: MediaProbeOutcome | null = OK_OUTCOME) {
  const onProbe = vi.fn();
  const view = render(
    <MediaInfoPanel request={REQUEST} onProbe={onProbe} outcome={outcome} phase={phase} />
  );
  return { onProbe, ...view };
}

describe('MediaInfoPanel', () => {
  it('probes once on mount', async () => {
    const { onProbe } = renderPanel();
    await waitFor(() => expect(onProbe).toHaveBeenCalledTimes(1));
  });

  it('shows a busy state while probing (aria-busy)', async () => {
    renderPanel('probing', null);
    fireEvent.click(screen.getByRole('button', { name: /技术信息/ }));
    const region = screen.getByRole('region', { name: '技术信息' });
    expect(region.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(screen.getByText('正在读取技术信息…')).toBeTruthy();
  });

  it('renders container/video/audio and wraps the track list after a successful probe', async () => {
    renderPanel('ok');
    fireEvent.click(screen.getByRole('button', { name: /技术信息/ }));
    await waitFor(() => expect(screen.getByText('Matroska')).toBeTruthy());
    expect(screen.getByText(/23\.98 fps/)).toBeTruthy();
    expect(screen.getByText(/AAC · 6 声道/)).toBeTruthy();
    // Multi-track chips wrap (flex), never a horizontal scroll container.
    expect(screen.getByText(/音频 eng/)).toBeTruthy();
    expect(screen.getByText(/字幕 chi · 中文/)).toBeTruthy();
  });

  it('renders distinct unsupported wording', async () => {
    renderPanel('unsupported', {
      status: 'unsupported',
      fingerprint: 'f1',
      probedAt: 1,
      fromCache: false,
      info: { version: '0.32.0', tracks: [], unsupported: ['duration'] },
    });
    fireEvent.click(screen.getByRole('button', { name: /技术信息/ }));
    expect(await screen.findByText('该文件不含可读取的技术信息')).toBeTruthy();
  });

  it.each([
    ['timeout', '读取超时：媒体响应过慢，可稍后重试'],
    ['no-mpv', '未找到可用的 mpv，无法读取技术信息'],
    ['offline', '来源暂不可达或连接中断'],
  ] as const)('renders distinct failure state for %s with retry', async (phase, text) => {
    const { onProbe } = renderPanel(phase, null);
    fireEvent.click(screen.getByRole('button', { name: /技术信息/ }));
    expect(await screen.findByText(text)).toBeTruthy();
    const retry = screen.getByRole('button', { name: '重试' });
    fireEvent.click(retry);
    expect(onProbe).toHaveBeenCalledTimes(2);
  });

  it('renders nothing without a request', () => {
    const { container } = render(
      <MediaInfoPanel request={null} onProbe={() => undefined} outcome={null} phase="idle" />
    );
    expect(container.querySelector('section')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ProgressSummary
// ---------------------------------------------------------------------------

describe('ProgressSummary', () => {
  it('shows the last position with an auto-resume note for partial progress', async () => {
    electronAPI.getProgress.mockResolvedValue({ position: 1200, duration: 3600, is_finished: 0 });
    render(<ProgressSummary mediaType="jellyfin" mediaId="item-1" />);
    const status = await screen.findByRole('status');
    await waitFor(() => expect(status.textContent).toContain('上次看到 20分'));
    expect(status.textContent).toContain('自动续播');
  });

  it('shows finished wording without a misleading resume hint', async () => {
    electronAPI.getProgress.mockResolvedValue({ position: 3500, duration: 3600, is_finished: 1 });
    render(<ProgressSummary mediaType="jellyfin" mediaId="item-1" />);
    const status = await screen.findByRole('status');
    await waitFor(() => expect(status.textContent).toContain('已看过（上次看完）'));
    expect(status.textContent).not.toContain('自动续播');
    expect(status.textContent).not.toContain('上次看到');
  });

  it('renders nothing when there is no meaningful progress', async () => {
    electronAPI.getProgress.mockResolvedValue({ position: 3, duration: 3600, is_finished: 0 });
    const { container } = render(<ProgressSummary mediaType="jellyfin" mediaId="item-1" />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.textContent).toBe('');
  });

  it('applies the >90% resume rule to legacy unfinished rows', async () => {
    // is_finished=0 but 95% watched: playback restarts, so the display
    // must not claim an auto-resume.
    electronAPI.getProgress.mockResolvedValue({ position: 3420, duration: 3600, is_finished: 0 });
    render(<ProgressSummary mediaType="jellyfin" mediaId="item-1" />);
    const status = await screen.findByRole('status');
    await waitFor(() => expect(status.textContent).toContain('已看过（上次看完）'));
    expect(status.textContent).not.toContain('自动续播');
  });

  it('stays silent when the progress read fails', async () => {
    electronAPI.getProgress.mockRejectedValue(new Error('db locked'));
    const { container } = render(<ProgressSummary mediaType="jellyfin" mediaId="item-1" />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.textContent).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Detail page wiring
// ---------------------------------------------------------------------------

function renderDetail(itemId = 'item-1') {
  return render(
    <MemoryRouter initialEntries={[`/detail/jellyfin/1/${itemId}`]}>
      <Routes>
        <Route path="/detail/:type/:serverId/:id" element={<Detail />} />
      </Routes>
    </MemoryRouter>
  );
}

/** Same-router navigation harness: A→B→A keeps the Detail instance alive. */
function NavHarness() {
  const navigate = useNavigate();
  return (
    <>
      <Routes>
        <Route path="/detail/:type/:serverId/:id" element={<Detail />} />
      </Routes>
      <button onClick={() => navigate('/detail/jellyfin/1/item-2')}>nav-b</button>
      <button onClick={() => navigate('/detail/jellyfin/1/item-1')}>nav-a</button>
    </>
  );
}

function renderDetailWithNav() {
  return render(
    <MemoryRouter initialEntries={['/detail/jellyfin/1/item-1']}>
      <NavHarness />
    </MemoryRouter>
  );
}

const MOVIE_DETAILS = {
  Id: 'item-1',
  Name: '测试电影',
  Type: 'Movie',
  ProductionYear: 2024,
  RunTimeTicks: 36_000_000_000,
  MediaSources: [{ Id: 'ms-1', Size: 4_000_000_000 }],
  Overview: '简介',
};

describe('Detail page: technical info + progress wiring', () => {
  it('probes technical info and shows progress for a Movie', async () => {
    electronAPI.getItemDetails.mockResolvedValue(MOVIE_DETAILS);
    electronAPI.probeItem.mockResolvedValue({ ok: true, data: OK_OUTCOME });
    electronAPI.getProgress.mockResolvedValue({ position: 600, duration: 3600, is_finished: 0 });
    renderDetail();
    // Probe issued with the item's ref and content fingerprint.
    await waitFor(() => expect(electronAPI.probeItem).toHaveBeenCalled());
    const input = electronAPI.probeItem.mock.calls[0][0];
    expect(input.ref).toMatchObject({ provider: 'jellyfin', serverId: 1, itemId: 'item-1' });
    expect(input.fingerprint).toBe('36000000000:4000000000');
    // Progress summary visible without expanding anything.
    expect(await screen.findByText(/上次看到/)).toBeTruthy();
    // Technical info collapses behind its toggle.
    fireEvent.click(screen.getByRole('button', { name: /技术信息/ }));
    expect(await screen.findByText('Matroska')).toBeTruthy();
  });

  it('does not render progress or technical info for a Series container', async () => {
    electronAPI.getItemDetails.mockResolvedValue({ Id: 'item-1', Name: '剧集', Type: 'Series' });
    renderDetail();
    // Title + season chips render; confirm the page loaded.
    const heading = await screen.findByRole('heading', { level: 1 });
    await waitFor(() => expect(heading.textContent).toContain('剧集'));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(electronAPI.probeItem).not.toHaveBeenCalled();
    expect(electronAPI.getProgress).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /技术信息/ })).toBeNull();
  });

  it('never paints a previous item probe result on a revisited item (A→B→A)', async () => {
    const detailsA = { ...MOVIE_DETAILS, Id: 'item-1', Name: 'A' };
    const detailsB = { ...MOVIE_DETAILS, Id: 'item-2', Name: 'B' };
    electronAPI.getItemDetails.mockImplementation(async (id: string) =>
      id === 'item-1' ? detailsA : detailsB
    );
    // Deterministic probes: each call stays pending until the test settles it.
    const releases: Array<(v: { ok: boolean; data: MediaProbeOutcome }) => void> = [];
    electronAPI.probeItem.mockImplementation(
      () =>
        new Promise((resolve) => {
          releases.push(resolve);
        })
    );
    const settle = (n: number, container: string): void => {
      releases[n]({
        ok: true,
        data: { ...OK_OUTCOME, info: { ...OK_OUTCOME.info!, container } },
      });
    };

    renderDetailWithNav();
    await waitFor(() => expect(electronAPI.probeItem).toHaveBeenCalledTimes(1));
    settle(0, 'container-1');
    fireEvent.click(screen.getByRole('button', { name: /技术信息/ }));
    await waitFor(() => expect(document.body.textContent).toContain('container-1'));

    // Navigate to B: A's panel result must not leak; B probes afresh.
    fireEvent.click(screen.getByRole('button', { name: 'nav-b' }));
    await waitFor(() => expect(electronAPI.probeItem).toHaveBeenCalledTimes(2));
    expect(document.body.textContent).not.toContain('container-1');
    settle(1, 'container-2');
    await waitFor(() => expect(document.body.textContent).toContain('container-2'));

    // Back to A: re-probe; B's result never reappears.
    fireEvent.click(screen.getByRole('button', { name: 'nav-a' }));
    await waitFor(() => expect(electronAPI.probeItem).toHaveBeenCalledTimes(3));
    expect(document.body.textContent).not.toContain('container-2');
    settle(2, 'container-3');
    await waitFor(() => expect(document.body.textContent).toContain('container-3'));
    expect(document.body.textContent).not.toContain('container-2');
  });

  it('maps an AUTH_REQUIRED probe failure to a distinct wording', async () => {
    electronAPI.getItemDetails.mockResolvedValue(MOVIE_DETAILS);
    electronAPI.probeItem.mockResolvedValue({
      ok: false,
      error: { code: 'AUTH_REQUIRED', message: '登录已过期' },
    });
    renderDetail();
    await waitFor(() => expect(electronAPI.probeItem).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /技术信息/ }));
    expect(await screen.findByText('登录已过期，请重新登录后再试')).toBeTruthy();
  });

  it('maps an ok:false probe response to the offline state without blocking playback', async () => {
    electronAPI.getItemDetails.mockResolvedValue(MOVIE_DETAILS);
    electronAPI.probeItem.mockResolvedValue({ ok: false, error: { message: 'UNAVAILABLE' } });
    renderDetail();
    await waitFor(() => expect(electronAPI.probeItem).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /技术信息/ }));
    expect(await screen.findByText('来源暂不可达或连接中断')).toBeTruthy();
    // Play buttons stay intact.
    expect(screen.getByRole('button', { name: /立即播放/ })).toBeTruthy();
  });
});
