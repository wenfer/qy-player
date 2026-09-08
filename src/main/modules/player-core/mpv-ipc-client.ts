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

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = createConnection(this.socketPath);

      this.socket.on('connect', () => {
        this.connected = true;
        this.emit('connect');
        resolve();
      });

      this.socket.on('data', (data) => {
        this.handleData(data.toString());
      });

      this.socket.on('error', (err) => {
        if (!this.connected) {
          reject(err);
        }
        this.emit('error', err);
      });

      this.socket.on('close', () => {
        this.connected = false;
        this.emit('disconnect');
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
