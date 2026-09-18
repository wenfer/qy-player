import { createConnection, Socket } from 'net';
import { EventEmitter } from 'events';

interface MpvCommand {
  request_id: number;
  command: (string | number | boolean | Record<string, unknown>)[];
}

interface MpvResponse {
  request_id?: number;
  data?: unknown;
  error?: string;
  event?: string;
  name?: string;
}

export class MpvIpcClient extends EventEmitter {
  private socket: Socket | null = null;
  private socketPath: string;
  private requestId = 0;
  private pendingRequests = new Map<number, { resolve: (value: unknown) => void; reject: (reason: Error) => void }>();
  private buffer = '';
  private connected = false;

  constructor(socketPath: string) {
    super();
    this.socketPath = socketPath;
  }

  /**
   * 连接 mpv 的 IPC 套接字（带短重试）。
   *
   * socket 文件由 bind() 创建、listen() 之后才可连接；`MpvProcessManager.start`
   * 只轮询文件是否存在，因此 mpv 尚未 listen()（或仍在初始化脚本/配置）时首批
   * connect 会拿到 ECONNREFUSED，直接放弃会让首个 loadfile 报错。这里做有界
   * 重试（默认 ~1.2s），只吞连接建立前的错误。
   */
  async connect(retries = 12, retryDelayMs = 100): Promise<void> {
    let lastErr: Error | undefined;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        await this.connectOnce();
        return;
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, retryDelayMs));
        }
      }
    }
    throw lastErr ?? new Error('MPV IPC connect failed');
  }

  /** 单次连接尝试：失败时销毁套接字并 reject（不派发 disconnect）。 */
  private connectOnce(): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const socket = createConnection(this.socketPath);
      this.socket = socket;

      socket.on('connect', () => {
        if (settled) return;
        settled = true;
        this.connected = true;
        this.emit('connect');
        resolve();
      });

      socket.on('data', (data) => {
        this.handleData(data.toString());
      });

      socket.on('error', (err) => {
        if (!this.connected && !settled) {
          settled = true;
          socket.destroy();
          reject(err);
          return;
        }
        this.emit('error', err);
      });

      socket.on('close', () => {
        const wasConnected = this.connected;
        this.connected = false;
        // 只有真正建立过连接的套接字关闭才算断开；重试期间的失败尝试不派发
        if (settled && wasConnected) this.emit('disconnect');
      });
    });
  }

  async command(...args: (string | number | boolean | Record<string, unknown>)[]): Promise<unknown> {
    if (!this.socket || !this.connected) {
      throw new Error('MPV IPC not connected');
    }

    const requestId = ++this.requestId;
    const cmd: MpvCommand = {
      request_id: requestId,
      command: args,
    };

    return new Promise((resolve, reject) => {
      // A stuck mpv must not leave callers awaiting forever (e.g. loadFile
      // would hang the renderer's play button with no feedback).
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`MPV IPC timeout after 10s: ${String(args[0])}`));
      }, 10000);
      this.pendingRequests.set(requestId, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (reason) => {
          clearTimeout(timer);
          reject(reason);
        },
      });
      this.socket!.write(JSON.stringify(cmd) + '\n');
    });
  }

  async setProperty(name: string, value: string | number | boolean | Record<string, unknown>): Promise<unknown> {
    return this.command('set_property', name, value);
  }

  async getProperty(name: string): Promise<unknown> {
    return this.command('get_property', name);
  }

  observeProperty(name: string): void {
    this.command('observe_property', ++this.requestId, name).catch(() => {
      // observe_property doesn't return useful data
    });
  }

  disconnect(): void {
    if (this.socket) {
      this.socket.end();
      this.socket = null;
    }
    this.connected = false;
    this.pendingRequests.clear();
  }

  isConnected(): boolean {
    return this.connected;
  }

  private handleData(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg: MpvResponse = JSON.parse(line);
        this.handleMessage(msg);
      } catch {
        // Ignore malformed JSON
      }
    }
  }

  private handleMessage(msg: MpvResponse): void {
    if (msg.event) {
      this.emit('event', msg);
      if (msg.event === 'property-change' && msg.name) {
        this.emit(`property-change:${msg.name}`, msg.data);
      }
      return;
    }

    if (msg.request_id !== undefined) {
      const pending = this.pendingRequests.get(msg.request_id);
      if (pending) {
        this.pendingRequests.delete(msg.request_id);
        if (msg.error && msg.error !== 'success') {
          pending.reject(new Error(`MPV error: ${msg.error}`));
        } else {
          pending.resolve(msg.data);
        }
      }
    }
  }
}
