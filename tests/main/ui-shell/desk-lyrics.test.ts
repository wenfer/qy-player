import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 桌面歌词窗口（ADR-0008 / QYP3-022）行为契约：
 * - 窗口形态：透明/无框/置顶/不进任务栏/不可缩放；
 * - 锁定 = 鼠标穿透（forward），解锁才可拖动；
 * - 无词/暂停 → 隐藏；有词播放 → 显示并推送状态；
 * - Wayland 会话明确不支持（功能入口隐藏）。
 */

interface FakeWindow {
  opts: Record<string, unknown>;
  webContents: { send: ReturnType<typeof vi.fn> };
  setIgnoreMouseEvents: ReturnType<typeof vi.fn>;
  loadURL: ReturnType<typeof vi.fn>;
  loadFile: ReturnType<typeof vi.fn>;
  isVisible: ReturnType<typeof vi.fn>;
  showInactive: ReturnType<typeof vi.fn>;
  hide: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  getPosition: () => [number, number];
  destroyed: boolean;
}

const windows: FakeWindow[] = [];

vi.mock('electron', () => ({
  BrowserWindow: class {
    opts: Record<string, unknown>;
    webContents = { send: vi.fn() };
    setIgnoreMouseEvents = vi.fn();
    loadURL = vi.fn();
    loadFile = vi.fn();
    isVisible = vi.fn(() => this.visible);
    showInactive = vi.fn(() => {
      this.visible = true;
    });
    hide = vi.fn(() => {
      this.visible = false;
    });
    close = vi.fn(() => {
      this.destroyed = true;
    });
    visible = false;
    destroyed = false;
    isDestroyed = () => this.destroyed;
    getPosition = () => [10, 20];
    handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
    on(event: string, cb: (...args: unknown[]) => void) {
      this.handlers[event] = this.handlers[event] ?? [];
      this.handlers[event].push(cb);
    }
    constructor(opts: Record<string, unknown>) {
      this.opts = opts;
      windows.push(this as unknown as FakeWindow);
    }
  },
  screen: {
    getPrimaryDisplay: () => ({
      workArea: { x: 0, y: 0 },
      workAreaSize: { width: 1920, height: 1080 },
    }),
  },
}));

import {
  closeDeskLyrics,
  isDesktopLyricsSupported,
  isDeskLyricsOpen,
  openDeskLyrics,
  pushDeskLyricsState,
  setDeskLyricsPersistence,
  setDeskLyricsStyle,
} from '../../../src/main/modules/ui-shell/desk-lyrics';

const STYLE = { fontSize: 28, locked: true };
const STATE = { title: '晴天', content: '[00:01.00]第一行', position: 3, isPlaying: true };

beforeEach(() => {
  windows.length = 0;
});

afterEach(() => {
  closeDeskLyrics();
  delete process.env.XDG_SESSION_TYPE;
  delete process.env.WAYLAND_DISPLAY;
});

describe('desk lyrics window (QYP3-022)', () => {
  it('creates a transparent always-on-top frameless window', () => {
    expect(openDeskLyrics({ style: STYLE })).toBe(true);
    const win = windows[0];
    expect(win.opts).toMatchObject({
      transparent: true,
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
    });
    expect(isDeskLyricsOpen()).toBe(true);
  });

  it('locked → mouse pass-through; unlocked → interactive (draggable)', () => {
    openDeskLyrics({ style: { fontSize: 28, locked: true } });
    const win = windows[0];
    // forward 仅 Windows 生效（QYP3-063）；Linux/Win 行为不变，此处按本机平台断言
    const expectedOpts = process.platform === 'win32' ? { forward: true } : {};
    expect(win.setIgnoreMouseEvents).toHaveBeenCalledWith(true, expectedOpts);
    setDeskLyricsStyle({ fontSize: 28, locked: false });
    expect(win.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false, expectedOpts);
    expect(win.webContents.send).toHaveBeenCalledWith('desklyrics:event', {
      type: 'style',
      style: { fontSize: 28, locked: false },
    });
  });

  it('shows only while playing with lyrics; hides when idle', () => {
    openDeskLyrics({ style: STYLE });
    const win = windows[0];
    pushDeskLyricsState(STATE);
    expect(win.showInactive).toHaveBeenCalled();
    expect(win.webContents.send).toHaveBeenCalledWith('desklyrics:event', { type: 'state', state: STATE });

    // 无词 → 隐藏且不推送
    pushDeskLyricsState({ ...STATE, content: null });
    expect(win.hide).toHaveBeenCalledTimes(1);
    // 暂停 → 仍隐藏（已隐藏则不重复 hide，避免多余合成开销）
    pushDeskLyricsState({ ...STATE, isPlaying: false });
    expect(win.hide).toHaveBeenCalledTimes(1);
    expect(win.webContents.send).toHaveBeenCalledTimes(1);
  });

  it('persists position through the move callback', () => {
    const moves: Array<{ x: number; y: number }> = [];
    setDeskLyricsPersistence({ onMove: (p) => moves.push(p) });
    openDeskLyrics({ style: STYLE });
    const win = windows[0] as unknown as FakeWindow & {
      handlers: Record<string, Array<(...args: unknown[]) => void>>;
    };
    for (const cb of win.handlers['moved'] ?? []) cb();
    expect(moves).toEqual([{ x: 10, y: 20 }]);
    setDeskLyricsPersistence(null);
  });

  it('reuses the single window on repeated open', () => {
    openDeskLyrics({ style: STYLE });
    openDeskLyrics({ style: STYLE });
    expect(windows).toHaveLength(1);
  });

  it('is unsupported on Wayland sessions', () => {
    process.env.XDG_SESSION_TYPE = 'wayland';
    expect(isDesktopLyricsSupported()).toBe(false);
    delete process.env.XDG_SESSION_TYPE;
    expect(isDesktopLyricsSupported()).toBe(true);
  });
});
