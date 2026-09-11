import { app, BrowserWindow, ipcMain, Menu } from 'electron';
import { resolve } from 'path';
import { PlayerCore } from './modules/player-core';
import { registerIpcHandlers, playbackStateManager } from './ipc';
import { closeDatabase, getDatabase, createStorage } from './modules/storage/db';
import { createTray, destroyTray } from './modules/ui-shell/tray';
import { registerGlobalShortcuts, unregisterGlobalShortcuts, type ShortcutOverrides } from './modules/ui-shell/shortcuts';
import { findMpvBindingConflicts, writeMpvInputConf, getGeneratedConfPath, type MpvBindingOverrides } from './modules/ui-shell/mpv-bindings';
import { IPC_CHANNELS } from '../shared/ipc-channels';

let mainWindow: BrowserWindow | null = null;
const player = new PlayerCore();

// time-pos fires several times per second; forwarding every tick causes
// the renderer's PlayerControls to re-render needlessly. Throttle to 4Hz.
let lastTimePosSent = 0;

function createWindow(): BrowserWindow {
  // Remove the default menu bar (File/Edit/View...) - cleaner player UI
  Menu.setApplicationMenu(null);

  mainWindow = new BrowserWindow({
    width: 1600,
    height: 900,
    minWidth: 1280,
    minHeight: 800,
    title: 'QY Player',
    darkTheme: true,
    show: false,
    webPreferences: {
      preload: resolve(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // Forward player state changes to renderer
  player.on('time-pos', (time: number) => {
    const now = Date.now();
    if (now - lastTimePosSent < 250) return;
    lastTimePosSent = now;
    mainWindow?.webContents.send('player:on-state-change', { currentTime: time });
  });

  player.on('duration', (duration: number) => {
    mainWindow?.webContents.send('player:on-state-change', { duration });
  });

  player.on('pause', (paused: boolean) => {
    mainWindow?.webContents.send('player:on-state-change', { isPlaying: !paused });
  });

  player.on('volume', (volume: number) => {
    mainWindow?.webContents.send('player:on-state-change', { volume });
  });

  player.on('fullscreen', (fullscreen: boolean) => {
    mainWindow?.webContents.send('player:on-state-change', { isFullscreen: fullscreen });
  });

  // When the MPV window closes (user pressed q), bring the app window back
  player.on('crashed', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  player.on('eof', () => {
    mainWindow?.webContents.send('player:on-state-change', { isPlaying: false, eof: true });
  });

  // Load renderer
  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(resolve(__dirname, '../renderer/index.html'));
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
    mainWindow?.show();
  });

  // Closing the window quits the app. The tray icon is only a shortcut for
  // show/hide while running - on DEs without appindicator support the tray
  // icon is invisible, and hide-on-close would orphan the process with no
  // way back.
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  return mainWindow;
}

app.whenReady().then(() => {
  registerIpcHandlers(player, () => mainWindow);

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
  destroyTray();
  // Final progress save before exit
  if (playbackStateManager) {
    playbackStateManager.destroy();
  }
  await player.quit();
  closeDatabase();
});
