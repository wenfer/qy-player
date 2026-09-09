import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../shared/ipc-channels';
import type { MediaContext } from '../shared/types';

// Forward renderer console to main process for debugging
['log', 'warn', 'error', 'info'].forEach((level) => {
  const original = (console as unknown as Record<string, (...args: unknown[]) => void>)[level];
  (console as unknown as Record<string, (...args: unknown[]) => void>)[level] = (...args: unknown[]) => {
    original(...args);
    try {
      ipcRenderer.send('renderer-console', level, args.map((a) => {
        try { return typeof a === 'object' ? JSON.stringify(a) : String(a); }
        catch { return String(a); }
      }).join(' '));
    } catch {
      // ignore
    }
  };
});

const electronAPI = {
  // Player
  playerLoadFile: (
    path: string,
    startPosition?: number,
    httpHeaders?: string,
    mediaContext?: MediaContext
  ) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.PLAYER.LOAD_FILE,
      path,
      startPosition,
      httpHeaders,
      mediaContext
    ),
  playerControl: (action: string, ...args: unknown[]) =>
    ipcRenderer.invoke(IPC_CHANNELS.PLAYER.CONTROL, action, ...args),
  playerGetState: () => ipcRenderer.invoke(IPC_CHANNELS.PLAYER.GET_STATE),
  playerGetTracks: () => ipcRenderer.invoke(IPC_CHANNELS.PLAYER.GET_TRACKS),
  onPlayerStateChange: (callback: (state: unknown) => void) => {
    const handler = (_event: unknown, state: unknown) => callback(state);
    ipcRenderer.on(IPC_CHANNELS.PLAYER.ON_STATE_CHANGE, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.PLAYER.ON_STATE_CHANGE, handler);
  },

  // Library
  openFile: () => ipcRenderer.invoke(IPC_CHANNELS.LIBRARY.OPEN_FILE),
  openFolder: () => ipcRenderer.invoke(IPC_CHANNELS.LIBRARY.OPEN_FOLDER),
  getRecentlyPlayed: (limit?: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.LIBRARY.GET_RECENTLY_PLAYED, limit),
  clearHistory: () => ipcRenderer.invoke(IPC_CHANNELS.LIBRARY.CLEAR_HISTORY),
  deleteHistoryItem: (mediaType: string, mediaId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.LIBRARY.DELETE_HISTORY, mediaType, mediaId),

  // Online
  getLibraries: () => ipcRenderer.invoke(IPC_CHANNELS.ONLINE.GET_LIBRARIES),
  getItems: (parentId: string, options?: unknown) =>
    ipcRenderer.invoke(IPC_CHANNELS.ONLINE.GET_ITEMS, parentId, options),
  getItemDetails: (itemId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.ONLINE.GET_ITEM_DETAILS, itemId),
  getStreamUrl: (itemId: string, mediaSourceId: string, mode?: 'direct' | 'transcode') =>
    ipcRenderer.invoke(IPC_CHANNELS.ONLINE.GET_STREAM_URL, itemId, mediaSourceId, mode),
  getContinueWatching: () => ipcRenderer.invoke(IPC_CHANNELS.ONLINE.GET_CONTINUE_WATCHING),
  searchOnline: (query: string, type?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.ONLINE.SEARCH, query, type),

  // Progress
  saveProgress: (progress: unknown) => ipcRenderer.invoke(IPC_CHANNELS.PROGRESS.SAVE, progress),
  getProgress: (mediaType: string, mediaId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.PROGRESS.GET, mediaType, mediaId),
  getContinue: () => ipcRenderer.invoke(IPC_CHANNELS.PROGRESS.GET_CONTINUE),

  // Settings
  getSettings: (key: string) => ipcRenderer.invoke(IPC_CHANNELS.SETTINGS.GET, key),
  setSettings: (key: string, value: unknown) =>
    ipcRenderer.invoke(IPC_CHANNELS.SETTINGS.SET, key, value),
  getServers: () => ipcRenderer.invoke(IPC_CHANNELS.SETTINGS.GET_SERVERS),
  saveServer: (server: unknown) => ipcRenderer.invoke(IPC_CHANNELS.SETTINGS.SAVE_SERVER, server),
  testServer: (server: unknown) => ipcRenderer.invoke(IPC_CHANNELS.SETTINGS.TEST_SERVER, server),

  // Window
  enterPlayerMode: () => ipcRenderer.invoke(IPC_CHANNELS.WINDOW.ENTER_PLAYER_MODE),
  exitPlayerMode: () => ipcRenderer.invoke(IPC_CHANNELS.WINDOW.EXIT_PLAYER_MODE),
  setFullscreen: (fullscreen: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.WINDOW.SET_FULLSCREEN, fullscreen),

  // Shortcuts
  applyShortcuts: (overrides: Record<string, string>) =>
    ipcRenderer.invoke(IPC_CHANNELS.SHORTCUTS.APPLY, overrides),
  applyMpvShortcuts: (overrides: Record<string, string>) =>
    ipcRenderer.invoke(IPC_CHANNELS.SHORTCUTS.APPLY_MPV, overrides),
};

contextBridge.exposeInMainWorld('electronAPI', electronAPI);

// Also expose a ready signal
contextBridge.exposeInMainWorld('__QY_READY__', true);

export type ElectronAPI = typeof electronAPI;
