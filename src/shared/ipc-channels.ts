export const IPC_CHANNELS = {
  PLAYER: {
    LOAD_FILE: 'player:load-file',
    CONTROL: 'player:control',
    GET_STATE: 'player:get-state',
    GET_TRACKS: 'player:get-tracks',
    ON_STATE_CHANGE: 'player:on-state-change',
  },
  LIBRARY: {
    OPEN_FILE: 'library:open-file',
    OPEN_FOLDER: 'library:open-folder',
    GET_RECENTLY_PLAYED: 'library:get-recently-played',
    CLEAR_HISTORY: 'library:clear-history',
    DELETE_HISTORY: 'library:delete-history',
  },
  ONLINE: {
    GET_LIBRARIES: 'online:get-libraries',
    GET_ITEMS: 'online:get-items',
    GET_ITEM_DETAILS: 'online:get-item-details',
    GET_STREAM_URL: 'online:get-stream-url',
    GET_CONTINUE_WATCHING: 'online:get-continue-watching',
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
} as const;
