import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../shared/ipc-channels';
import type { MediaContext } from '../shared/types';

// Subscribers for the catalog scan progress push channel (see onScanProgress).
const scanProgressCallbacks = new Set<(event: unknown) => void>();
let scanProgressHandler: ((_event: unknown, payload: unknown) => void) | null = null;

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
    mediaContext?: MediaContext,
    streamSessionId?: string
  ) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.PLAYER.LOAD_FILE,
      path,
      startPosition,
      httpHeaders,
      mediaContext,
      streamSessionId
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

  // Catalog sources (QYP2-008)
  pickDirectory: () => ipcRenderer.invoke(IPC_CHANNELS.CATALOG.PICK_DIR),
  listSources: () => ipcRenderer.invoke(IPC_CHANNELS.CATALOG.SOURCE_LIST),
  testSource: (input: unknown) => ipcRenderer.invoke(IPC_CHANNELS.CATALOG.SOURCE_TEST, input),
  saveSource: (input: unknown) => ipcRenderer.invoke(IPC_CHANNELS.CATALOG.SOURCE_SAVE, input),
  removeSource: (sourceId: number) => ipcRenderer.invoke(IPC_CHANNELS.CATALOG.SOURCE_REMOVE, sourceId),
  sourceHealth: (sourceId: number) => ipcRenderer.invoke(IPC_CHANNELS.CATALOG.SOURCE_HEALTH, sourceId),
  startScan: (sourceId: number) => ipcRenderer.invoke(IPC_CHANNELS.CATALOG.SCAN_START, sourceId),
  cancelScan: (sourceId: number) => ipcRenderer.invoke(IPC_CHANNELS.CATALOG.SCAN_CANCEL, sourceId),
  // Catalog browse / search / detail / playback resolution (QYP2-011)
  browseCatalog: (query: unknown) => ipcRenderer.invoke(IPC_CHANNELS.CATALOG.LIST, query),
  searchCatalog: (query: unknown) => ipcRenderer.invoke(IPC_CHANNELS.CATALOG.SEARCH, query),
  getCatalogItem: (sourceId: number, itemId: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.CATALOG.GET, sourceId, itemId),
  resolveCatalogMedia: (sourceId: number, itemId: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.CATALOG.RESOLVE, sourceId, itemId),
  onScanProgress: (callback: (event: unknown) => void) => {
    // Single dispatcher: multiple renderer subscribers share one IPC listener.
    const callbacks = scanProgressCallbacks;
    callbacks.add(callback);
    if (callbacks.size === 1) {
      // Tell the main process to register this sender for pushes; the main
      // side dedupes per sender, so repeat subscribes stay single-shot.
      ipcRenderer.send(IPC_CHANNELS.CATALOG.SCAN_EVENTS);
      scanProgressHandler = (_event: unknown, payload: unknown) => {
        for (const cb of [...callbacks]) {
          try {
            cb(payload);
          } catch (err) {
            console.error('[SCAN-EVENTS] 订阅者异常:', err);
          }
        }
      };
      ipcRenderer.on(IPC_CHANNELS.CATALOG.SCAN_EVENTS, scanProgressHandler);
    }
    return () => {
      callbacks.delete(callback);
      if (callbacks.size === 0 && scanProgressHandler) {
        ipcRenderer.removeListener(IPC_CHANNELS.CATALOG.SCAN_EVENTS, scanProgressHandler);
        scanProgressHandler = null;
      }
    };
  },
  getRecentlyPlayed: (limit?: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.LIBRARY.GET_RECENTLY_PLAYED, limit),
  clearHistory: () => ipcRenderer.invoke(IPC_CHANNELS.LIBRARY.CLEAR_HISTORY),
  deleteHistoryItem: (mediaType: string, mediaId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.LIBRARY.DELETE_HISTORY, mediaType, mediaId),

  // Online
  getLibraries: () => ipcRenderer.invoke(IPC_CHANNELS.ONLINE.GET_LIBRARIES),
  getItems: (parentId: string, options?: unknown, serverId?: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.ONLINE.GET_ITEMS, parentId, options, serverId),
  getItemDetails: (itemId: string, serverId?: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.ONLINE.GET_ITEM_DETAILS, itemId, serverId),
  // Subtitles (QYP2-020)
  pickSubtitleFile: () => ipcRenderer.invoke(IPC_CHANNELS.SUBTITLES.PICK_FILE),
  importSubtitle: (input: unknown) => ipcRenderer.invoke(IPC_CHANNELS.SUBTITLES.IMPORT, input),
  listSubtitles: (itemId: number) => ipcRenderer.invoke(IPC_CHANNELS.SUBTITLES.LIST, itemId),
  removeSubtitle: (itemId: number, rowId: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.SUBTITLES.REMOVE, itemId, rowId),
  setDefaultSubtitle: (itemId: number, rowId: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.SUBTITLES.SET_DEFAULT, itemId, rowId),
  // Metadata editor (QYP2-023)
  getMetadataFields: (itemId: number) => ipcRenderer.invoke(IPC_CHANNELS.METADATA.GET, itemId),
  saveMetadataEdits: (itemId: number, patches: unknown) =>
    ipcRenderer.invoke(IPC_CHANNELS.METADATA.SAVE, itemId, patches),
  restoreMetadataFields: (itemId: number, fields?: string[]) =>
    ipcRenderer.invoke(IPC_CHANNELS.METADATA.RESTORE, itemId, fields),
  pickImageFile: () => ipcRenderer.invoke(IPC_CHANNELS.METADATA.PICK_IMAGE),
  importImages: (itemId: number, inputs: unknown) =>
    ipcRenderer.invoke(IPC_CHANNELS.METADATA.IMPORT_IMAGES, itemId, inputs),
  // Safe delete (QYP2-024): preview/execute two-phase
  // Plugin config (QYP2-027)
  listPlugins: () => ipcRenderer.invoke(IPC_CHANNELS.PLUGINS.LIST),
  setPluginConfig: (pluginId: string, patch: unknown) =>
    ipcRenderer.invoke(IPC_CHANNELS.PLUGINS.SET_CONFIG, pluginId, patch),
  setPluginSecret: (pluginId: string, key: string, value: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.PLUGINS.SET_SECRET, pluginId, key, value),
  deletePluginSecret: (pluginId: string, key: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.PLUGINS.DELETE_SECRET, pluginId, key),
  testPlugin: (pluginId: string) => ipcRenderer.invoke(IPC_CHANNELS.PLUGINS.TEST, pluginId),
  // Series resume (QYP2-034): pure resolver runs main-side.
  resolveSeriesResume: (episodes: unknown[]) =>
    ipcRenderer.invoke(IPC_CHANNELS.RESUME.SERIES, episodes),
  // Scrape jobs (QYP2-032)
  scrapeStart: (pluginId: string, itemIds: number[], jobId?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SCRAPE.START, pluginId, itemIds, jobId),
  scrapeJobs: () => ipcRenderer.invoke(IPC_CHANNELS.SCRAPE.JOBS),
  scrapeStatus: (jobId: string) => ipcRenderer.invoke(IPC_CHANNELS.SCRAPE.STATUS, jobId),
  scrapeCancel: (jobId: string) => ipcRenderer.invoke(IPC_CHANNELS.SCRAPE.CANCEL, jobId),
  scrapeApply: (pluginId: string, itemId: number, candidateId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SCRAPE.APPLY, pluginId, itemId, candidateId),
  previewMediaDeletion: (ref: { sourceId: number; itemId: number }) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEDIA.DELETE_PREVIEW, ref),
  executeMediaDeletion: (args: { token: string; confirmTitle?: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEDIA.DELETE_EXECUTE, args),
  resolvePlayback: (ref: unknown, options?: unknown) =>
    ipcRenderer.invoke(IPC_CHANNELS.PLAYER.RESOLVE, ref, options),
  probeItem: (input: unknown) => ipcRenderer.invoke(IPC_CHANNELS.PLAYER.PROBE_ITEM, input),
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
  isSecretsPersistent: () => ipcRenderer.invoke(IPC_CHANNELS.SETTINGS.SECRETS_PERSISTENT),
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
