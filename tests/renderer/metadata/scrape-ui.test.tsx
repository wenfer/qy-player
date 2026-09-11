// @vitest-environment jsdom
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ScrapeDialog from '../../../src/renderer/pages/Detail/ScrapeDialog';
import ScrapeJobs from '../../../src/renderer/pages/Libraries/ScrapeJobs';

const { addToast } = vi.hoisted(() => ({ addToast: vi.fn() }));
vi.mock('../../../src/renderer/stores/toast-store', () => ({
  useToastStore: (selector: (s: { addToast: unknown }) => unknown) => selector({ addToast }),
}));

const scrapeStart = vi.fn();
const scrapeJobs = vi.fn();
const scrapeStatus = vi.fn();
const scrapeCancel = vi.fn();
const scrapeApply = vi.fn();
const listPlugins = vi.fn();

vi.stubGlobal('electronAPI', {
  scrapeStart,
  scrapeJobs,
  scrapeStatus,
  scrapeCancel,
  scrapeApply,
  listPlugins,
  navigate: undefined, // ScrapeJobs uses react-router only for refresh link
});

// ScrapeJobs calls useNavigate; stub the router bits it needs.
vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
}));

function jobRecord(over: Record<string, unknown> = {}) {
  return {
    id: 'job-1',
    status: 'running',
    createdAt: 1,
    updatedAt: 2,
    items: [],
    pending: [5],
    pluginId: 'tmdb',
    ...over,
  };
}

const PLUGINS = [
  { id: 'tmdb', name: 'TMDB', capability: 'metadata-provider', enabled: true },
  { id: 'douban', name: '豆瓣（实验性）', capability: 'metadata-provider', enabled: false },
];

beforeEach(() => {
  vi.clearAllMocks();
  listPlugins.mockResolvedValue({ ok: true, data: PLUGINS });
});

describe('ScrapeDialog (QYP2-032 单项刮削)', () => {
  it('auto-applied path: polls until applied and shows the field count', async () => {
    scrapeStart.mockResolvedValue({ ok: true, data: { jobId: 'job-1' } });
    scrapeStatus
      .mockResolvedValueOnce({ ok: true, data: jobRecord() })
      .mockResolvedValue({
        ok: true,
        data: jobRecord({
          status: 'completed',
          items: [{ itemId: 5, status: 'applied', message: '已应用 6 个字段' }],
          pending: [],
        }),
      });
    render(<ScrapeDialog itemId={5} open onClose={() => undefined} />);
    expect(await screen.findByText('刮削元数据')).toBeTruthy();
    await waitFor(() => expect(scrapeStart).toHaveBeenCalledWith('tmdb', [5]));
    await waitFor(
      () => expect(screen.getByText('已应用 6 个字段')).toBeTruthy(),
      { timeout: 3000 }
    );
  });

  it('confirm queue: 0.75–0.92 candidates require a manual pick; apply goes through scrapeApply', async () => {
    scrapeStart.mockResolvedValue({ ok: true, data: { jobId: 'job-1' } });
    scrapeStatus.mockResolvedValue({
      ok: true,
      data: jobRecord({
        status: 'completed',
        items: [
          {
            itemId: 5,
            status: 'confirm',
            candidates: [
              { id: '111', title: '流浪地球', score: 0.86 },
              { id: '222', title: '流浪地球2', score: 0.78 },
            ],
          },
        ],
        pending: [],
      }),
    });
    scrapeApply.mockResolvedValue({
      ok: true,
      data: { itemId: 5, status: 'applied', message: '已应用 8 个字段' },
    });
    render(<ScrapeDialog itemId={5} open onClose={() => undefined} />);
    await waitFor(() => expect(screen.getByText('流浪地球')).toBeTruthy(), { timeout: 3000 });
    // 匹配度百分比展示；低置信候选不会出现在这里（main 侧门槛）
    expect(screen.getByText('匹配度 86%')).toBeTruthy();
    expect(screen.getByText('匹配度 78%')).toBeTruthy();
    fireEvent.click(screen.getByText('流浪地球'));
    await waitFor(() => expect(scrapeApply).toHaveBeenCalledWith('tmdb', 5, '111'));
    await waitFor(() => expect(screen.getByText('已应用 8 个字段')).toBeTruthy());
  });

  it('rejected path shows guidance and offers retry', async () => {
    scrapeStart.mockResolvedValue({ ok: true, data: { jobId: 'job-1' } });
    scrapeStatus.mockResolvedValue({
      ok: true,
      data: jobRecord({
        status: 'completed',
        items: [{ itemId: 5, status: 'rejected', message: '置信度不足，保留现有元数据' }],
        pending: [],
      }),
    });
    render(<ScrapeDialog itemId={5} open onClose={() => undefined} />);
    await waitFor(() => expect(screen.getByText('置信度不足，保留现有元数据')).toBeTruthy(), { timeout: 3000 });
    expect(screen.getByText('重试')).toBeTruthy();
    // retry starts a NEW job
    fireEvent.click(screen.getByText('重试'));
    await waitFor(() => expect(scrapeStart).toHaveBeenCalledTimes(2));
  });

  it('failed path (rate limited) surfaces the message with retry', async () => {
    scrapeStart.mockResolvedValue({ ok: true, data: { jobId: 'job-1' } });
    scrapeStatus.mockResolvedValue({
      ok: true,
      data: jobRecord({
        status: 'completed',
        items: [{ itemId: 5, status: 'failed', errorCode: 'RATE_LIMITED', message: '上游限流（429），可稍后重试' }],
        pending: [],
      }),
    });
    render(<ScrapeDialog itemId={5} open onClose={() => undefined} />);
    await waitFor(() => expect(screen.getByText('上游限流（429），可稍后重试')).toBeTruthy(), { timeout: 3000 });
    expect(screen.getByText('重试')).toBeTruthy();
  });

  it('start failure surfaces the validation message as a failed state', async () => {
    scrapeStart.mockResolvedValue({ ok: false, error: { message: '插件已停用' } });
    render(<ScrapeDialog itemId={5} open onClose={() => undefined} />);
    await waitFor(() => expect(screen.getByText('插件已停用')).toBeTruthy(), { timeout: 3000 });
  });

  it('only enabled metadata providers are offered; douban stays hidden', async () => {
    scrapeStart.mockResolvedValue({ ok: true, data: { jobId: 'job-1' } });
    scrapeStatus.mockResolvedValue({ ok: true, data: jobRecord({ status: 'completed', items: [{ itemId: 5, status: 'applied' }], pending: [] }) });
    render(<ScrapeDialog itemId={5} open onClose={() => undefined} />);
    await waitFor(() => expect(scrapeStart).toHaveBeenCalled());
    // 单一可用 provider → 不出现数据来源选择；douban 未启用不可选
    expect(screen.queryByText('数据来源')).toBeNull();
    expect(screen.queryByText('豆瓣（实验性）')).toBeNull();
  });
});

describe('ScrapeJobs monitor (QYP2-032 批量)', () => {
  it('shows progress and a running job can be cancelled', async () => {
    scrapeJobs.mockResolvedValue({
      ok: true,
      data: [jobRecord({ status: 'running', items: [{ itemId: 5, status: 'applied' }], pending: [6, 7] })],
    });
    scrapeCancel.mockResolvedValue({ ok: true, data: { cancelled: true } });
    render(<ScrapeJobs />);
    await waitFor(() => expect(screen.getByText(/1\/3 项/)).toBeTruthy());
    expect(screen.getByText('进行中')).toBeTruthy();
    fireEvent.click(screen.getByText('取消'));
    await waitFor(() => expect(scrapeCancel).toHaveBeenCalledWith('job-1'));
    await waitFor(() => expect(addToast).toHaveBeenCalledWith('任务已取消', 'success'));
  });

  it('a paused job (UPSTREAM_CHANGED) shows the reason and can resume remaining items', async () => {
    scrapeJobs.mockResolvedValue({
      ok: true,
      data: [
        jobRecord({
          status: 'failed',
          items: [
            { itemId: 5, status: 'applied' },
            { itemId: 6, status: 'failed', errorCode: 'UPSTREAM_CHANGED', message: '豆瓣页面结构变化' },
          ],
          pending: [7],
        }),
      ],
    });
    scrapeStart.mockResolvedValue({ ok: true, data: { jobId: 'job-1' } });
    render(<ScrapeJobs />);
    await waitFor(() => expect(screen.getByText('上游页面结构变化，任务已自动暂停。待插件适配后可恢复剩余条目。')).toBeTruthy());
    fireEvent.click(screen.getByText('恢复剩余 1 项'));
    await waitFor(() => expect(scrapeStart).toHaveBeenCalledWith('tmdb', [7], 'job-1'));
  });

  it('empty state guides the user instead of showing an empty list', async () => {
    scrapeJobs.mockResolvedValue({ ok: true, data: [] });
    render(<ScrapeJobs />);
    expect(await screen.findByText(/暂无刮削任务/)).toBeTruthy();
  });
});
