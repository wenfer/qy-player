import { describe, expect, it, vi } from 'vitest';

// vi.mock 工厂会被提升，无法引用外部 const；用 vi.hoisted 定义可引用的 mock。
const h = vi.hoisted(() => {
  const spawnMock = vi.fn((_cmd: string, _args: string[], _opts: unknown) => ({
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn(),
    kill: vi.fn(),
  }));
  return { spawnMock };
});

// 在导入被测模块前 mock 掉 spawn 与 fs，避免真实拉起 mpv / 触碰磁盘。
vi.mock('child_process', () => ({ spawn: h.spawnMock }));
// mpv-process 内部会调 getGeneratedConfPath → app.getPath('userData')，node 环境下无 app，mock 掉。
vi.mock('../../../src/main/modules/ui-shell/mpv-bindings', () => ({
  getGeneratedConfPath: () => '/tmp/qy-mock/mpv-input.conf',
}));
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    // 让 MpvProcessManager 的 socket 存在检查通过，从而 start() 立刻 resolve
    existsSync: vi.fn((p: string) => String(p).endsWith('.sock')),
    mkdirSync: vi.fn(),
    rmSync: vi.fn(),
  };
});

import { MpvProcessManager } from '../../../src/main/modules/player-core/mpv-process';

describe('MpvProcessManager (QYP3-032)', () => {
  it('starts mpv without forcing the window (music must not show a black window)', async () => {
    const mgr = new MpvProcessManager();
    const socket = await mgr.start();
    expect(socket).toContain('mpv-');
    const spawnArgs = h.spawnMock.mock.calls[0]?.[1] as string[] | undefined;
    expect(spawnArgs).toBeDefined();
    expect(spawnArgs).toContain('--force-window=no');
    expect(spawnArgs).not.toContain('--force-window=immediate');
  });
});
