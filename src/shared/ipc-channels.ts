export const IPC_CHANNELS = {
  PLAYER: {
    LOAD_FILE: 'player:load-file',
    RESOLVE: 'player:resolve',
    CONTROL: 'player:control',
    GET_STATE: 'player:get-state',
    GET_TRACKS: 'player:get-tracks',
    PROBE_ITEM: 'player:probe-item',
    ON_STATE_CHANGE: 'player:on-state-change',
  },
  LIBRARY: {
    OPEN_FILE: 'library:open-file',
    OPEN_FOLDER: 'library:open-folder',
    GET_RECENTLY_PLAYED: 'library:get-recently-played',
    CLEAR_HISTORY: 'library:clear-history',
    DELETE_HISTORY: 'library:delete-history',
  },
  DIAGNOSTICS: {
    SUMMARY: 'diagnostics:summary',
  },
  MUSIC: {
    GET_ALBUMS: 'music:get-albums',
    GET_ALBUM_TRACKS: 'music:get-album-tracks',
    GET_TRACKS: 'music:get-tracks',
    /** 歌手聚合 / 单歌手专辑（QYP3-008a）。 */
    GET_ARTISTS: 'music:get-artists',
    GET_ARTIST_ALBUMS: 'music:get-artist-albums',
    /** 收藏列表与收藏开关（QYP3-008a）。 */
    GET_FAVORITES: 'music:get-favorites',
    SET_FAVORITE: 'music:set-favorite',
    /** renderer 引擎进度上报（ADR-0007：webaudio 播放不经 mpv）。 */
    REPORT_PROGRESS: 'music:report-progress',
    GET_LYRICS: 'music:get-lyrics',
    /** 服务器曲目歌词（QYP3-020b）：Jellyfin 端点，Emby 无词。 */
    GET_SERVER_LYRICS: 'music:get-server-lyrics',
    /** 手动导入 .lrc（QYP3-021）：文件对话框 → 落盘到 lyrics 分区。 */
    IMPORT_LYRICS: 'music:import-lyrics',
    /** webaudio 起播/停止时上报激活态（媒体键双用途路由）。 */
    SET_ENGINE_ACTIVE: 'music:set-engine-active',
    /** 全局媒体键转发（renderer 引擎激活时 main → renderer）。 */
    ON_COMMAND: 'music:on-command',
    /**
     * main → renderer：音乐会话被非音乐媒体（视频）取代（QYP3-026）。
     * renderer 据此停掉 renderer 引擎并清空音乐控制条状态。
     */
    ON_SESSION_END: 'music:on-session-end',
  },
  /** 睡眠定时（P2）：到点暂停播放，音乐/视频通用（会话内有效，不持久化）。 */
  SLEEP: {
    GET_STATE: 'sleep:get-state',
    /** 设置分钟数（0 = 关闭）。 */
    SET: 'sleep:set',
    /** main → renderer：定时到点（renderer 侧停 renderer 引擎音乐）。 */
    ON_EXPIRED: 'sleep:on-expired',
  },
  DESKLYRICS: {
    /** 打开桌面歌词窗口（ADR-0008）。 */
    SHOW: 'desklyrics:show',
    HIDE: 'desklyrics:hide',
    /** renderer → main：当前曲目 + 歌词 + 播放位置（节流 ≤10Hz）。 */
    STATE: 'desklyrics:state',
    /** main → 桌面歌词窗口：状态/样式推送。 */
    EVENT: 'desklyrics:event',
    /** 样式设置（字号/锁定）→ 应用并持久化。 */
    SET_STYLE: 'desklyrics:set-style',
  },
  PLAYLIST: {
    LIST: 'playlist:list',
    CREATE: 'playlist:create',
    RENAME: 'playlist:rename',
    DELETE: 'playlist:delete',
    GET_ITEMS: 'playlist:get-items',
    ADD_ITEMS: 'playlist:add-items',
    REMOVE_ITEM: 'playlist:remove-item',
    REORDER: 'playlist:reorder',
    IMPORT_M3U: 'playlist:import-playlist',
    EXPORT_M3U8: 'playlist:export-list',
    EXPORT_XSPF: 'playlist:export-xspf',
  },
  UNIFIED: {
    CONTINUE_WATCHING: 'unified:continue-watching',
    RECENT: 'unified:recent',
    SEARCH: 'unified:search',
  },
  ONLINE: {
    GET_LIBRARIES: 'online:get-libraries',
    GET_ITEMS: 'online:get-items',
    GET_ITEM_DETAILS: 'online:get-item-details',
    GET_STREAM_URL: 'online:get-stream-url',
    GET_CONTINUE_WATCHING: 'online:get-continue-watching',
    /** 服务器歌单条目（P2 只读）：`/Playlists/{id}/Items`。 */
    GET_PLAYLIST_ITEMS: 'online:get-playlist-items',
    SEARCH: 'online:search',
  },
  PROGRESS: {
    SAVE: 'progress:save',
    GET: 'progress:get',
    GET_CONTINUE: 'progress:get-continue',
  },
  SETTINGS: {
    GET: 'settings:get',
    SET: 'settings:set',
    GET_SERVERS: 'settings:get-servers',
    SAVE_SERVER: 'settings:save-server',
    TEST_SERVER: 'settings:test-server',
    SECRETS_PERSISTENT: 'settings:secrets-persistent',
  },
  WINDOW: {
    ENTER_PLAYER_MODE: 'window:enter-player-mode',
    EXIT_PLAYER_MODE: 'window:exit-player-mode',
    SET_FULLSCREEN: 'window:set-fullscreen',
  },
  SHORTCUTS: {
    APPLY: 'shortcuts:apply',
    APPLY_MPV: 'shortcuts:apply-mpv',
  },
  // Phase 2 unified catalog domain (handlers land in QYP2-008+; the channel
  // names are part of the QYP2-002 contract and must not be renamed).
  CATALOG: {
    PICK_DIR: 'catalog:pick-dir',
    SOURCE_LIST: 'catalog:source-list',
    SOURCE_TEST: 'catalog:source-test',
    SOURCE_SAVE: 'catalog:source-save',
    SOURCE_REMOVE: 'catalog:source-remove',
    SOURCE_HEALTH: 'catalog:source-health',
    SCAN_START: 'catalog:scan-start',
    SCAN_CANCEL: 'catalog:scan-cancel',
    SCAN_EVENTS: 'catalog:scan-events',
    LIST: 'catalog:list',
    GET: 'catalog:get',
    SEARCH: 'catalog:search',
    RESOLVE: 'catalog:resolve',
  },
  SUBTITLES: {
    PICK_FILE: 'subtitles:pick-file',
    IMPORT: 'subtitles:import',
    LIST: 'subtitles:list',
    REMOVE: 'subtitles:remove',
    SET_DEFAULT: 'subtitles:set-default',
  },
  METADATA: {
    GET: 'metadata:get',
    SAVE: 'metadata:save',
    RESTORE: 'metadata:restore',
    PICK_IMAGE: 'metadata:pick-image',
    IMPORT_IMAGES: 'metadata:import-images',
  },
  MEDIA: {
    DELETE_PREVIEW: 'media:delete-preview',
    DELETE_EXECUTE: 'media:delete-execute',
  },
  PLUGINS: {
    LIST: 'plugins:list',
    SET_CONFIG: 'plugins:set-config',
    SET_SECRET: 'plugins:set-secret',
    DELETE_SECRET: 'plugins:delete-secret',
    TEST: 'plugins:test',
  },
  RESUME: {
    SERIES: 'resume:series',
    NEXT: 'resume:next',
  },
  AUTO_NEXT: {
    EVENT: 'auto-next:event',
    CANCEL: 'auto-next:cancel',
    GET_ENABLED: 'auto-next:get-enabled',
    SET_ENABLED: 'auto-next:set-enabled',
  },
  APP: {
    GET_VERSION: 'app:get-version',
  },
  SKIP_SEGMENTS: {
    GET_SETTINGS: 'skip-segments:get-settings',
    SET_SETTING: 'skip-segments:set-setting',
    GET_OVERRIDE: 'skip-segments:get-override',
    SET_OVERRIDE: 'skip-segments:set-override',
  },
  SCRAPE: {
    START: 'scrape:start',
    JOBS: 'scrape:jobs',
    STATUS: 'scrape:status',
    CANCEL: 'scrape:cancel',
    APPLY: 'scrape:apply',
  },
} as const;
