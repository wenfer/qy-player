import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../shared/ipc-channels';
import type { MediaContext } from '../shared/types';
import type { AudioChainPayload } from '../main/modules/playback-engine/audio-fx';

/** 桌面歌词窗口事件（main → 歌词窗口）。 */
export interface DeskLyricsEvent {
  type: 'state' | 'style';
  state?: { title: string; content: string | null; position: number; isPlaying: boolean };
  style?: { fontSize: number; locked: boolean };
}

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
    streamSessionId?: string,
    audioChain?: AudioChainPayload
  ) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.PLAYER.LOAD_FILE,
      path,
      startPosition,
      httpHeaders,
      mediaContext,
      streamSessionId,
      audioChain
    ),
  playerControl: (action: string, ...args: unknown[]) =>
    ipcRenderer.invoke(IPC_CHANNELS.PLAYER.CONTROL, action, ...args),
  playerGetState: () => ipcRenderer.invoke(IPC_CHANNELS.PLAYER.GET_STATE),
  playerGetTracks: () => ipcRenderer.invoke(IPC_CHANNELS.PLAYER.GET_TRACKS),
  // 当前播放的媒体快照（QYP3-068q）：手动上一集/下一集定位当前集用
  getMediaContext: () => ipcRenderer.invoke(IPC_CHANNELS.PLAYER.GET_MEDIA_CONTEXT),
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
  /** 来源转域（QYP3-055）：改用途标签，已索引内容不动（音乐域查询按 purpose 过滤）。 */
  setSourcePurpose: (sourceId: number, purpose: 'music' | 'video') =>
    ipcRenderer.invoke(IPC_CHANNELS.CATALOG.SOURCE_SET_PURPOSE, { sourceId, purpose }),
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
  getRecentlyPlayed: (limit?: number, opts?: { localOnly?: boolean }) =>
    ipcRenderer.invoke(IPC_CHANNELS.LIBRARY.GET_RECENTLY_PLAYED, limit, opts),
  clearHistory: () => ipcRenderer.invoke(IPC_CHANNELS.LIBRARY.CLEAR_HISTORY),
  deleteHistoryItem: (mediaType: string, mediaId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.LIBRARY.DELETE_HISTORY, mediaType, mediaId),

  // Online
  getLibraries: () => ipcRenderer.invoke(IPC_CHANNELS.ONLINE.GET_LIBRARIES),
  getItems: (parentId: string, options?: unknown, serverId?: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.ONLINE.GET_ITEMS, parentId, options, serverId),
  getItemDetails: (itemId: string, serverId?: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.ONLINE.GET_ITEM_DETAILS, itemId, serverId),
  /** 服务器歌单条目（P2 只读）：歌单 id 必须配它的 serverId。 */
  getServerPlaylistItems: (playlistId: string, serverId: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.ONLINE.GET_PLAYLIST_ITEMS, playlistId, serverId),
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
  diagnosticsSummary: () => ipcRenderer.invoke(IPC_CHANNELS.DIAGNOSTICS.SUMMARY),
  // Unified cross-source queries (QYP2-036)
  unifiedContinueWatching: (limit?: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.UNIFIED.CONTINUE_WATCHING, limit),
  unifiedRecent: (limit?: number) => ipcRenderer.invoke(IPC_CHANNELS.UNIFIED.RECENT, limit),
  unifiedSearch: (query: string, page?: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.UNIFIED.SEARCH, query, page),
  // Auto-next (QYP2-035): push events + cancel.
  onAutoNextEvent: (callback: (event: unknown) => void) => {
    const handler = (_event: unknown, payload: unknown) => callback(payload);
    ipcRenderer.on(IPC_CHANNELS.AUTO_NEXT.EVENT, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.AUTO_NEXT.EVENT, handler);
  },
  // 手动切集（QYP3-068q）：全局快捷键在主进程收键，方向转给渲染层执行
  onAutoNextCommand: (callback: (direction: 'next' | 'prev') => void) => {
    const handler = (_event: unknown, payload: unknown) =>
      callback(payload === 'prev' ? 'prev' : 'next');
    ipcRenderer.on(IPC_CHANNELS.AUTO_NEXT.ON_COMMAND, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.AUTO_NEXT.ON_COMMAND, handler);
  },
  autoNextCancel: (reason?: 'user' | 'no-next-episode') =>
    ipcRenderer.invoke(IPC_CHANNELS.AUTO_NEXT.CANCEL, reason ?? 'user'),
  getAutoNextEnabled: () => ipcRenderer.invoke(IPC_CHANNELS.AUTO_NEXT.GET_ENABLED),
  setAutoNextEnabled: (enabled: boolean) => ipcRenderer.invoke(IPC_CHANNELS.AUTO_NEXT.SET_ENABLED, enabled),
  getAppVersion: () => ipcRenderer.invoke(IPC_CHANNELS.APP.GET_VERSION),
  // Skip intro/outro (剧集；segments 主进程拉取，开关仅控制命中行为)
  // 音乐库（QYP3-008）：专辑聚合/专辑曲目/全部曲目（分页 ≤200）
  getMusicAlbums: (limit = 200) => ipcRenderer.invoke(IPC_CHANNELS.MUSIC.GET_ALBUMS, { limit }),
  getAlbumTracks: (albumartist: string, album: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MUSIC.GET_ALBUM_TRACKS, { albumartist, album }),
  getMusicTracks: (offset = 0, limit = 200) =>
    ipcRenderer.invoke(IPC_CHANNELS.MUSIC.GET_TRACKS, { offset, limit }),
  // 歌手 / 收藏（QYP3-008a）
  getMusicArtists: (limit = 200) => ipcRenderer.invoke(IPC_CHANNELS.MUSIC.GET_ARTISTS, { limit }),
  getArtistAlbums: (albumartist: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MUSIC.GET_ARTIST_ALBUMS, { albumartist }),
  getMusicFavorites: (limit = 200) =>
    ipcRenderer.invoke(IPC_CHANNELS.MUSIC.GET_FAVORITES, { limit }),
  setMusicFavorite: (trackId: number, favorite: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.MUSIC.SET_FAVORITE, { trackId, favorite }),
  /** 播放期回填真实时长（QYP3-052）：只对本地/WebDAV 曲目（trackId > 0）。 */
  setMusicTrackDuration: (trackId: number, duration: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.MUSIC.SET_TRACK_DURATION, { trackId, duration }),
  /**
   * 当前播放的音乐（QYP3-053）：只存"上次在放哪首 + 放到哪"，**不写历史**。
   * server 记录用于启动恢复服务器曲目（本地/WebDAV 按 trackId 查库反查）。
   */
  setNowPlaying: (record: {
    type: 'track' | 'server';
    sourceId?: number;
    trackId?: number;
    serverId?: number;
    provider?: 'jellyfin' | 'emby';
    itemId?: string;
    title: string;
    artist?: string | null;
    albumartist?: string | null;
    duration?: number | null;
    position: number;
  }) => ipcRenderer.invoke(IPC_CHANNELS.MUSIC.SET_NOW_PLAYING, record),
  getNowPlaying: () => ipcRenderer.invoke(IPC_CHANNELS.MUSIC.GET_NOW_PLAYING),
  /**
   * 音效链热更新（QYP3-068v）：把整份音效设置交给主进程，mpv 侧防抖后
   * 重建 af 链。非 mpv 音乐会话（含 renderer 内置引擎）时主进程直接忽略。
   */
  applyAudioChain: (fx: unknown) => ipcRenderer.invoke(IPC_CHANNELS.MUSIC.APPLY_AUDIO_CHAIN, fx),
  clearNowPlaying: () => ipcRenderer.invoke(IPC_CHANNELS.MUSIC.CLEAR_NOW_PLAYING),
  // 服务器音乐会话与进度（QYP3-038）：webaudio 播放不经 LOAD_FILE，
  // Sessions/Playing 系列由渲染层节流后经这两条通道上报
  startMusicServerSession: (args: { serverId: number; provider: 'jellyfin' | 'emby'; itemId: string; mediaSourceId?: string; title?: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.MUSIC.START_SERVER_SESSION, args),
  reportMusicServerProgress: (args: { serverId: number; provider: 'jellyfin' | 'emby'; itemId: string; mediaSourceId?: string; title?: string; position: number; duration?: number; isFinished?: boolean; isStopped?: boolean; playSessionId?: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.MUSIC.REPORT_SERVER_PROGRESS, args),
  // 歌单（QYP3-015/016/017）
  listPlaylists: () => ipcRenderer.invoke(IPC_CHANNELS.PLAYLIST.LIST),
  createPlaylist: (name: string) => ipcRenderer.invoke(IPC_CHANNELS.PLAYLIST.CREATE, { name }),
  renamePlaylist: (id: number, name: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.PLAYLIST.RENAME, { id, name }),
  deletePlaylist: (id: number) => ipcRenderer.invoke(IPC_CHANNELS.PLAYLIST.DELETE, { id }),
  getPlaylistItems: (id: number) => ipcRenderer.invoke(IPC_CHANNELS.PLAYLIST.GET_ITEMS, { id }),
  addToPlaylist: (id: number, refs: string[]) =>
    ipcRenderer.invoke(IPC_CHANNELS.PLAYLIST.ADD_ITEMS, { id, refs }),
  removeFromPlaylist: (id: number, position: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.PLAYLIST.REMOVE_ITEM, { id, position }),
  reorderPlaylistItem: (id: number, from: number, to: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.PLAYLIST.REORDER, { id, from, to }),
  exportPlaylistM3u8: (id: number) => ipcRenderer.invoke(IPC_CHANNELS.PLAYLIST.EXPORT_M3U8, { id }),
  exportPlaylistXspf: (id: number) => ipcRenderer.invoke(IPC_CHANNELS.PLAYLIST.EXPORT_XSPF, { id }),
  setMusicEngineActive: (value: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.MUSIC.SET_ENGINE_ACTIVE, value),
  // 歌词（QYP3-021）：扫描期内嵌歌词读缓存；手动导入走文件对话框
  getMusicLyrics: (trackId: number) => ipcRenderer.invoke(IPC_CHANNELS.MUSIC.GET_LYRICS, { trackId }),
  /** 服务器曲目歌词（QYP3-020b）：Jellyfin 端点；Emby / 无词返回 hasLyrics=false。 */
  getServerLyrics: (serverId: number, itemId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MUSIC.GET_SERVER_LYRICS, { serverId, itemId }),
  importMusicLyrics: (trackId: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.MUSIC.IMPORT_LYRICS, { trackId }),
  onMusicCommand: (cb: (command: string) => void) => {
    const listener = (_event: unknown, command: string): void => cb(command);
    ipcRenderer.on(IPC_CHANNELS.MUSIC.ON_COMMAND, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.MUSIC.ON_COMMAND, listener);
  },
  /** 音乐会话被视频取代（QYP3-026）：停 renderer 引擎 + 收音乐控制条。 */
  onMusicSessionEnd: (cb: () => void) => {
    const listener = (): void => cb();
    ipcRenderer.on(IPC_CHANNELS.MUSIC.ON_SESSION_END, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.MUSIC.ON_SESSION_END, listener);
  },
  /**
   * 离线频谱（QYP3-050）：主进程是"当前 mpv 音乐曲目"的权威，取数据不带参数；
   * 返回 ready / pending / unavailable / failed / none 五态。
   */
  getMusicSpectrum: () => ipcRenderer.invoke(IPC_CHANNELS.MUSIC.GET_SPECTRUM),
  /** main → renderer：某曲目的频谱已定论（就绪/不可用/失败都会推）。 */
  onMusicSpectrumReady: (cb: (event: unknown) => void) => {
    const listener = (_event: unknown, payload: unknown): void => cb(payload);
    ipcRenderer.on(IPC_CHANNELS.MUSIC.ON_SPECTRUM_READY, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.MUSIC.ON_SPECTRUM_READY, listener);
  },
  // 睡眠定时（P2）：到点暂停播放；ON_EXPIRED 让 renderer 停 renderer 引擎
  getSleepTimer: () => ipcRenderer.invoke(IPC_CHANNELS.SLEEP.GET_STATE),
  setSleepTimer: (minutes: number) => ipcRenderer.invoke(IPC_CHANNELS.SLEEP.SET, { minutes }),
  onSleepTimerExpired: (cb: () => void) => {
    const listener = (): void => cb();
    ipcRenderer.on(IPC_CHANNELS.SLEEP.ON_EXPIRED, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.SLEEP.ON_EXPIRED, listener);
  },

  // 桌面歌词（QYP3-022）：主窗口推状态；歌词窗口收事件
  showDeskLyrics: () => ipcRenderer.invoke(IPC_CHANNELS.DESKLYRICS.SHOW),
  hideDeskLyrics: () => ipcRenderer.invoke(IPC_CHANNELS.DESKLYRICS.HIDE),
  pushDeskLyricsState: (args: {
    title: string;
    content: string | null;
    position: number;
    isPlaying: boolean;
  }) => ipcRenderer.invoke(IPC_CHANNELS.DESKLYRICS.STATE, args),
  setDeskLyricsStyle: (args: { fontSize?: number; locked?: boolean }) =>
    ipcRenderer.invoke(IPC_CHANNELS.DESKLYRICS.SET_STYLE, args),
  onDeskLyricsEvent: (cb: (payload: DeskLyricsEvent) => void) => {
    const listener = (_event: unknown, payload: DeskLyricsEvent): void => cb(payload);
    ipcRenderer.on(IPC_CHANNELS.DESKLYRICS.EVENT, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.DESKLYRICS.EVENT, listener);
  },
  getSkipSettings: () => ipcRenderer.invoke(IPC_CHANNELS.SKIP_SEGMENTS.GET_SETTINGS),
  setSkipSetting: (key: 'skipIntro' | 'skipOutro', enabled: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.SKIP_SEGMENTS.SET_SETTING, { key, enabled }),
  // 剧集自定义片头/片尾（整剧 scope=series）
  getSkipOverride: (input: { serverType: string; serverId: number; itemId: string; seriesName: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.SKIP_SEGMENTS.GET_OVERRIDE, input),
  setSkipOverride: (input: {
    serverType: string;
    serverId: number;
    itemId: string;
    seriesName: string;
    intro?: { start: number; end: number } | null;
    outro?: { start: number; end: number } | null;
  }) => ipcRenderer.invoke(IPC_CHANNELS.SKIP_SEGMENTS.SET_OVERRIDE, input),
  // Series resume (QYP2-034): pure resolver runs main-side.
  resolveSeriesResume: (episodes: unknown[]) =>
    ipcRenderer.invoke(IPC_CHANNELS.RESUME.SERIES, episodes, undefined),
  resolveSeriesResumeOfType: (episodes: unknown[], mediaType: 'jellyfin' | 'emby') =>
    ipcRenderer.invoke(IPC_CHANNELS.RESUME.SERIES, episodes, mediaType),
  pickNextEpisode: (input: {
    episodes: unknown[];
    seasonNumber?: number | null;
    episodeNumber?: number | null;
    /** QYP3-068q：手动「上一集」传 'prev'（省略 = 下一集）。 */
    direction?: 'next' | 'prev';
  }) => ipcRenderer.invoke(IPC_CHANNELS.RESUME.NEXT, input),
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
  setCompactMode: (enabled: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.WINDOW.SET_COMPACT_MODE, enabled),
  // 音乐模式（QYP3-044）：主窗口原地改成竖窄屏（同窗，不新开窗口）
  setMusicMode: (enabled: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.WINDOW.SET_MUSIC_MODE, enabled),
  /** reload 后问主进程：窗口现在是浮窗还是竖屏（渲染层据此回填 store）。 */
  getWindowProfile: () => ipcRenderer.invoke(IPC_CHANNELS.WINDOW.GET_PROFILE),
  // 系统资源压力（QYP3-036）：性能保护据此降帧
  getResourcePressure: () => ipcRenderer.invoke(IPC_CHANNELS.RESOURCE.GET_PRESSURE),
  onResourcePressure: (cb: (pressure: string) => void) => {
    const handler = (_event: unknown, pressure: string) => cb(pressure);
    ipcRenderer.on(IPC_CHANNELS.RESOURCE.ON_PRESSURE, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.RESOURCE.ON_PRESSURE, handler);
  },
  setFullscreen: (fullscreen: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.WINDOW.SET_FULLSCREEN, fullscreen),

  // 无边框窗口（QYP3-042）：标题栏按钮 + 自绘缩放热区
  minimizeWindow: () => ipcRenderer.invoke(IPC_CHANNELS.WINDOW.MINIMIZE),
  toggleMaximizeWindow: () => ipcRenderer.invoke(IPC_CHANNELS.WINDOW.TOGGLE_MAXIMIZE),
  closeWindow: () => ipcRenderer.invoke(IPC_CHANNELS.WINDOW.CLOSE),
  isWindowMaximized: () => ipcRenderer.invoke(IPC_CHANNELS.WINDOW.IS_MAXIMIZED),
  /** 边/角缩写：n/s/e/w/ne/nw/se/sw；dx/dy 为屏幕像素位移增量。 */
  resizeWindowBy: (edge: string, dx: number, dy: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.WINDOW.RESIZE_DELTA, { edge, dx, dy }),
  onWindowMaximizeChange: (cb: (maximized: boolean) => void) => {
    const handler = (_event: unknown, maximized: boolean) => cb(maximized);
    ipcRenderer.on(IPC_CHANNELS.WINDOW.ON_MAXIMIZE_CHANGE, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.WINDOW.ON_MAXIMIZE_CHANGE, handler);
  },

  // Shortcuts
  applyShortcuts: (overrides: Record<string, string>) =>
    ipcRenderer.invoke(IPC_CHANNELS.SHORTCUTS.APPLY, overrides),
  applyMpvShortcuts: (overrides: Record<string, string>) =>
    ipcRenderer.invoke(IPC_CHANNELS.SHORTCUTS.APPLY_MPV, overrides),

  // 平台标识（QYP3-063）：渲染层做 mac 红绿灯避让等平台微调
  platform: process.platform as NodeJS.Platform,
};

contextBridge.exposeInMainWorld('electronAPI', electronAPI);

// Also expose a ready signal
contextBridge.exposeInMainWorld('__QY_READY__', true);

export type ElectronAPI = typeof electronAPI;
