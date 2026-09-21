import { createConnection } from 'net';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';

/**
 * mpv JSON IPC 端点抽象（QYP3-061）。
 *
 * mpv 的 `--input-ipc-server` 在 Unix 上监听 Unix domain socket（文件系统
 * 路径，可以用 existsSync 探测就绪），在 Windows 上只接受命名管道
 * （`\\.\pipe\<name>`，无文件可探测，就绪判定改为"能连上即就绪"）。
 * MpvIpcClient 的 `net.createConnection(address)` 对两种地址形态通吃，
 * 客户端零改动；本模块只负责地址生成与就绪等待。
 *
 * `dir` 的 mkdirSync 由调用方负责（mpv-process / media-probe 各自建）。
 */

export interface IpcEndpoint {
  /** 传给 --input-ipc-server= 的值，同时是 MpvIpcClient 的连接地址。 */
  readonly address: string;
  /**
   * 等待 mpv 完成监听（可连接）。超时 reject，调用方决定 kill/报错。
   * `failed`：每次轮询时回调，返回非 null 即以该错误立即 reject（调用方
   * 用它抢先报"进程已挂"，而不是干等超时）。settle 后轮询/计时器自停。
   */
  waitUntilReady(timeoutMs: number, failed?: () => Error | null): Promise<void>;
  /** 清理端点残留：unix 删 socket 文件，win32 无文件、no-op。 */
  cleanup(): void;
}

export function createIpcEndpoint(
  dir: string,
  namePrefix: string,
  deps?: { platform?: NodeJS.Platform }
): IpcEndpoint {
  const platform = deps?.platform ?? process.platform;
  /** 每个轮询 tick 都要跑的失败探针：非 null → 立即失败。 */
  const checkFailed = (
    failed: (() => Error | null) | undefined,
    poll: NodeJS.Timeout,
    timer: NodeJS.Timeout,
    reject: (err: Error) => void
  ): boolean => {
    const err = failed?.();
    if (err) {
      clearInterval(poll);
      clearTimeout(timer);
      reject(err);
      return true;
    }
    return false;
  };

  if (platform === 'win32') {
    const address = `\\\\.\\pipe\\${namePrefix}-${process.pid}-${Date.now()}`;
    const waitUntilReady = (timeoutMs: number, failed?: () => Error | null): Promise<void> =>
      new Promise((resolve, reject) => {
        const poll = setInterval(() => {
          if (checkFailed(failed, poll, timer, reject)) return;
          // 能连上就证明管道服务端已监听；立刻销毁让 MpvIpcClient 去做真连接
          const probe = createConnection(address);
          probe.once('connect', () => {
            probe.destroy();
            clearInterval(poll);
            clearTimeout(timer);
            resolve();
          });
          // 服务端未就绪：连接被拒/管道不存在，下一轮再试
          probe.once('error', () => {
            probe.destroy();
          });
        }, 100);
        const timer = setTimeout(() => {
          clearInterval(poll);
          reject(new Error(`IPC 端点 ${address} 等待超时`));
        }, timeoutMs);
      });
    return { address, waitUntilReady, cleanup: () => undefined };
  }

  // unix（linux/darwin）：与历史行为一致——随机文件名 + 预清理 + existsSync 轮询
  const address = join(dir, `${namePrefix}-${process.pid}-${Date.now()}.sock`);
  const waitUntilReady = (timeoutMs: number, failed?: () => Error | null): Promise<void> =>
    new Promise((resolve, reject) => {
      const poll = setInterval(() => {
        if (checkFailed(failed, poll, timer, reject)) return;
        if (existsSync(address)) {
          clearInterval(poll);
          clearTimeout(timer);
          resolve();
        }
      }, 100);
      const timer = setTimeout(() => {
        clearInterval(poll);
        reject(new Error(`IPC 端点 ${address} 等待超时`));
      }, timeoutMs);
    });
  return {
    address,
    waitUntilReady,
    cleanup: () => {
      try {
        rmSync(address, { force: true });
      } catch {
        // 文件可能不存在或已被 mpv 清理
      }
    },
  };
}
