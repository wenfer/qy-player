import { app, BrowserWindow, ipcMain, Menu, protocol, screen } from 'electron';
import { resolve } from 'path';
import { existsSync } from 'fs';
import { PlayerCore } from './modules/player-core';
import { registerIpcHandlers, playbackStateManager, cancelMusicSpectrum } from './ipc';
import { closeDatabase, getDatabase, createStorage } from './modules/storage/db';
import { createTray, destroyTray } from './modules/ui-shell/tray';
import { closeDeskLyrics } from './modules/ui-shell/desk-lyrics';
import { startResourceGuard, stopResourceGuard } from './modules/ui-shell/resource-guard';
import { registerGlobalShortcuts, unregisterGlobalShortcuts, type ShortcutOverrides } from './modules/ui-shell/shortcuts';
import { findMpvBindingConflicts, writeMpvInputConf, getGeneratedConfPath, type MpvBindingOverrides } from './modules/ui-shell/mpv-bindings';
import {
  compactBounds,
  minSizeForProfile,
  musicBounds,
} from './modules/ui-shell/compact-window';
import {
  attachWindowMemory,
  flushWindowMemory,
  readWindowMemory,
  resolveRestoreBounds,
  restoreWindowProfile,
  type WindowMemory,
} from './modules/ui-shell/window-state';
import { isMpvMusicActive } from './modules/playback-engine/music-active';
import { IPC_CHANNELS } from '../shared/ipc-channels';
import { resolveAudioUrlSource } from './modules/playback-engine/audio-url';
import { registerStreamProtocol } from './modules/playback-engine/stream-protocol';
import { createStreamRouteCache } from './modules/security/stream-route-cache';
import { resolveCoverFileName } from './modules/library-scanner/cover-service';

let mainWindow: BrowserWindow | null = null;
const player = new PlayerCore();

// time-pos fires several times per second; forwarding every tick causes
// the renderer's PlayerControls to re-render needlessly. Throttle to 4Hz.
let lastTimePosSent = 0;

function createWindow(): BrowserWindow {
  // Remove the default menu bar (File/Edit/View...) - cleaner player UI
  Menu.setApplicationMenu(null);

  // 窗口与模式记忆（QYP3-051）：上次是影视/音乐/精简浮窗、以及正常几何，都在
  // 启动时原样恢复。记忆损坏或首次启动都会回落到"主屏居中 1600×900"。
  const storage = createStorage(getDatabase());
  const saved = readWindowMemory(storage);
  const workAreas = screen.getAllDisplays().map((d) => d.workArea);
  const normalBounds = resolveRestoreBounds(saved?.bounds ?? null, workAreas);
  const memory: WindowMemory = {
    profile: saved?.profile ?? 'normal',
    music: saved?.music ?? false,
    bounds: normalBounds,
    maximized: saved?.maximized ?? false,
  };
  // 音乐/精简浮窗直接以对应尺寸出现（渲染层稍后按 GET_PROFILE 回填界面）
  const displayArea = screen.getDisplayMatching(normalBounds).workArea;
  const initialBounds =
    memory.profile === 'compact'
      ? compactBounds(displayArea)
      : memory.profile === 'music'
        ? musicBounds(displayArea)
        : normalBounds;
  // 最小尺寸必须按 profile 给：构造时若用 1280×800 的下限，小窗会被顶回去
  const [minWidth, minHeight] = minSizeForProfile(memory.profile);

  mainWindow = new BrowserWindow({
    ...initialBounds,
    minWidth,
    minHeight,
    resizable: memory.profile !== 'compact', // 精简浮窗固定尺寸
    title: 'QY Player',
    darkTheme: true,
    show: false,
    // 无边框（QYP3-042）：标题栏与缩放热区由渲染层自绘，见
    // components/TitleBar；最小化/最大化/关闭走 WINDOW.* IPC
    frame: false,
    webPreferences: {
      preload: resolve(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // 记忆接线必须在套用 profile 之前：套用那一刻就会把模式写回配置
  attachWindowMemory(mainWindow, storage, memory);
  restoreWindowProfile(mainWindow, memory);

  // Forward player state changes to renderer
  //
  // QYP3-026：附带 music 标记（本次 mpv 加载的是音乐）。音乐控制条只
  // 在自己发起的音乐 mpv 会话内消费这些事件——mpv 状态对视频与音乐
  // 是同一份，没有这个标记视频进度会污染迷你条。
  const sendPlayerState = (payload: Record<string, unknown>): void => {
    mainWindow?.webContents.send(IPC_CHANNELS.PLAYER.ON_STATE_CHANGE, {
      music: isMpvMusicActive(),
      ...payload,
    });
  };

  player.on('time-pos', (time: number) => {
    const now = Date.now();
    if (now - lastTimePosSent < 250) return;
    lastTimePosSent = now;
    sendPlayerState({ currentTime: time });
  });

  player.on('duration', (duration: number) => {
    sendPlayerState({ duration });
  });

  player.on('pause', (paused: boolean) => {
    sendPlayerState({ isPlaying: !paused });
  });

  player.on('volume', (volume: number) => {
    sendPlayerState({ volume });
  });

  player.on('fullscreen', (fullscreen: boolean) => {
    sendPlayerState({ isFullscreen: fullscreen });
  });

  // When the MPV window closes (user pressed q), bring the app window back
  player.on('crashed', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  player.on('eof', () => {
    sendPlayerState({ isPlaying: false, eof: true });
  });

  // Load renderer
  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    // out/main.cjs 与 out/renderer/ 同级；此前 '../renderer' 解析到仓库根
    // 的不存在路径（dev 恒有 VITE_DEV_SERVER_URL 所以从未暴露）
    mainWindow.loadFile(resolve(__dirname, 'renderer/index.html'));
  }

  // Auto-open DevTools for debugging (only in dev)
  if (process.env.NODE_ENV === 'development' || process.env.VITE_DEV_SERVER_URL) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  // Capture all console messages from renderer
  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    const levels = ['debug', 'log', 'warn', 'error'];
    const label = levels[level] || 'log';
    const prefix = `[RENDERER:${label.toUpperCase()}]`;
    if (level === 3) {
      console.error(prefix, message, `(${sourceId}:${line})`);
    } else if (level === 2) {
      console.warn(prefix, message, `(${sourceId}:${line})`);
    } else {
      console.log(prefix, message, `(${sourceId}:${line})`);
    }
  });

  mainWindow.once('ready-to-show', () => {
    // 记忆里上次是最大化：先 maximize 再 show（隐藏窗口上个别 WM 可能不生效，
    // 已列入 docs/TARGET-VERIFY.md）
    if (memory.profile === 'normal' && memory.maximized) mainWindow?.maximize();
    mainWindow?.show();
  });

  // 无边框（QYP3-042）：最大化状态由主进程推送，自绘标题栏才能切换
  // 最大化/还原图标（WM 也可能用快捷键/双击标题栏触发最大化）
  const pushMaximizeState = (maximized: boolean): void => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_CHANNELS.WINDOW.ON_MAXIMIZE_CHANGE, maximized);
    }
  };
  mainWindow.on('maximize', () => pushMaximizeState(true));
  mainWindow.on('unmaximize', () => pushMaximizeState(false));

  // Closing the window quits the app. The tray icon is only a shortcut for
  // show/hide while running - on DEs without appindicator support the tray
  // icon is invisible, and hide-on-close would orphan the process with no
  // way back.
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  return mainWindow;
}

// qy-file 协议（QYP3-008）：只服务 covers 目录（内嵌封面提取结果）。
// 先注册特权方案（http 源不能加载 file://；自定义协议必须标准/安全），
// whenReady 后注册处理器，路径严格限定在 coversDir 内（防目录穿越）。
//
// qy-stream（QYP3-037）：服务器/WebDAV 音频的主进程认证代理，只在主进程里
// 解析真实上游 URL 并注入认证头，渲染层仅见不透明 id。`stream: true` 是
// `<audio>`/`<video>` 按 Range 流式消费所必需的（默认按整段缓冲处理）。
// 刻意**不加** corsEnabled：qy-file 已验证「自定义特权 scheme 喂
// createMediaElementSource 能出真频谱」，加 CORS 检查反而可能破坏它。
protocol.registerSchemesAsPrivileged([
  { scheme: 'qy-file', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: 'qy-stream', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

app.whenReady().then(() => {
  // 单实例锁：防止重复启动造成两个同名窗口（GNOME 窗口列表出现
  // 「QY Player<2>」计数、mpv/数据库竞争）。二次启动改为唤起已有窗口。
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    } else {
      createWindow();
    }
  });

  // qy-stream 路由表：注册协议与 IPC 解析器必须共用同一实例（解析时写入、
  // 协议处理器读取），所以在这里建好再分别注入。
  const streamRoutes = createStreamRouteCache();

  registerIpcHandlers(player, () => mainWindow, { streamRoutes });

  // qy-stream://audio/<opaqueId> 代理（QYP3-037）：服务器/WebDAV 音频直链
  // 需要认证，渲染层无法注入请求头；这里由主进程按 Range 转发并注入认证头，
  // 让这些音源也能走渲染层 Web Audio 引擎（真频谱/真波形/均衡器）。
  registerStreamProtocol({ routes: streamRoutes });

  // qy-file:// 协议（QYP3-005/010，Electron 21 registerFileProtocol）：
  //   covers/<name> → coversDir 内的封面文件（白名单正则 + 包含校验）
  //   audio/<sourceId>/<relpath> → 本地媒体来源内的音频（resolveInside
  //   同级包含校验；WebDAV/服务器音频不走 renderer 引擎，见 ADR-0007）
  {
    const coversRoot = resolve(app.getPath('userData'), 'covers');
    const sep = require('node:path').sep;
    protocol.registerFileProtocol('qy-file', (request, callback) => {
      try {
        // 手工解析：standard scheme 会把第二段当 host；路径段可能是
        // 中文/URL 编码，直接对原始 URL 切片最稳。
        const raw = request.url.replace(/^qy-file:\/\//, '');
        const coversMatch = raw.match(/^covers\/([\w.-]+)$/);
        if (coversMatch) {
          // 包含校验即"可服务"判定：扩展名探测出的候选名同样过这道关
          // （前缀带分隔符 → 目录自身、`.`、`..` 一律不予服务）
          const isServed = (fileName: string): boolean => {
            const candidate = resolve(coversRoot, fileName);
            return candidate.startsWith(coversRoot + sep) && existsSync(candidate);
          };
          const name = resolveCoverFileName(coversMatch[1], isServed);
          if (!name) return callback({ error: -3 });
          return callback(resolve(coversRoot, name));
        }
        const audioMatch = raw.match(/^audio\/(\d+)\/(.+)$/);
        if (audioMatch) {
          console.log('[qy-file] audio req', audioMatch[1], decodeURIComponent(audioMatch[2]));
          const target = resolveAudioUrlSource(
            Number(audioMatch[1]),
            decodeURIComponent(audioMatch[2])
          );
          if (!target) {
            console.log('[qy-file] audio rejected');
            return callback({ error: -3 });
          }
          try {
            const st = require('node:fs').statSync(target);
            console.log('[qy-file] serving', target, st.size, 'bytes');
          } catch {
            console.log('[qy-file] serving (stat failed)', target);
          }
          return callback(target);
        }
        callback({ error: -3 });
      } catch (e) {
        console.log('[qy-file] exception:', e instanceof Error ? e.message : e);
        callback({ error: -3 });
      }
    });
  }

  // Forward renderer console to main stdout
  ipcMain.on('renderer-console', (_event, level: string, message: string) => {
    const prefix = `[RENDERER:${level.toUpperCase()}]`;
    if (level === 'error') {
      console.error(prefix, message);
    } else if (level === 'warn') {
      console.warn(prefix, message);
    } else {
      console.log(prefix, message);
    }
  });

  const window = createWindow();

  // Create system tray
  createTray(window);

  // 系统资源压力采样（QYP3-036）：性能保护据此降低频谱刷新，CPU 紧张时把
  // 资源让给音频解码。只在压力档变化时推送，渲染层拿不到也不影响播放。
  startResourceGuard((pressure) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_CHANNELS.RESOURCE.ON_PRESSURE, pressure);
    }
  });

  // Register global shortcuts from the persisted user config (defaults for
  // anything unset), and allow the renderer to re-apply edited bindings.
  let shortcutOverrides: ShortcutOverrides = {};
  let mpvBindingOverrides: MpvBindingOverrides = {};
  try {
    const storage = createStorage(getDatabase());
    const saved = storage.getConfig('shortcuts');
    if (saved) shortcutOverrides = JSON.parse(saved);
    const savedMpv = storage.getConfig('mpv-shortcuts');
    if (savedMpv) mpvBindingOverrides = JSON.parse(savedMpv);
  } catch {
    // Corrupt config -> fall back to defaults
  }
  registerGlobalShortcuts(window, player, shortcutOverrides);
  // Always (re)write the generated mpv input.conf so custom bindings load
  // even on the very first player start after an edit.
  try {
    writeMpvInputConf(mpvBindingOverrides);
  } catch {
    // Filesystem issue -> bundled defaults still apply
  }

  ipcMain.handle(IPC_CHANNELS.SHORTCUTS.APPLY, (_event, overrides: ShortcutOverrides) => {
    unregisterGlobalShortcuts();
    return registerGlobalShortcuts(window, player, overrides || {});
  });

  // MPV bindings: validate, rewrite the generated input.conf and hot-reload
  // it in the running player (falls back to "next launch" when not ready).
  ipcMain.handle(IPC_CHANNELS.SHORTCUTS.APPLY_MPV, async (_event, overrides: MpvBindingOverrides) => {
    const conflicts = findMpvBindingConflicts(overrides || {});
    if (conflicts.length > 0) {
      return { ok: false as const, conflicts };
    }
    writeMpvInputConf(overrides || {});
    let hotReloaded = false;
    if (player.isReady()) {
      try {
        await player.setProperty('input-conf', getGeneratedConfPath());
        hotReloaded = true;
      } catch {
        // Runtime reload unsupported -> applies on next player start
      }
    }
    return { ok: true as const, hotReloaded };
  });

  app.on('activate', () => {
    if (mainWindow === null) {
      createWindow();
    } else {
      mainWindow.show();
    }
  });
});

app.on('window-all-closed', () => {
  // Quit on all platforms: a hidden zombie process confuses users, and
  // Linux tray icons are unreliable (invisible on GNOME without appindicator)
  app.quit();
});

app.on('will-quit', async () => {
  unregisterGlobalShortcuts();
  stopResourceGuard();
  destroyTray();
  closeDeskLyrics(); // 桌面歌词窗口（QYP3-022）：随应用退出
  // 离线频谱（QYP3-050）：同步杀掉正在跑的 ffmpeg 解码（will-quit 不 await，
  // 所以这里必须是同步的 SIGKILL，不能等 Promise）
  cancelMusicSpectrum();
  // 窗口记忆兜底（QYP3-051）：'close' 里已经落过盘，这里再同步补一次
  flushWindowMemory();
  // Final progress save before exit
  if (playbackStateManager) {
    playbackStateManager.destroy();
  }
  await player.quit();
  closeDatabase();
});
