// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createServer } from 'net';
import { mkdtempSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createIpcEndpoint } from '../../../src/main/modules/platform/ipc-endpoint';

/**
 * mpv IPC 端点抽象（QYP3-061）：地址形态按平台分派；
 * unix 就绪判定 = socket 文件出现（真实 listener 验证）；
 * win32 就绪判定 = 命名管道可连接（无文件语义）。
 */

describe('createIpcEndpoint (QYP3-061)', () => {
  it('unix: 地址落在指定目录、cleanup 删除 socket 文件', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qy-endpoint-'));
    const endpoint = createIpcEndpoint(dir, 'qy-player-mpv', { platform: 'linux' });
    expect(endpoint.address.startsWith(join(dir, 'qy-player-mpv-'))).toBe(true);
    expect(endpoint.address.endsWith('.sock')).toBe(true);
    endpoint.cleanup(); // 预清理：文件尚不存在也不报错
    expect(existsSync(endpoint.address)).toBe(false);

    // 就绪判定：真实 listener 出现后 waitUntilReady 才 resolve
    const server = createServer();
    const listening = new Promise<void>((resolve) => server.listen(endpoint.address, resolve));
    await listening;
    const waitPromise = endpoint.waitUntilReady(1000);
    // 端点已就绪，应当立即通过
    await waitPromise;
    server.close();
    endpoint.cleanup();
    expect(existsSync(endpoint.address)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('unix: 超时 reject，且清理函数幂等', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qy-endpoint-'));
    const endpoint = createIpcEndpoint(dir, 'qy-player-mpv', { platform: 'linux' });
    await expect(endpoint.waitUntilReady(150)).rejects.toThrow(/等待超时/);
    endpoint.cleanup();
    endpoint.cleanup();
    rmSync(dir, { recursive: true, force: true });
  });

  it('unix: 失败探针抢先于超时（进程挂了立即报错）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qy-endpoint-'));
    const endpoint = createIpcEndpoint(dir, 'qy-player-mpv', { platform: 'linux' });
    await expect(
      endpoint.waitUntilReady(5000, () => new Error('mpv 提前退出'))
    ).rejects.toThrow('mpv 提前退出');
    endpoint.cleanup();
    rmSync(dir, { recursive: true, force: true });
  });

  it('win32: 地址是命名管道形态、cleanup 为 no-op', async () => {
    const endpoint = createIpcEndpoint(join(tmpdir(), 'qy-player'), 'qy-player-mpv', {
      platform: 'win32',
    });
    expect(endpoint.address.startsWith('\\\\.\\pipe\\qy-player-mpv-')).toBe(true);
    // 无文件系统痕迹
    expect(existsSync(endpoint.address)).toBe(false);
    expect(() => endpoint.cleanup()).not.toThrow();
    // 探针失败路径：failed() 返回错误 → 立即 reject（不依赖连接轮询）
    await expect(
      endpoint.waitUntilReady(500, () => new Error('mpv exited early'))
    ).rejects.toThrow('mpv exited early');
  });
});
