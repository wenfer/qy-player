import { BrowserWindow, screen } from 'electron';
import { resolve } from 'path';
import { isWin } from '../platform';
import { IPC_CHANNELS } from '../../../shared/ipc-channels';

/**
 * 桌面歌词窗口（ADR-0008 / QYP3-022）。
 *
 * 独立 BrowserWindow：透明 + 无框 + 置顶 + 不进任务栏。
 * - 默认鼠标穿透（setIgnoreMouseEvents({forward:true})）：不拦截播放器热键；
 * - 「锁定位置」关闭时才可交互拖动（Electron 穿透窗口无法接收 mousedown，
 *   所以拖动 = 临时关闭穿透）；
 * - 无歌词/暂停时 main 侧直接 hide，减少合成开销；
 * - 位置/字号/锁定由调用方持久化（app_config），本模块只在移动时回调。
 */

export interface DeskLyricsState {
  title: string;
  /** 原始歌词文本（.lrc 或纯文本）；空则隐藏窗口。 */
  content: string | null;
  /** 播放位置（秒）。 */
  position: number;
  isPlaying: boolean;
}

export interface DeskLyricsStyle {
  fontSize: number;
  locked: boolean;
}

let window: BrowserWindow | null = null;
let onMove: ((pos: { x: number; y: number }) => void) | null = null;

export function setDeskLyricsPersistence(
  handlers: {
    onMove?: (pos: { x: number; y: number }) => void;
  } | null
): void {
  onMove = handlers?.onMove ?? null;
}

export function isDeskLyricsOpen(): boolean {
  return Boolean(window && !window.isDestroyed());
}

function applyMouseState(locked: boolean): void {
  if (!window || window.isDestroyed()) return;
  // 锁定 → 穿透（forward：mousemove 仍转发给页面，hover 样式可用）。
  // forward 仅 Windows 支持（QYP3-063）；mac 上退化成纯穿透，无 hover 转发。
  window.setIgnoreMouseEvents(locked, isWin ? { forward: true } : {});
}

export function openDeskLyrics(opts: { x?: number; y?: number; style: DeskLyricsStyle }): boolean {
  if (isDeskLyricsOpen()) {
    applyMouseState(opts.style.locked);
    return true;
  }
  const display = screen.getPrimaryDisplay();
  const width = Math.min(1000, Math.round(display.workAreaSize.width * 0.7));
  const height = 160;
  const x = typeof opts.x === 'number' ? opts.x : Math.round(display.workArea.x + (display.workAreaSize.width - width) / 2);
  const y = typeof opts.y === 'number' ? opts.y : Math.round(display.workArea.y + display.workAreaSize.height - height - 40);

  window = new BrowserWindow({
    width,
    height,
    x,
    y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    focusable: false,
    fullscreenable: false,
    title: '桌面歌词',
    webPreferences: {
      preload: resolve(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  applyMouseState(opts.style.locked);
  window.on('moved', () => {
    if (!window || window.isDestroyed()) return;
    const [nx, ny] = window.getPosition();
    onMove?.({ x: nx, y: ny });
  });
  window.on('closed', () => {
    window = null;
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    void window.loadURL(`${process.env.VITE_DEV_SERVER_URL}#/desk-lyrics`);
  } else {
    void window.loadFile(resolve(__dirname, 'renderer/index.html'), { hash: '/desk-lyrics' });
  }
  return true;
}

export function closeDeskLyrics(): void {
  if (!window || window.isDestroyed()) return;
  window.close();
  window = null;
}

export function setDeskLyricsStyle(style: DeskLyricsStyle): void {
  applyMouseState(style.locked);
  if (!window || window.isDestroyed()) return;
  window.webContents.send(IPC_CHANNELS.DESKLYRICS.EVENT, { type: 'style', style });
}

export function pushDeskLyricsState(state: DeskLyricsState): void {
  if (!window || window.isDestroyed()) return;
  // 无词/暂停/停止 → 隐藏（ADR-0008：空闲时自动隐藏）
  const visible = state.isPlaying && Boolean(state.content && state.content.trim());
  if (!visible) {
    if (window.isVisible()) window.hide();
    return;
  }
  if (!window.isVisible()) window.showInactive();
  window.webContents.send(IPC_CHANNELS.DESKLYRICS.EVENT, { type: 'state', state });
}

/** 合成器/ARGB 不可用时的降级判定（Wayland 或透明不可用）。 */
export function isDesktopLyricsSupported(): boolean {
  if (process.platform !== 'linux' && process.platform !== 'win32' && process.platform !== 'darwin') {
    return false;
  }
  if (process.platform === 'linux') {
    // Electron 21 的 Wayland 支持不完整（ADR-0008 明确不承诺）
    const session = process.env.XDG_SESSION_TYPE ?? '';
    const waylandDisplay = process.env.WAYLAND_DISPLAY ?? '';
    if (session === 'wayland' || waylandDisplay.length > 0) return false;
  }
  return true;
}
