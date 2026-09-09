import { app, BrowserWindow, ipcMain, Menu } from 'electron';
import { resolve } from 'path';
import { PlayerCore } from './modules/player-core';
import { registerIpcHandlers, playbackStateManager } from './ipc';
import { closeDatabase } from './modules/storage/db';
import { createTray, destroyTray } from './modules/ui-shell/tray';
import { registerGlobalShortcuts, unregisterGlobalShortcuts } from './modules/ui-shell/shortcuts';

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
  registerIpcHandlers(player);

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

  // Register global shortcuts
  registerGlobalShortcuts(window, player);

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
