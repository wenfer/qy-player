import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'net';
import { join } from 'path';
import { tmpdir } from 'os';
import { rmSync } from 'fs';
import { MpvIpcClient } from '../../../src/main/modules/player-core/mpv-ipc-client';

/**
 * mpv IPC 连接竞态（QYP3-033 附带修复）：`MpvProcessManager.start` 只轮询
 * socket 文件是否存在，而文件由 bind() 创建、listen() 之后才可连接；窗口
 * 之间 connect 会拿到 ECONNREFUSED（用户实测：
 * `connect ECONNREFUSED /tmp/qy-player/mpv-*.sock`）。连接必须做有界重试。
 */

const servers: Server[] = [];
const paths: string[] = [];

function socketPath(name: string): string {
  const p = join(tmpdir(), `qy-ipc-${process.pid}-${Date.now()}-${name}.sock`);
  paths.push(p);
  return p;
}

function listen(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
}

afterEach(async () => {
  await Promise.all(
    servers.map((s) => new Promise<void>((r) => s.close(() => r())))
  );
  servers.length = 0;
  for (const p of paths) {
    try {
      rmSync(p, { force: true });
    } catch {
      // ignore
    }
  }
  paths.length = 0;
});

describe('MpvIpcClient.connect retry (QYP3-033)', () => {
  it('connects when the socket is already listening', async () => {
    const p = socketPath('ready');
    const server = createServer((sock) => sock.on('data', () => {}));
    servers.push(server);
    await listen(server, p);

    const client = new MpvIpcClient(p);
    await client.connect(5, 20);
    expect(client.isConnected()).toBe(true);
    client.disconnect();
  });

  it('retries until the socket starts listening (bind/listen race)', async () => {
    const p = socketPath('delayed');
    const server = createServer((sock) => sock.on('data', () => {}));
    servers.push(server);
    // 文件尚未创建 → 首批 connect 失败；120ms 后才 listen
    setTimeout(() => {
      void listen(server, p);
    }, 120);

    const client = new MpvIpcClient(p);
    await client.connect(30, 20);
    expect(client.isConnected()).toBe(true);
    client.disconnect();
  });

  it('rejects after the retries are exhausted when nothing is listening', async () => {
    const p = socketPath('never');
    const client = new MpvIpcClient(p);
    await expect(client.connect(2, 10)).rejects.toBeTruthy();
    expect(client.isConnected()).toBe(false);
  });
});
