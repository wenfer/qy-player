import { ipcMain } from 'electron';
import { open as openFile, readFile } from 'node:fs/promises';
import { randomUUID } from 'crypto';
import { basename, extname, join } from 'path';
import { app } from 'electron';
import { IPC_CHANNELS } from '../../shared/ipc-channels';
import { PlayerCore } from '../modules/player-core';
import { getDatabase, createStorage, closeDatabase } from '../modules/storage/db';
import { decodeConfigValue, encodeConfigValue } from '../modules/storage/config-value';
import { PlaybackStateManager } from '../modules/playback-state';
import { createClient } from '../modules/online-connector';
import { lyricsToLrc } from '../modules/online-connector/lyrics';
import {
  MEDIA_SERVER_NAMESPACE,
  assertNotSecretConfigKey,
  createSecretStore,
  createStreamHeaderCache,
  migrateServerTokensToSecretStore,
  resolveServerApiKey,
  sanitizeServerForRenderer,
} from '../modules/security/secret-store';
import type { SecretStore, StreamHeaderCache } from '../modules/security/secret-store';
import {
  createStreamRouteCache,
  type StreamRouteCache,
} from '../modules/security/stream-route-cache';
import { LocalSourceAdapter } from '../modules/library-sources/local-source';
import { WebDavSourceAdapter } from '../modules/library-sources/webdav-source';
import type { SourceAdapter } from '../modules/library-sources/types';
import { ScanJobController } from '../modules/library-scanner/job-controller';
import {
  createLocalScanDriver,
  markAvailabilityAfterScan,
  walkSourceTree,
} from '../modules/library-scanner/local-scanner';
import {
  createWebDavScanDriver,
  persistSourceHealth,
  readPersistedHealth,
  type SourceHealthState,
} from '../modules/library-scanner/webdav-scanner';
import {
  createLocalSourceFromSelection,
  createWebDavSource,
  getAdapterForSource,
  removeSource,
  testWebDavConnection,
} from '../modules/catalog/source-service';
import { createCatalogRepository } from '../modules/catalog/repository';
import { createCatalogQueryService } from '../modules/catalog/query-service';
import { migrateLegacyProgressForSource } from '../modules/catalog/legacy-progress';
import {
  isCreateLocalSourceInput,
  isSourcePurpose,
  isCreateWebDavSourceInput,
  err,
  ok,
} from '../../shared/types';
import type { ServerConfig } from '../../shared/types';
import type {
  ActionResult,
  ScanProgressEvent,
  SourceCapabilities,
  SourceListEntry,
} from '../../shared/types';
import { isMediaRef } from '../../shared/types';
import {
  bindServerById,
  injectAttachedSubtitles,
  parseWebDavMediaId,
  resolvePlayback,
  ResolverError,
} from '../modules/player-core/playback-resolver';
import { mediaProbeService } from '../modules/media-probe';
import {
  SubtitleService,
  cleanupTempFiles,
  type ImportSubtitleInput,
} from '../modules/media-operations/subtitle-service';
import {
  describeItemFields,
  importItemImages,
  restoreManualFields,
  toEditorActionResult,
  type ManualPatch,
} from '../modules/metadata/editor-service';
import {
  mapDeleteExecuteResult,
  mapDeletePreviewResult,
  SafeDeleteService,
} from '../modules/media-operations/delete-service';
import { PluginConfigService, REQUIRED_SECRET_KEYS } from '../modules/plugin-runtime/config-service';
import {
  getPlugin,
  getPluginContext,
  listPlugins,
  registerPlugin,
} from '../modules/plugin-runtime/registry';
import { buildTmdbPlugin } from '../plugins/tmdb';
import { ScrapeJobService } from '../modules/plugin-runtime/job-service';
import { PluginError } from '../../shared/types/plugins';
import {
  clearNowPlaying,
  parseNowPlaying,
  readNowPlaying,
  writeNowPlaying,
} from '../modules/playback-state/now-playing';
import { resolveSeriesResume } from '../modules/playback-state/resume-resolver';
import {
  CacheManager,
  MUSIC_SPECTRUM_QUOTA_BYTES,
} from '../modules/cache/cache-manager';
import { MusicSpectrumService } from '../modules/music-spectrum';
import { registerAudioSourceProvider } from '../modules/playback-engine/audio-url';
import { mpvAudioFilterFromEq, sanitizeEqGains } from '../modules/playback-engine/equalizer';
import { normalizeReplayGain } from '../modules/playback-engine/replaygain';
import {
  clearMusicSession,
  isMpvMusicActive,
  isMusicSessionActive,
  setMpvMusicActive,
  setMusicEngineActive,
} from '../modules/playback-engine/music-active';
import { SleepTimer } from '../modules/ui-shell/sleep-timer';
import { setCompactMode, setMusicMode, getWindowProfile } from '../modules/ui-shell/compact-window';
import { getResourcePressure } from '../modules/ui-shell/resource-guard';
import {
  closeDeskLyrics,
  isDesktopLyricsSupported,
  isDeskLyricsOpen,
  openDeskLyrics,
  pushDeskLyricsState,
  setDeskLyricsPersistence,
  setDeskLyricsStyle,
} from '../modules/ui-shell/desk-lyrics';
import { importM3u, listTrackCatalog, exportM3u8, exportXspf, toExportInfo, type PlaylistTrackInfo } from '../modules/playback-engine/playlist-io';
import { registerCoversPartition, registerLyricsPartition, readLyricsCache, saveLyricsFromTags } from '../modules/library-scanner/cover-service';
import { buildDiagnosticsSummary } from '../modules/diagnostics';
import {
  createUnifiedQueryService,
  type OnlineContinueInput,
} from '../modules/catalog/unified-query';
import { AutoNextController, pickNextEpisode, wireAutoNext } from '../modules/playback-state/auto-next';
import { SkipController, parseMediaSegments, type SkipSegment } from '../modules/playback-state/skip-segments';
import type { AutoNextEpisodeLike } from '../modules/playback-state/auto-next';
import type { ResumeEpisodeInput } from '../../shared/types/playback';
import type { ProbeItemInput } from '../../shared/types/media-info';
import {
  isCatalogBrowseQuery,
  isCatalogSearchQuery,
} from '../../shared/types';
import type { CatalogBrowseQuery, CatalogSearchQuery } from '../../shared/types';

export let playbackStateManager: PlaybackStateManager | null = null;

/**
 * 离线频谱服务（QYP3-050）：mpv 音源的频谱由主进程后台用 ffmpeg 预算。
 * 退出时由 `cancelMusicSpectrum()` 同步杀掉正在跑的解码（Electron 的
 * will-quit 不 await 异步清理）。
 */
export let musicSpectrum: MusicSpectrumService | null = null;

export function cancelMusicSpectrum(): void {
  musicSpectrum?.cancelAll();
}

/** 歌单条目引用校验（QYP3-015 契约）：music:<sourceId>:<trackId>。 */
function isPlaylistItemRef(value: unknown): value is string {
  return typeof value === 'string' && /^music:\d+:\d+$/.test(value);
}

function isLocalFilePath(path: string): boolean {
  return path.startsWith('/') || /^[a-zA-Z]:\\/.test(path) || path.startsWith('file://');
}

function extractTitleFromPath(path: string): string {
  // Replace common separators with spaces
  return basename(path, extname(path)).replace(/[._]/g, ' ').trim();
}

interface ActiveServer {
  config: {
    id: number;
    type: string;
    name: string;
    base_url: string;
    api_key?: string;
    user_id?: string;
  };
  client: ReturnType<typeof createClient>;
}

/**
 * Single source of truth for iterating active, logged-in servers.
 * Every online handler must use this instead of hand-rolling the loop,
 * so auth checks and error handling stay consistent.
 * API keys come from the SecretStore; the plaintext column is legacy only.
 */
function getActiveServerClients(
  storage: ReturnType<typeof createStorage>,
  secretStore: SecretStore
): ActiveServer[] {
  return storage
    .getServers()
    .filter((s) => s.is_active && s.user_id)
    .map((server) => ({ server, apiKey: resolveServerApiKey(server, secretStore) }))
    .filter((entry): entry is { server: typeof entry.server; apiKey: string } => entry.apiKey !== null)
    .map(({ server, apiKey }) => ({
      config: { ...server, api_key: apiKey },
      client: createClient({
        type: server.type as 'jellyfin' | 'emby',
        baseUrl: server.base_url,
        apiKey,
        userId: server.user_id,
      }),
    }));
}

function describeNetworkError(err: unknown): string {
  const e = err as { code?: string; message?: string };
  const code = e?.code || '';
  if (code === 'ECONNREFUSED') return '连接被拒绝，请确认服务器地址和端口';
  if (code === 'ETIMEDOUT' || e?.message?.includes('timeout')) return '连接超时，请检查网络';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return '无法解析地址，请检查服务器地址';
  if (code === 'ECONNRESET') return '连接被重置';
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return '网络不可达，请检查 IP 地址';
  return e?.message ? `连接失败: ${e.message}` : '无法连接到服务器';
}

/** 自绘缩放热区允许的边/角缩写（QYP3-042）。 */
const RESIZE_EDGES = new Set(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']);

export interface IpcHandlerDeps {
  /**
   * qy-stream 路由表（QYP3-037）：与主进程入口注册的协议处理器共用同一实例。
   * 未注入时自查一份（测试/独立启动场景）。
   */
  streamRoutes?: StreamRouteCache;
}

export function registerIpcHandlers(
  player: PlayerCore,
  getMainWindow?: () => import('electron').BrowserWindow | null,
  deps: IpcHandlerDeps = {}
): void {
  const db = getDatabase();
  const storage = createStorage(db);

  // Secret storage: one-time legacy token migration happens here so that
  // plaintext api_key columns are cleared as soon as the app starts.
  // Failure must never block app startup: the legacy column stays as-is and
  // the next launch retries. The log must not contain the token itself.
  const secretStore = createSecretStore(db);
  // Plugin config (QYP2-027): secrets write-only through the IPC surface.
  const pluginConfigService = new PluginConfigService({
    store: secretStore,
    getConfig: (key) => storage.getConfig(key),
    setConfig: (key, value) => storage.setConfig(key, value),
  });
  try {
    migrateServerTokensToSecretStore(db, storage.getServers(), secretStore);
  } catch (err) {
    console.error('[SECRET-MIGRATION] 服务器令牌迁移失败，将在下次启动重试:', err instanceof Error ? err.message : err);
  }

  // Stream headers are stashed main-side; renderers only see session ids.
  const streamHeaders: StreamHeaderCache = createStreamHeaderCache();
  // qy-stream 路由表（QYP3-037）：可重复读取（一首歌多次 Range 请求），
  // 与 mpv 用的单次消费 streamHeaders 是两套语义。
  const streamRoutes: StreamRouteCache = deps.streamRoutes ?? createStreamRouteCache();

  // QYP3-019：歌词缓存目录（扫描期从标签透传落盘，人工可编辑 → 受保护）
  const lyricsDir = join(app.getPath('userData'), 'lyrics');

  // Plugin registry (QYP2-029 挂账② / QYP2-032): tmdb is the ONLY
  // registered metadata provider. Douban stays unregistered per the
  // ADR-0006 gate (contract test enforces no other wiring references it).
  const tmdbRegistration = registerPlugin(buildTmdbPlugin(), {
    getSecret: (namespace, key) => secretStore.getSecret(namespace, key),
    appVersion: app.getVersion(),
    locale: 'zh-CN',
  });
  if (!tmdbRegistration.ok) {
    // Registration must never silently degrade into "plugin missing".
    console.error('[PLUGINS] TMDB 注册失败:', tmdbRegistration.errors.join('; '));
  }
  const scrapeJobs = new ScrapeJobService({
    repo: {
      getItem: (id) => catalogRepo.getItem(id),
      listMetadataSources: (itemId) => catalogRepo.listMetadataSources(itemId),
      upsertMetadataSource: (itemId, field, provider, value) =>
        catalogRepo.upsertMetadataSource(itemId, field, provider, value),
    },
    kv: {
      get: (key) => storage.getConfig(key),
      set: (key, value) => storage.setConfig(key, value),
    },
    cacheDir: join(app.getPath('userData'), 'scrape-cache'),
    runSearch: async (pluginId, query) => {
      const registered = getPlugin(pluginId);
      const ctx = getPluginContext(pluginId);
      if (!registered || !ctx) throw new PluginError('NOT_FOUND', '插件未注册');
      return registered.plugin.search({
        query: query.title,
        ...(query.year !== undefined ? { year: query.year } : {}),
        ...(query.kind !== undefined ? { kind: query.kind } : {}),
      }, ctx);
    },
    runDetails: async (pluginId, id, input) => {
      const registered = getPlugin(pluginId);
      const ctx = getPluginContext(pluginId);
      if (!registered || !ctx) throw new PluginError('NOT_FOUND', '插件未注册');
      return registered.plugin.getDetails(id, input ?? {}, ctx);
    },
    concurrency: 2,
  });

  // Initialize playback state manager. WebDAV progress keys bypass the
  // phase-1 tables (media_type CHECK) into catalog_user_state; the key
  // format is `<sourceId>:<relativePath>` (see PlaybackResolver).
  const catalogRepo = createCatalogRepository(db);
  playbackStateManager = new PlaybackStateManager(
    player,
    storage,
    {
      save: (mediaType, mediaId, position, duration, isFinished) => {
        if (mediaType !== 'webdav') return;
        const parsed = parseWebDavMediaId(mediaId);
        if (!parsed) return;
        const file = catalogRepo.getFileByPath(parsed.sourceId, parsed.relativePath);
        if (!file) return;
        catalogRepo.upsertUserState({ itemId: file.item_id, position, duration, isFinished });
      },
      getResumePosition: (mediaType, mediaId) => {
        if (mediaType !== 'webdav') return 0;
        const parsed = parseWebDavMediaId(mediaId);
        if (!parsed) return 0;
        const file = catalogRepo.getFileByPath(parsed.sourceId, parsed.relativePath);
        if (!file) return 0;
        const state = catalogRepo.getUserState(file.item_id);
        if (!state) return 0;
        if (state.duration && state.position / state.duration > 0.9) return 0;
        return state.position;
      },
    },
    // QYP3-053：mpv 本次加载的是音乐 → 不写播放历史（服务器回传保留）
    () => isMpvMusicActive()
  );
  playbackStateManager.init();

  // Auto-next (QYP2-035, plan §12.3): registered AFTER playback-state's eof
  // saver, so the final progress save always runs before the countdown
  // starts (EventEmitter listener order). markLoaded is called from the
  // LOAD_FILE handlers; the renderer owns "is there a next episode".
  const autoNext = new AutoNextController({
    isEnabled: () => storage.getConfig('playback.autoNext') !== 'false',
    broadcast: (event) => {
      const win = getMainWindow?.();
      if (win && !win.isDestroyed()) {
        win.webContents.send(IPC_CHANNELS.AUTO_NEXT.EVENT, event);
      }
    },
  });
  wireAutoNext(player, autoNext);

  // 剧集跳过片头/片尾（segments：Jellyfin MediaSegments；剧集限定，
  // 片头默认开、片尾默认关；永不阻塞播放——fetch 失败即无分段）。
  const skipController = new SkipController({
    isEnabled: (type) =>
      type === 'intro'
        ? storage.getConfig('playback.skipIntro') !== 'false'
        : storage.getConfig('playback.skipOutro') === 'true',
    onSkip: ({ type, seekTo }) => {
      void player.seek(seekTo).catch(() => {});
      void player.showText(type === 'intro' ? '已跳过片头' : '已跳过片尾');
    },
  });
  player.on('time-pos', (pos: number) => {
    skipController.onTime(pos, player.getState().duration || undefined);
  });

  // Auto-next cancel (user / renderer reports no next episode).
  ipcMain.handle(IPC_CHANNELS.AUTO_NEXT.CANCEL, (_event, reason: unknown) => {
    autoNext.cancel(reason === 'no-next-episode' ? 'no-next-episode' : 'user');
    return ok({ cancelled: true });
  });

  // Skip intro/outro settings (剧集限定；main 侧每次命中实时读取)。
  ipcMain.handle(IPC_CHANNELS.APP.GET_VERSION, () => ok({ version: app.getVersion() }));

  // 音乐库（QYP3-008/055）：范围 = 音乐域来源（purpose='music'，见
  // listMusicSourceIds）——域与用途绑定，影视来源（含 QYP3-041 拆域遗留）
  // 扫出的音轨不进音乐界面
  ipcMain.handle(IPC_CHANNELS.MUSIC.GET_ALBUMS, (_event, args: { limit?: number }) => {
    const limit = Math.min(Math.max(Number(args?.limit) || 200, 1), 200); // 页 ≤200（§16.4）
    return ok({ albums: catalogRepo.listMusicAlbums(catalogRepo.listMusicSourceIds(), limit) });
  });

  ipcMain.handle(
    IPC_CHANNELS.MUSIC.GET_ALBUM_TRACKS,
    (_event, args: { albumartist: string; album: string }) => {
      return ok({
        tracks: catalogRepo.listAlbumTracks(
          catalogRepo.listMusicSourceIds(),
          args.albumartist,
          args.album
        ),
      });
    }
  );

  // 当前播放的音乐（QYP3-053）：只存"上次在放哪首 + 放到哪"，**不写历史**。
  // 用户诉求：音频不需要记录进度，也不要进播放历史；下次启动只是把播放条
  // 恢复出来（不自动出声），点同一首从头播。校验复用 parseNowPlaying——
  // 落盘与读回共用同一套规则，坏数据在入口就被挡住。
  ipcMain.handle(IPC_CHANNELS.MUSIC.SET_NOW_PLAYING, (_event, args: unknown) => {
    const candidate =
      args && typeof args === 'object'
        ? { ...(args as Record<string, unknown>), updatedAt: Date.now() }
        : args;
    const record = parseNowPlaying(JSON.stringify(candidate));
    if (!record) return err('VALIDATION_FAILED', '音乐状态参数不合法');
    writeNowPlaying(storage, record);
    return ok({ saved: true });
  });

  // 启动恢复（QYP3-053）：把记录补成渲染层可直接入队的 MusicTrackInput。
  // 音轨/来源已被删除时清掉记录并回 null——恢复出一条点不动的曲目更糟。
  ipcMain.handle(IPC_CHANNELS.MUSIC.GET_NOW_PLAYING, () => {
    const record = readNowPlaying(storage);
    if (!record) return ok({ record: null });
    if (record.type === 'server') {
      // 服务器被删掉时同样作废记录（对称于下面的音轨分支）
      const provider = record.provider ?? 'jellyfin';
      const alive = storage
        .getServers()
        .some((s) => s.id === record.serverId && s.type === provider);
      if (!alive) {
        clearNowPlaying(storage);
        return ok({ record: null });
      }
      return ok({
        record: {
          type: 'server',
          position: record.position,
          duration: record.duration ?? null,
          updatedAt: record.updatedAt,
          input: {
            trackId: 0,
            sourceId: 0,
            serverId: record.serverId,
            provider,
            itemId: record.itemId,
            title: record.title,
            artist: record.artist ?? null,
            albumartist: record.albumartist ?? null,
            duration: record.duration ?? null,
            path: '',
            codec: null,
          },
        },
      });
    }
    const track = catalogRepo.getMusicTrack(record.sourceId!, record.trackId!);
    // 来源必须仍是音乐域（QYP3-055）：来源被转成影视域后音轨已不可播，
    // 恢复出一条点不动的曲目更糟——作废记录
    const source = track
      ? catalogRepo
          .listSources()
          .find((s) => s.id === record.sourceId && s.purpose === 'music')
      : undefined;
    if (!track || !source) {
      clearNowPlaying(storage);
      return ok({ record: null });
    }
    return ok({
      record: {
        type: 'track',
        position: record.position,
        duration: record.duration ?? track.duration ?? null,
        updatedAt: record.updatedAt,
        input: {
          trackId: track.id,
          sourceId: track.source_id,
          title: track.title,
          artist: track.artist,
          albumartist: track.albumartist,
          duration: record.duration ?? track.duration ?? null,
          path: track.path,
          codec: track.codec,
        },
      },
    });
  });

  // 服务器音乐会话（QYP3-038）：webaudio 播放不经 LOAD_FILE，Sessions/Playing
  // 要在这里发起。playSessionId 返回给渲染层，Progress/Stopped 必须携带同一
  // id（Emby 缺失 → 400，UserData 永不更新——实测教训）。严格按 serverId 路由。
  ipcMain.handle(
    IPC_CHANNELS.MUSIC.START_SERVER_SESSION,
    (_event, args: {
      serverId?: number;
      provider?: 'jellyfin' | 'emby';
      itemId?: string;
      mediaSourceId?: string;
      title?: string;
    }) => {
      const serverId = Number(args?.serverId);
      const itemId = typeof args?.itemId === 'string' && args.itemId ? args.itemId : null;
      const provider = args?.provider === 'emby' ? 'emby' : 'jellyfin';
      if (!Number.isInteger(serverId) || serverId <= 0 || !itemId) {
        return err('VALIDATION_FAILED', '服务器音乐会话参数不合法');
      }
      const server = storage
        .getServers()
        .find((s) => s.id === serverId && s.type === provider && s.is_active && s.user_id);
      if (!server) return err('NOT_FOUND', '服务器不存在或未激活');
      const apiKey = resolveServerApiKey(server, secretStore);
      if (!apiKey) return err('AUTH_REQUIRED', '服务器未登录，请先在媒体库中完成登录');
      const playSessionId = randomUUID();
      const client = createClient({
        type: server.type as 'jellyfin' | 'emby',
        baseUrl: server.base_url,
        apiKey,
        userId: server.user_id,
      });
      // fire-and-forget：报告失败只损失服务端会话展示，不阻塞起播
      void client
        .reportPlayingStart(itemId, args?.mediaSourceId || itemId, playSessionId, 'DirectPlay')
        .catch(() => {});
      return ok({ playSessionId });
    }
  );

  // 服务器音乐进度（QYP3-038）：只回传服务器（QYP3-053 起不再落本地两表
  // ——音乐不进播放历史，本地只留"当前播放的音乐"一条状态）。
  ipcMain.handle(
    IPC_CHANNELS.MUSIC.REPORT_SERVER_PROGRESS,
    (_event, args: {
      serverId?: number;
      provider?: 'jellyfin' | 'emby';
      itemId?: string;
      mediaSourceId?: string;
      title?: string;
      position: number;
      duration?: number;
      isFinished?: boolean;
      /** 收尾（跳曲/停止/换曲）：走 Stopped 端点落位，是否看完由比率另算。 */
      isStopped?: boolean;
      playSessionId?: string;
    }) => {
      const serverId = Number(args?.serverId);
      const itemId = typeof args?.itemId === 'string' && args.itemId ? args.itemId : null;
      const provider = args?.provider === 'emby' ? 'emby' : 'jellyfin';
      const position = Number(args?.position);
      if (!Number.isInteger(serverId) || serverId <= 0 || !itemId) {
        return err('VALIDATION_FAILED', '服务器音乐进度参数不合法');
      }
      if (!Number.isFinite(position) || position < 0) {
        return err('VALIDATION_FAILED', '进度参数不合法');
      }
      const duration = Number(args?.duration);
      const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : undefined;
      const isFinished =
        args?.isFinished === true ||
        (safeDuration !== undefined && safeDuration > 0 && position / safeDuration > 0.9);
      // 回传服务器：严格按 serverId 路由，失败静默。收尾一律 Stopped
      //（Emby 仅在 Stopped 时把 PositionTicks 写入 UserData——实测教训）；
      // 是否标记看完由位置比率决定，与 mpv 引擎的回传语义一致。
      const server = storage
        .getServers()
        .find((s) => s.id === serverId && s.type === provider && s.is_active && s.user_id);
      if (server) {
        const apiKey = resolveServerApiKey(server, secretStore);
        if (apiKey) {
          const client = createClient({
            type: server.type as 'jellyfin' | 'emby',
            baseUrl: server.base_url,
            apiKey,
            userId: server.user_id,
          });
          void client
            .reportProgress(
              itemId,
              args?.mediaSourceId || itemId,
              Math.floor(position * 10000000),
              isFinished || args?.isStopped === true,
              false,
              'DirectPlay',
              args?.playSessionId
            )
            .catch(() => {});
        }
      }
      return ok({ saved: true });
    }
  );

  // ------------------------------------------------------------------
  // 睡眠定时（P2）：到点暂停播放（音乐/视频通用）
  // ------------------------------------------------------------------
  const sleepTimer = new SleepTimer({
    now: () => Date.now(),
    setTimer: (cb, ms) => setTimeout(cb, ms),
    clearTimer: (handle) => clearTimeout(handle),
    onExpire: () => {
      // 先取消可能正在倒计时的自动连播（否则"停止"后下一集仍会起播）；
      // 复用 'user' 原因：语义就是"用户主动停止"，overlay 据此收起
      autoNext.cancel('user');
      // mpv（视频或 mpv 引擎音乐）直接暂停；renderer 引擎音乐由
      // renderer 收到 ON_EXPIRED 后自行暂停
      if (player.isReady()) void player.pause().catch(() => {});
      const win = getMainWindow?.();
      if (win && !win.isDestroyed()) {
        win.webContents.send(IPC_CHANNELS.SLEEP.ON_EXPIRED);
      }
    },
  });

  ipcMain.handle(IPC_CHANNELS.SLEEP.GET_STATE, () => ok(sleepTimer.state()));

  ipcMain.handle(IPC_CHANNELS.SLEEP.SET, (_event, args: { minutes?: number }) => {
    sleepTimer.set(args?.minutes);
    return ok(sleepTimer.state());
  });

  // 精简模式浮窗（QYP3-035）：主窗口原地缩小/复原（renderer 侧 state 由
  // 渲染层持有；这里只管窗口几何，跨进程无频谱转发）
  ipcMain.handle(IPC_CHANNELS.WINDOW.SET_COMPACT_MODE, (_event, enabled: boolean) => {
    const compact = setCompactMode(getMainWindow?.(), Boolean(enabled));
    return ok({ compact });
  });

  // 音乐模式窗口（QYP3-044）：主窗口原地改成竖窄屏；几何与精简浮窗共用
  // 同一份"正常几何"记忆（ui-shell/compact-window.ts）
  ipcMain.handle(IPC_CHANNELS.WINDOW.SET_MUSIC_MODE, (_event, enabled: boolean) => {
    const music = setMusicMode(getMainWindow?.(), Boolean(enabled));
    return ok({ music });
  });

  // 渲染层 reload（dev 热重载）后回填：窗口几何在主进程，store 在渲染层，
  // 不回填就会在小窗口里画出完整影视界面
  ipcMain.handle(IPC_CHANNELS.WINDOW.GET_PROFILE, () => ok(getWindowProfile()));

  // 系统资源压力（QYP3-036）：性能保护据此降帧。取值为主进程最近一次采样，
  // 变化时由主进程主动推送（ON_PRESSURE）。
  ipcMain.handle(IPC_CHANNELS.RESOURCE.GET_PRESSURE, () => ok(getResourcePressure()));

  // ---- 无边框窗口控制（QYP3-042）----------------------------------------
  // 窗口没有系统边框后，最小化/最大化/关闭与"拖边缘缩放"都得自己来。
  // 关闭按钮走 win.close()：window-all-closed → app.quit()（关闭主窗口=退出
  // 应用，托盘不可靠，见 AGENTS.md 硬性约束 5）。
  ipcMain.handle(IPC_CHANNELS.WINDOW.MINIMIZE, () => {
    const win = getMainWindow?.();
    if (win && !win.isDestroyed()) win.minimize();
    return ok(true);
  });

  ipcMain.handle(IPC_CHANNELS.WINDOW.TOGGLE_MAXIMIZE, () => {
    const win = getMainWindow?.();
    if (win && !win.isDestroyed()) {
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
    }
    return ok(true);
  });

  ipcMain.handle(IPC_CHANNELS.WINDOW.CLOSE, () => {
    const win = getMainWindow?.();
    if (win && !win.isDestroyed()) win.close();
    return ok(true);
  });

  ipcMain.handle(IPC_CHANNELS.WINDOW.IS_MAXIMIZED, () => {
    const win = getMainWindow?.();
    return ok(Boolean(win && !win.isDestroyed() && win.isMaximized()));
  });

  /**
   * 自绘缩放热区（QYP3-042）：渲染层只报"鼠标位移增量"，真实 bounds 由主进程
   * 从当前窗口几何算——渲染层拿不到窗口在屏幕上的位置，坐标换算会漂。
   * 最大化状态下忽略（此时不应改尺寸）。
   */
  ipcMain.handle(
    IPC_CHANNELS.WINDOW.RESIZE_DELTA,
    (_event, args: { edge?: string; dx?: number; dy?: number }) => {
      const edge = String(args?.edge ?? '');
      if (!RESIZE_EDGES.has(edge)) return err('VALIDATION_FAILED', '缩放方向不合法');
      const dx = Number(args?.dx) || 0;
      const dy = Number(args?.dy) || 0;
      const win = getMainWindow?.();
      if (!win || win.isDestroyed() || win.isMaximized()) return ok(false);
      const [minW, minH] = win.getMinimumSize();
      const b = win.getBounds();
      let { x, y, width, height } = b;
      if (edge.includes('e')) width = b.width + dx;
      if (edge.includes('s')) height = b.height + dy;
      if (edge.includes('w')) width = b.width - dx;
      if (edge.includes('n')) height = b.height - dy;
      width = Math.max(minW, Math.round(width));
      height = Math.max(minH, Math.round(height));
      // 被最小尺寸夹住时，左/上边不能跟着鼠标继续漂（否则窗口会"跑"）
      if (edge.includes('w')) x = b.x + (b.width - width);
      if (edge.includes('n')) y = b.y + (b.height - height);
      win.setBounds({ x, y, width, height });
      return ok(true);
    }
  );

  // ------------------------------------------------------------------
  // 歌单（QYP3-015/016/017）
  // ------------------------------------------------------------------
  ipcMain.handle(IPC_CHANNELS.PLAYLIST.LIST, () => ok({ playlists: catalogRepo.listPlaylists() }));

  ipcMain.handle(IPC_CHANNELS.PLAYLIST.CREATE, (_event, args: { name: string }) => {
    const name = typeof args?.name === 'string' ? args.name.trim().slice(0, 128) : '';
    if (!name) return err('VALIDATION_FAILED', '歌单名不能为空');
    return ok({ id: catalogRepo.createPlaylist(name) });
  });

  ipcMain.handle(IPC_CHANNELS.PLAYLIST.RENAME, (_event, args: { id: number; name: string }) => {
    const id = Number(args?.id);
    const name = typeof args?.name === 'string' ? args.name.trim().slice(0, 128) : '';
    if (!Number.isInteger(id) || id <= 0 || !name) {
      return err('VALIDATION_FAILED', '参数不合法');
    }
    return ok({ updated: catalogRepo.renamePlaylist(id, name) });
  });

  ipcMain.handle(IPC_CHANNELS.PLAYLIST.DELETE, (_event, args: { id: number }) => {
    const id = Number(args?.id);
    if (!Number.isInteger(id) || id <= 0) return err('VALIDATION_FAILED', '参数不合法');
    catalogRepo.deletePlaylist(id);
    return ok({ deleted: true });
  });

  ipcMain.handle(IPC_CHANNELS.PLAYLIST.GET_ITEMS, (_event, args: { id: number }) => {
    const id = Number(args?.id);
    if (!Number.isInteger(id) || id <= 0) return err('VALIDATION_FAILED', '参数不合法');
    return ok({ items: catalogRepo.listPlaylistItems(id) });
  });

  ipcMain.handle(
    IPC_CHANNELS.PLAYLIST.ADD_ITEMS,
    (_event, args: { id: number; refs: string[] }) => {
      const id = Number(args?.id);
      const refs = Array.isArray(args?.refs)
        ? args.refs.filter((r): r is string => isPlaylistItemRef(r))
        : [];
      if (!Number.isInteger(id) || id <= 0 || refs.length === 0) {
        return err('VALIDATION_FAILED', '参数不合法');
      }
      for (const ref of refs) catalogRepo.addToPlaylist(id, ref);
      return ok({ added: refs.length });
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.PLAYLIST.REMOVE_ITEM,
    (_event, args: { id: number; position: number }) => {
      const id = Number(args?.id);
      const position = Number(args?.position);
      if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(position) || position < 0) {
        return err('VALIDATION_FAILED', '参数不合法');
      }
      return ok({ removed: catalogRepo.removeFromPlaylist(id, position) });
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.PLAYLIST.REORDER,
    (_event, args: { id: number; from: number; to: number }) => {
      const id = Number(args?.id);
      const from = Number(args?.from);
      const to = Number(args?.to);
      if (!Number.isInteger(id) || id <= 0) return err('VALIDATION_FAILED', '参数不合法');
      return ok({ reordered: catalogRepo.reorderPlaylistItem(id, from, to) });
    }
  );

  // 导入 m3u/m3u8（QYP3-016）：打开文件对话框 → 解析匹配 → 建歌单。
  // 未定位行计数报告（Toast 展示），绝不静默丢失。
  ipcMain.handle(IPC_CHANNELS.PLAYLIST.IMPORT_M3U, async () => {
    const { dialog } = await import('electron');
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [
        { name: '播放列表', extensions: ['m3u', 'm3u8'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return ok({ imported: null });
    }
    const filePath = result.filePaths[0];
    const basename = filePath.split(/[\\/]/).pop() ?? '导入歌单';
    let content: Buffer;
    try {
      content = await import('fs/promises').then((fs) => fs.readFile(filePath));
    } catch {
      return err('INTERNAL', '读取播放列表文件失败');
    }
    const dir = filePath.includes('/') || filePath.includes('\\') ? filePath.slice(0, Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))) : null;
    const { refs, unmatched } = importM3u(content.toString('utf8'), dir, listTrackCatalog(db));
    if (refs.length === 0) {
      return ok({ imported: null, unmatched: unmatched.length, report: '没有可定位的音轨（音乐库中找不到对应文件）' });
    }
    const playlistId = catalogRepo.createPlaylist(basename.replace(/\.(m3u8?|m3u)$/i, '') || '导入歌单');
    for (const ref of refs) catalogRepo.addToPlaylist(playlistId, ref.ref);
    return ok({
      imported: { playlistId, name: basename.replace(/\.(m3u8?|m3u)$/i, ''), matched: refs.length },
      unmatched: unmatched.length,
    });
  });

  // 导出（QYP3-016/017）：保存对话框 → 生成内容 → 写盘。凭据永不内嵌。
  ipcMain.handle(IPC_CHANNELS.PLAYLIST.EXPORT_M3U8, async (_event, args: { id: number }) => {
    const id = Number(args?.id);
    if (!Number.isInteger(id) || id <= 0) return err('VALIDATION_FAILED', '参数不合法');
    return exportPlaylistFile(id, 'm3u8', catalogRepo);
  });

  ipcMain.handle(IPC_CHANNELS.PLAYLIST.EXPORT_XSPF, async (_event, args: { id: number }) => {
    const id = Number(args?.id);
    if (!Number.isInteger(id) || id <= 0) return err('VALIDATION_FAILED', '参数不合法');
    return ok(await exportPlaylistXspf(id, catalogRepo, catalogRepo.listPlaylists().find((p) => p.id === id)?.name ?? 'playlist'));
  });


  // 歌词（QYP3-019/021）：读歌词缓存（扫描期从标签落盘；无词返回 hasLyrics=false）
  ipcMain.handle(IPC_CHANNELS.MUSIC.GET_LYRICS, async (_event, args: { trackId: number }) => {
    const trackId = Number(args?.trackId);
    if (!Number.isInteger(trackId) || trackId <= 0) {
      return err('VALIDATION_FAILED', '参数不合法');
    }
    const content = await readLyricsCache(trackId, lyricsDir);
    return ok({ hasLyrics: content !== null, content });
  });

  // 服务器曲目歌词（QYP3-020b）：Jellyfin 10.9+ `/Audio/{id}/Lyrics` →
  // 归一成 LRC 文本（面板/桌面歌词与本地歌词共用同一份解析）。
  // 无词/端点不存在（Emby）/网络失败一律 hasLyrics=false，绝不阻塞播放。
  ipcMain.handle(
    IPC_CHANNELS.MUSIC.GET_SERVER_LYRICS,
    async (_event, args: { serverId: number; itemId: string }) => {
      const serverId = Number(args?.serverId);
      const itemId = typeof args?.itemId === 'string' ? args.itemId.trim() : '';
      if (!Number.isInteger(serverId) || serverId <= 0 || !itemId) {
        return err('VALIDATION_FAILED', '参数不合法');
      }
      try {
        const binding = bindServerById(storage, secretStore, serverId);
        const client = createClient({
          type: binding.type,
          baseUrl: binding.baseUrl,
          apiKey: binding.apiKey,
          userId: binding.userId,
        });
        const lyrics = await client.getLyrics(itemId);
        const content = lyricsToLrc(lyrics);
        return ok({ hasLyrics: content !== null, content });
      } catch (e) {
        console.error('[LYRICS] 服务器歌词获取失败:', e instanceof Error ? e.message : e);
        return ok({ hasLyrics: false, content: null });
      }
    }
  );

  // 手动导入歌词（QYP3-021）：.lrc 文本 → <lyricsDir>/<trackId>.lrc。
  // 歌词属人工编辑资产（受保护分区），导入即覆盖，返回内容供面板立即显示。
  ipcMain.handle(IPC_CHANNELS.MUSIC.IMPORT_LYRICS, async (_event, args: { trackId: number }) => {
    const trackId = Number(args?.trackId);
    if (!Number.isInteger(trackId) || trackId <= 0) {
      return err('VALIDATION_FAILED', '参数不合法');
    }
    const { dialog } = await import('electron');
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [
        { name: '歌词', extensions: ['lrc', 'txt'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return ok({ imported: false, content: null });
    }
    const { readFile } = await import('node:fs/promises');
    let content: string;
    try {
      content = await readFile(result.filePaths[0], 'utf8');
    } catch {
      return err('INTERNAL', '读取歌词文件失败');
    }
    if (content.trim().length === 0) {
      return err('VALIDATION_FAILED', '歌词文件为空');
    }
    const saved = await saveLyricsFromTags(trackId, lyricsDir, content);
    if (!saved) {
      return err('INTERNAL', '保存歌词失败');
    }
    return ok({ imported: true, content });
  });

  // ---- 桌面歌词（ADR-0008 / QYP3-022）------------------------------------
  // 样式与位置持久化在 app_config：deskLyrics.fontSize / .locked / .pos
  const DESKLYRICS_KEY = {
    fontSize: 'deskLyrics.fontSize',
    locked: 'deskLyrics.locked',
    pos: 'deskLyrics.pos',
  };
  function readDeskLyricsConfig(): { fontSize: number; locked: boolean; pos: { x: number; y: number } | null } {
    let pos: { x: number; y: number } | null = null;
    try {
      const raw = storage.getConfig(DESKLYRICS_KEY.pos);
      if (raw) {
        const parsed = JSON.parse(raw) as { x?: number; y?: number };
        if (Number.isFinite(parsed.x) && Number.isFinite(parsed.y)) {
          pos = { x: Number(parsed.x), y: Number(parsed.y) };
        }
      }
    } catch {
      pos = null;
    }
    const fontSize = Number(storage.getConfig(DESKLYRICS_KEY.fontSize));
    return {
      fontSize: Number.isFinite(fontSize) && fontSize > 0 ? fontSize : 28,
      locked: storage.getConfig(DESKLYRICS_KEY.locked) !== 'false',
      pos,
    };
  }
  setDeskLyricsPersistence({
    onMove: (pos) => {
      try {
        storage.setConfig(DESKLYRICS_KEY.pos, JSON.stringify(pos));
      } catch {
        // 位置丢失不影响功能
      }
    },
  });

  ipcMain.handle(IPC_CHANNELS.DESKLYRICS.SHOW, () => {
    if (!isDesktopLyricsSupported()) {
      return err('UNAVAILABLE', '当前会话不支持透明置顶窗口（Wayland 会话下不可用）');
    }
    const cfg = readDeskLyricsConfig();
    openDeskLyrics({ ...(cfg.pos ?? {}), style: { fontSize: cfg.fontSize, locked: cfg.locked } });
    setDeskLyricsStyle({ fontSize: cfg.fontSize, locked: cfg.locked });
    return ok({ open: true, ...cfg });
  });

  ipcMain.handle(IPC_CHANNELS.DESKLYRICS.HIDE, () => {
    closeDeskLyrics();
    return ok({ open: false });
  });

  ipcMain.handle(
    IPC_CHANNELS.DESKLYRICS.STATE,
    (_event, args: { title?: string; content?: string | null; position?: number; isPlaying?: boolean }) => {
      pushDeskLyricsState({
        title: typeof args?.title === 'string' ? args.title : '',
        content: typeof args?.content === 'string' ? args.content : null,
        position: Number(args?.position) || 0,
        isPlaying: args?.isPlaying === true,
      });
      return ok({ delivered: isDeskLyricsOpen() });
    }
  );

  ipcMain.handle(IPC_CHANNELS.DESKLYRICS.SET_STYLE, (_event, args: { fontSize?: number; locked?: boolean }) => {
    const current = readDeskLyricsConfig();
    const fontSize = Number(args?.fontSize);
    const next = {
      fontSize: Number.isFinite(fontSize) && fontSize > 0 ? Math.round(fontSize) : current.fontSize,
      locked: typeof args?.locked === 'boolean' ? args.locked : current.locked,
    };
    try {
      storage.setConfig(DESKLYRICS_KEY.fontSize, String(next.fontSize));
      storage.setConfig(DESKLYRICS_KEY.locked, next.locked ? 'true' : 'false');
    } catch {
      // 持久化失败不阻断当次生效
    }
    setDeskLyricsStyle(next);
    return ok(next);
  });

  ipcMain.handle(IPC_CHANNELS.MUSIC.SET_ENGINE_ACTIVE, (_event, value: unknown) => {
    setMusicEngineActive(value === true);
    return ok({ value: Boolean(value) });
  });

  ipcMain.handle(IPC_CHANNELS.MUSIC.GET_TRACKS, (_event, args: { offset?: number; limit?: number }) => {
    const limit = Math.min(Math.max(Number(args?.limit) || 200, 1), 200); // 页 ≤200（§16.4）
    const offset = Math.max(Number(args?.offset) || 0, 0);
    const sourceIds = catalogRepo.listMusicSourceIds();
    return ok({ tracks: catalogRepo.listMusicTracksPaged(sourceIds, offset, limit) });
  });

  // 歌手聚合 + 单歌手专辑（QYP3-008a）
  ipcMain.handle(IPC_CHANNELS.MUSIC.GET_ARTISTS, (_event, args: { limit?: number }) => {
    const limit = Math.min(Math.max(Number(args?.limit) || 200, 1), 200);
    const sourceIds = catalogRepo.listMusicSourceIds();
    return ok({ artists: catalogRepo.listMusicArtists(sourceIds, limit) });
  });

  ipcMain.handle(
    IPC_CHANNELS.MUSIC.GET_ARTIST_ALBUMS,
    (_event, args: { albumartist: string; limit?: number }) => {
      const limit = Math.min(Math.max(Number(args?.limit) || 200, 1), 200);
      if (typeof args?.albumartist !== 'string') {
        return err('VALIDATION_FAILED', '参数不合法');
      }
      const sourceIds = catalogRepo.listMusicSourceIds();
      return ok({ albums: catalogRepo.listArtistAlbums(sourceIds, args.albumartist, limit) });
    }
  );

  // 收藏（QYP3-008a）：music 条目不在 catalog_user_state 域内，标记落在音轨行
  ipcMain.handle(IPC_CHANNELS.MUSIC.GET_FAVORITES, (_event, args: { limit?: number }) => {
    const limit = Math.min(Math.max(Number(args?.limit) || 200, 1), 200);
    const sourceIds = catalogRepo.listMusicSourceIds();
    return ok({ tracks: catalogRepo.listFavoriteMusicTracks(sourceIds, limit) });
  });

  ipcMain.handle(
    IPC_CHANNELS.MUSIC.SET_FAVORITE,
    (_event, args: { trackId: number; favorite: boolean }) => {
      const trackId = Number(args?.trackId);
      if (!Number.isInteger(trackId) || trackId <= 0) {
        return err('VALIDATION_FAILED', '参数不合法');
      }
      const favorite = args?.favorite === true;
      catalogRepo.setMusicFavorite(trackId, favorite);
      return ok({ trackId, favorite });
    }
  );

  // 播放期回填真实时长（QYP3-052）：渲染层在拿到真实 duration 后报一次，
  // 只对本地/WebDAV 曲目（服务器曲目 trackId = 0，不落本地库）
  ipcMain.handle(
    IPC_CHANNELS.MUSIC.SET_TRACK_DURATION,
    (_event, args: { trackId: number; duration: number }) => {
      const trackId = Number(args?.trackId);
      const duration = Number(args?.duration);
      if (!Number.isInteger(trackId) || trackId <= 0) {
        return err('VALIDATION_FAILED', '参数不合法');
      }
      if (!Number.isFinite(duration) || duration <= 0 || duration > 24 * 3600) {
        return err('VALIDATION_FAILED', '时长不合法');
      }
      catalogRepo.setMusicTrackDuration(trackId, duration);
      return ok({ trackId, duration });
    }
  );

  ipcMain.handle(IPC_CHANNELS.SKIP_SEGMENTS.GET_SETTINGS, () => {
    return ok({
      skipIntro: storage.getConfig('playback.skipIntro') !== 'false',
      skipOutro: storage.getConfig('playback.skipOutro') === 'true',
    });
  });
  ipcMain.handle(IPC_CHANNELS.SKIP_SEGMENTS.SET_SETTING, (_event, input: unknown) => {
    if (typeof input !== 'object' || input === null) return err('VALIDATION_FAILED', '参数不合法');
    const { key, enabled } = input as { key?: unknown; enabled?: unknown };
    if (key !== 'skipIntro' && key !== 'skipOutro') return err('VALIDATION_FAILED', '不支持的设置项');
    if (typeof enabled !== 'boolean') return err('VALIDATION_FAILED', '开关值不合法');
    storage.setConfig(`playback.${key}`, enabled ? 'true' : 'false');
    return ok({ key, enabled });
  });

  // 剧集自定义片头/片尾（migration 006，scope=series 整剧生效）。
  ipcMain.handle(IPC_CHANNELS.SKIP_SEGMENTS.GET_OVERRIDE, (_event, input: unknown) => {
    if (!isSkipOverrideRef(input)) return err('VALIDATION_FAILED', '引用不合法');
    const ref = input as { serverType: 'jellyfin' | 'emby'; serverId: number; itemId: string; seriesName: string };
    return ok({ override: storage.getSkipOverride(ref.serverType, ref.serverId, ref.itemId, ref.seriesName) });
  });
  ipcMain.handle(IPC_CHANNELS.SKIP_SEGMENTS.SET_OVERRIDE, (_event, input: unknown) => {
    if (!isSkipOverrideRef(input)) return err('VALIDATION_FAILED', '引用不合法');
    const ref = input as {
      serverType: 'jellyfin' | 'emby';
      serverId: number;
      itemId: string;
      seriesName: string;
      intro?: { start?: unknown; end?: unknown } | null;
      outro?: { start?: unknown; end?: unknown } | null;
    };
    const parseRange = (r: { start?: unknown; end?: unknown } | null | undefined) => {
      if (typeof r !== 'object' || r === null) return null;
      const start = Number(r.start);
      const end = Number(r.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < 0 || start >= end) return null;
      return { start, end };
    };
    // 两个类型都未提供/非法 → 整行清除语义（storage 写 null 值）。
    storage.setSkipOverride(ref.serverType, ref.serverId, 'series', ref.seriesName, {
      intro: parseRange(ref.intro),
      outro: parseRange(ref.outro),
    });
    return ok({ saved: true });
  });

  // ---- Diagnostics (QYP2-037): redacted, shareable snapshot ----
  // qy-file://audio 协议桥注册（QYP3-010）：local 来源 → resolveInside
  // 适配器；每次调用即时查表（来源删除即刻失效，无陈旧句柄）。
  {
    registerAudioSourceProvider((sourceId) => {
      const source = catalogRepo.getSource(sourceId);
      if (!source || source.kind !== 'local') return undefined;
      return LocalSourceAdapter.fromSource(sourceId, source.root);
    });
  }

  const cacheManager = new CacheManager();
  cacheManager.register(
    { id: 'probe', description: '技术信息探测缓存（内存 LRU+TTL）', rootDir: null, quota: { maxEntries: 256 }, sweepable: false },
    []
  );
  cacheManager.register(
    {
      id: 'plugin-response',
      description: '插件响应磁盘缓存（mtime-LRU，TTL 7 天）',
      rootDir: join(app.getPath('userData'), 'scrape-cache'),
      quota: { maxEntries: 4096 },
      sweepable: true,
    },
    []
  );
  cacheManager.register(
    {
      id: 'subtitles',
      description: '人工导入字幕（受保护，永不清扫）',
      rootDir: join(app.getPath('userData'), 'subtitles'),
      quota: {},
      sweepable: false,
    },
    []
  );
  // QYP3-005：音乐封面（派生缓存，可清扫后按需再生成）
  registerCoversPartition(cacheManager, join(app.getPath('userData'), 'covers'));
  // QYP3-019：歌词（人工可编辑，永不清扫）
  registerLyricsPartition(cacheManager, lyricsDir);

  // 离线频谱（QYP3-050）：mpv 音源的真频谱，ffmpeg 预算后落盘；派生缓存，
  // 可清扫（删了下次播放重算）。没有 ffmpeg 的机器上这个目录永远是空的。
  const spectrumDir = join(app.getPath('userData'), 'music-spectrum');
  cacheManager.register(
    {
      id: 'music-spectrum',
      description: '离线频谱（mpv 音源，ffmpeg 预算；可清扫后重算）',
      rootDir: spectrumDir,
      quota: { maxBytes: MUSIC_SPECTRUM_QUOTA_BYTES },
      sweepable: true,
    },
    []
  );
  musicSpectrum = new MusicSpectrumService({
    dir: spectrumDir,
    quotaBytes: MUSIC_SPECTRUM_QUOTA_BYTES,
    sweep: () => cacheManager.sweep('music-spectrum', MUSIC_SPECTRUM_QUOTA_BYTES),
    onSettled: (event) => {
      const win = getMainWindow?.();
      if (win && !win.isDestroyed()) {
        win.webContents.send(IPC_CHANNELS.MUSIC.ON_SPECTRUM_READY, event);
      }
    },
  });
  ipcMain.handle(IPC_CHANNELS.MUSIC.GET_SPECTRUM, () => {
    // 非关键路径：永远返回结果（ready/pending/unavailable/failed/none），
    // 不抛错、不弹窗——拿不到就是"这条曲目还是没有频谱"。
    return ok(musicSpectrum?.get() ?? { status: 'none' });
  });

  ipcMain.handle(IPC_CHANNELS.DIAGNOSTICS.SUMMARY, () => {
    return ok(
      buildDiagnosticsSummary({
        appVersion: app.getVersion(),
        servers: storage.getServers(),
        cacheManager,
        subsystems: [
          { id: 'sqlite', ok: Boolean(db), detail: '已打开' },
          { id: 'player', ok: player.isReady(), detail: player.isReady() ? 'mpv 就绪' : '未启动' },
        ],
      })
    );
  });

  // ---- Unified cross-source queries (QYP2-036, plan §11/§16.4) ----
  const unified = createUnifiedQueryService({
    db,
    onlineContinueWatching: async () => {
      const rows: OnlineContinueInput[] = [];
      for (const { config, client } of getActiveServerClients(storage, secretStore)) {
        try {
        const items = await client.getContinueWatching();
        for (const item of items) {
          rows.push({
            provider: config.type as 'jellyfin' | 'emby',
            serverId: config.id,
            itemId: item.Id,
            title: item.Name,
            kind: item.Type,
            year: item.ProductionYear,
            rating: item.CommunityRating,
            positionTicks: item.UserData?.PlaybackPositionTicks,
            runtimeTicks: item.RunTimeTicks,
            primaryTag: item.ImageTags?.Primary,
            updatedAt: item.UserData?.LastPlayedDate ? Date.parse(item.UserData.LastPlayedDate) || 0 : 0,
          });
        }
        } catch (err) {
          console.error(`[UNIFIED] 服务器 ${config.name} 继续观看失败:`, err instanceof Error ? err.message : err);
        }
      }
      return rows;
    },
    onlineSearch: async (query: string) => {
      const rows: OnlineContinueInput[] = [];
      for (const { config, client } of getActiveServerClients(storage, secretStore)) {
        try {
          const items = await client.getItems(undefined, {
            searchTerm: query,
            includeItemTypes: 'Movie,Series,Episode',
            recursive: true,
            limit: 100,
          });
          for (const item of items) {
            rows.push({
              provider: config.type as 'jellyfin' | 'emby',
              serverId: config.id,
              itemId: item.Id,
              title: item.Name,
              kind: item.Type,
              year: item.ProductionYear,
              rating: item.CommunityRating,
              primaryTag: item.ImageTags?.Primary,
            });
          }
        } catch (err) {
          console.error(`[UNIFIED] 服务器 ${config.name} 搜索失败:`, err instanceof Error ? err.message : err);
        }
      }
      return rows;
    },
    onlineRecent: async () => {
      const rows: OnlineContinueInput[] = [];
      for (const { config, client } of getActiveServerClients(storage, secretStore)) {
        try {
          const items = await client.getItems(undefined, {
            sortBy: 'DateCreated',
            sortOrder: 'Descending',
            includeItemTypes: 'Movie,Series',
            recursive: true,
            limit: 50,
          });
          for (const item of items) {
            rows.push({
              provider: config.type as 'jellyfin' | 'emby',
              serverId: config.id,
              itemId: item.Id,
              title: item.Name,
              kind: item.Type,
              year: item.ProductionYear,
              rating: item.CommunityRating,
              primaryTag: item.ImageTags?.Primary,
              updatedAt: item.DateCreated ? Date.parse(item.DateCreated) || 0 : 0,
            });
          }
        } catch (err) {
          console.error(`[UNIFIED] 服务器 ${config.name} 最近添加失败:`, err instanceof Error ? err.message : err);
        }
      }
      return rows;
    },
  });

  ipcMain.handle(IPC_CHANNELS.UNIFIED.CONTINUE_WATCHING, async (_event, limit: unknown) => {
    const clean = typeof limit === 'number' && limit > 0 ? Math.floor(limit) : 40;
    return ok(await unified.continueWatching(clean));
  });

  ipcMain.handle(IPC_CHANNELS.UNIFIED.RECENT, async (_event, limit: unknown) => {
    const clean = typeof limit === 'number' && limit > 0 ? Math.floor(limit) : 24;
    return ok(await unified.recent(clean));
  });

  ipcMain.handle(IPC_CHANNELS.UNIFIED.SEARCH, async (_event, query: unknown, page: unknown) => {
    if (typeof query !== 'string') return err('VALIDATION_FAILED', '搜索词不合法');
    const clean = typeof page === 'number' && page >= 1 ? Math.floor(page) : 1;
    return ok(await unified.search(query, clean));
  });
  // §12.3: 可在设置中关闭（app_config playback.autoNext，默认开）。
  ipcMain.handle(IPC_CHANNELS.AUTO_NEXT.GET_ENABLED, () => {
    return ok({ enabled: storage.getConfig('playback.autoNext') !== 'false' });
  });
  ipcMain.handle(IPC_CHANNELS.AUTO_NEXT.SET_ENABLED, (_event, enabled: unknown) => {
    if (typeof enabled !== 'boolean') return err('VALIDATION_FAILED', '开关值不合法');
    storage.setConfig('playback.autoNext', enabled ? 'true' : 'false');
    return ok({ enabled });
  });

  // 剧集自定义片头/片尾（migration 006，scope=series 整剧生效）。
  function isSkipOverrideRef(input: unknown): boolean {
    if (typeof input !== 'object' || input === null) return false;
    const ref = input as { serverType?: unknown; serverId?: unknown; itemId?: unknown; seriesName?: unknown };
    return (
      (ref.serverType === 'jellyfin' || ref.serverType === 'emby') &&
      typeof ref.serverId === 'number' && Number.isInteger(ref.serverId) &&
      typeof ref.itemId === 'string' && ref.itemId.length > 0 && ref.itemId.length <= 128 &&
      typeof ref.seriesName === 'string' && ref.seriesName.length > 0 && ref.seriesName.length <= 256
    );
  }

  // Player handlers
  // mpv af 复位跟踪（音乐 af 跨 loadfile 持久，视频加载需复位）
  let mpvAfWasSet = false;

  ipcMain.handle(IPC_CHANNELS.PLAYER.LOAD_FILE, async (
    _event,
    path: string,
    startPosition?: number,
    httpHeaders?: string,
    mediaContext?: { mediaType: string; mediaId: string; title?: string; seriesName?: string; seasonNumber?: number; episodeNumber?: number; mediaSourceId?: string; serverId?: number },
    streamSessionId?: string,
    audioChain?: {
      eqGains?: number[];
      /** ReplayGain 模式（off/track/album）＋高级项（P2）。 */
      replaygain?: string;
      replaygainPreamp?: number;
      replaygainFallback?: number;
      replaygainClip?: boolean;
    }
  ) => {
    if (!player.isReady()) {
      await player.start();
    }

    // 音乐音频链（QYP3-012 + P2 ReplayGain 高级）：仅音乐加载时设置，
    // 视频加载复位（af 跨 loadfile 持久）。必须在 mpv 启动后设置。
    if (audioChain) {
      const gains = sanitizeEqGains(audioChain.eqGains);
      void player.applyMusicAudioChain(
        mpvAudioFilterFromEq(gains) ?? '',
        normalizeReplayGain(audioChain)
      );
      mpvAfWasSet = true;
      setMpvMusicActive(true); // QYP3-026：音乐会话（媒体键/状态转发按音乐走）
      // QYP3-032：音乐经 mpv 解码时压掉 mpv 窗口（含内嵌封面 video 轨）
      void player.setVideoWindowForMusic(true);
    } else {
      if (mpvAfWasSet) {
        void player.applyMusicAudioChain('', null);
        mpvAfWasSet = false;
      }
      // QYP3-026：非音乐加载即结束音乐会话。否则音乐控制条会一直挂在
      // 视频上，且 renderer 引擎的音乐还在继续出声（两者同时播放）。
      if (isMusicSessionActive()) {
        clearMusicSession();
        if (!_event.sender.isDestroyed()) {
          _event.sender.send(IPC_CHANNELS.MUSIC.ON_SESSION_END);
        }
      }
      // QYP3-032：视频恢复 mpv 窗口（音乐路径压过，这里复位）
      void player.setVideoWindowForMusic(false);
    }

    // Real headers never cross the IPC boundary: the renderer hands back the
    // opaque session id it received from GET_STREAM_URL.
    const stashedHeaders = streamSessionId ? streamHeaders.take(streamSessionId) : undefined;
    const effectiveHeaders = stashedHeaders ?? httpHeaders;

    // 离线频谱（QYP3-050）：只有"音乐且走 mpv"才需要（renderer 引擎有实时频谱）。
    // 这里复用**同一份** URL 与认证头——绝不再 take 一次 streamHeaders（单次
    // 消费语义，再取会让 mpv 拿到空头），也不重新 resolve（服务器会多一次网络）。
    if (audioChain) {
      if (decodeConfigValue(storage.getConfig('playback.offlineSpectrum')) === false) {
        musicSpectrum?.setCurrent(null);
      } else {
        // 注意：不传 startSec——续播位置不是分轨偏移，频谱矩阵按**整首**的绝对
        // 时间轴建，渲染层才能直接用播放进度索引。
        musicSpectrum?.setCurrent({
          mediaId: `${mediaContext?.mediaType ?? 'local'}:${mediaContext?.mediaId ?? path}`,
          url: path,
          headers: effectiveHeaders,
        });
      }
    } else {
      // 视频/其他媒体接管 → 音乐频谱会话结束（别再占着 CPU 解码）
      musicSpectrum?.setCurrent(null);
    }

    // Determine if this is a local file
    const isLocal = isLocalFilePath(path);

    if (isLocal) {
      // Ensure local_media record exists
      const title = extractTitleFromPath(path);
      storage.upsertLocalMedia({ path, title });
      const localMedia = storage.getLocalMediaByPath(path);
      const localMediaId = localMedia?.id;

      // Set current media for progress tracking
      playbackStateManager!.setCurrentMedia('local', path, title, undefined, localMediaId);

      // Query resume position
      const resumePosition = playbackStateManager!.getResumePosition('local', path);
      // Explicit 0 = 从头播放（§12.1：不清历史、不回退旧位置）；
      // undefined = 未指定 → 走续播解析。
      const finalPosition = startPosition !== undefined
        ? (startPosition > 0 ? startPosition : 0)
        : (resumePosition > 0 ? resumePosition : undefined);

      await player.loadFile(path, finalPosition, effectiveHeaders);
      // Auto-next dedupe anchor only after the load actually succeeded
      // (a failed loadfile must not re-point the eof gate).
      autoNext.markLoaded({ mediaType: 'local', mediaId: path });
      // QYP2-021: attach sidecar/imported subtitles (catalog items only).
      // sub-add before mpv's file-loaded event fails on 0.29, so wait for
      // it first; on timeout attempt once anyway (best-effort, per-track
      // isolated - never blocks playback, plan §13).
      if (!(await player.waitForFileLoaded(5000))) {
        await injectAttachedSubtitles(player, catalogRepo, mediaContext?.mediaType, mediaContext?.mediaId);
      }
    } else {
      // Online streaming: key progress by the ITEM id (not the stream URL,
      // which differs between direct/transcode and would split the record)
      const mediaType = mediaContext?.mediaType || 'jellyfin';
      const mediaId = mediaContext?.mediaId || path;
      // 服务端播放会话：起播先报告 Sessions/Playing，Progress/Stopped
      // 携带同一 PlaySessionId 才会被 Emby/Jellyfin 接受（缺失 → 400，
      // UserData 永不更新——实测教训）。
      const playSessionId = randomUUID();
      playbackStateManager!.setCurrentMedia(
        mediaType,
        mediaId,
        mediaContext?.title,
        mediaContext?.seriesName,
        undefined,
        mediaContext?.seasonNumber,
        mediaContext?.episodeNumber,
        mediaContext?.mediaSourceId,
        playSessionId
      );
      // fire-and-forget：报告失败只损失服务端进度展示，绝不阻塞播放。
      // 服务器路由：mediaContext.serverId（解析时确定）精确匹配；
      // 旧上下文无 serverId 时回退同类型活跃服务器。
      void (async () => {
        try {
          const servers = storage.getServers().filter(
            (s) => s.is_active && s.type === mediaType && s.user_id &&
              (mediaContext?.serverId === undefined || s.id === mediaContext.serverId)
          );
          for (const server of servers) {
            const apiKey = resolveServerApiKey(server, secretStore);
            if (!apiKey) continue;
            const client = createClient({
              type: server.type as 'jellyfin' | 'emby',
              baseUrl: server.base_url,
              apiKey,
              userId: server.user_id,
            });
            await client.reportPlayingStart(
              mediaId,
              mediaContext?.mediaSourceId || mediaId,
              playSessionId
            );
          }
        } catch {
          // 静默：进度回传失败不影响本地播放与进度保存
        }
      })();
      // Resume from last position (same rule as local: skip if nearly finished)
      const resumePosition = playbackStateManager!.getResumePosition(mediaType, mediaId);
      // Explicit 0 = 从头播放（§12.1：不清历史、不回退旧位置）；
      // undefined = 未指定 → 走续播解析。
      const finalPosition = startPosition !== undefined
        ? (startPosition > 0 ? startPosition : 0)
        : (resumePosition > 0 ? resumePosition : undefined);
      await player.loadFile(path, finalPosition, effectiveHeaders);
      // Auto-next anchor after successful load (same rule as local).
      autoNext.markLoaded({
        mediaType,
        mediaId,
        seriesName: mediaContext?.seriesName ?? null,
        seasonNumber: mediaContext?.seasonNumber ?? null,
        episodeNumber: mediaContext?.episodeNumber ?? null,
      });
      // 跳过分段：换媒体重置一次性标记与旧集分段（仅剧集有分段）。仅剧集
      // （带 seriesName）留存；电影/本地/WebDAV 直接清空。
      skipController.begin(
        mediaContext?.seriesName ? mediaId : null
      );
      // QYP2-021: WebDAV streams accept local subtitles too (plan §13);
      // same file-loaded gate as the local branch.
      if (!(await player.waitForFileLoaded(5000))) {
        await injectAttachedSubtitles(player, catalogRepo, mediaContext?.mediaType, mediaContext?.mediaId);
      }
    }
  });

  // Sync playback progress back to Emby/Jellyfin servers
  playbackStateManager.setOnProgressSaved(async (payload) => {
    if (payload.mediaType !== 'jellyfin' && payload.mediaType !== 'emby') return;

    const servers = storage.getServers().filter((s) => s.is_active && s.type === payload.mediaType && s.user_id);
    if (servers.length === 0) return;

    for (const server of servers) {
      const apiKey = resolveServerApiKey(server, secretStore);
      if (!apiKey) continue;
      try {
        const client = createClient({
          type: server.type as 'jellyfin' | 'emby',
          baseUrl: server.base_url,
          apiKey,
          userId: server.user_id,
        });
        // 收尾（disconnect/crashed/退出）一律走 Stopped：Emby 仅在
        // Stopped 时把 PositionTicks 写入 UserData。
        await client.reportProgress(
          payload.mediaId,
          payload.mediaSourceId || payload.mediaId,
          Math.floor(payload.position * 10000000),
          payload.isFinished || payload.final === true,
          !player.getState().isPlaying,
          'DirectPlay',
          payload.playSessionId
        );
      } catch (err) {
        console.error(`[SYNC-PROGRESS] ${server.name}:`, err);
      }
    }
  });

  // Unified playback entry (QYP2-015): the renderer passes a MediaRef and
  // receives a ready-to-load payload. URLs are built main-side; credentials
  // travel as an opaque stream session. Strict per-serverId routing.
  ipcMain.handle(
    IPC_CHANNELS.PLAYER.RESOLVE,
    async (
      _event,
      ref: unknown,
      options: {
        mode?: 'direct' | 'transcode';
        mediaSourceId?: string;
        /** 渲染层 direct 解码失败后的 mpv 兜底（ADR-0007），必须透传。 */
        engineForce?: 'mpv';
      } = {}
    ): Promise<ActionResult<unknown>> => {
      if (!isMediaRef(ref)) {
        return err('VALIDATION_FAILED', '播放引用不合法');
      }
      const mode = options?.mode === 'transcode' ? 'transcode' : 'direct';
      const mediaSourceId =
        typeof options?.mediaSourceId === 'string' && options.mediaSourceId.length <= 128
          ? options.mediaSourceId
          : undefined;
      try {
        const resolution = await resolvePlayback(
          {
            db,
            storage,
            secretStore,
            streamHeaders,
            streamRoutes,
            getResumePosition: (mediaType: string, mediaId: string) =>
              playbackStateManager!.getResumePosition(mediaType, mediaId),
            createOnlineClient: createClient,
            getEnginePreference: () =>
              storage.getConfig('playback.musicEngine') === 'compat-first'
                ? 'compat-first'
                : 'spectrum-first',
            fetchSkipSegments: ({ client, serverId, serverType, itemId, seriesName }) => {
              // 自定义设定优先（migration 006）：有则直接采用，不再询问服务器。
              const custom = seriesName
                ? storage.getSkipOverride(serverType, serverId, itemId, seriesName)
                : null;
              if (custom) {
                const customSegments: SkipSegment[] = [];
                if (custom.intro) customSegments.push({ type: 'intro', start: custom.intro.start, end: custom.intro.end });
                if (custom.outro) customSegments.push({ type: 'outro', start: custom.outro.start, end: custom.outro.end });
                if (customSegments.length > 0) {
                  skipController.setSegments(itemId, customSegments);
                  return;
                }
              }
              void client
                .getMediaSegments(itemId)
                .then((raw) => {
                  const segments = parseMediaSegments(raw);
                  if (segments.length > 0) skipController.setSegments(itemId, segments);
                })
                .catch(() => {}); // 旧版服务器/Emby 无端点 → 无分段，静默
            },
          },
          {
            ref,
            mode,
            ...(mediaSourceId ? { mediaSourceId } : {}),
            ...(options?.engineForce === 'mpv' ? { engineForce: 'mpv' as const } : {}),
          }
        );
        return ok(resolution);
      } catch (e) {
        if (e instanceof ResolverError) {
          if (e.code === 'SERVER_NOT_FOUND' || e.code === 'ITEM_NOT_FOUND') {
            return err('NOT_FOUND', e.message);
          }
          if (e.code === 'NO_CREDENTIAL') {
            return err('AUTH_REQUIRED', e.message);
          }
          return err('UNAVAILABLE', e.message, { retryable: true });
        }
        console.error('[PLAYBACK-RESOLVE] 解析失败:', e instanceof Error ? e.message : e);
        return err('INTERNAL', '解析播放地址失败');
      }
    }
  );

  // QYP2-019: technical-info probe. Reuses the resolver so credentialed
  // targets (WebDAV Basic / transcode tokens) keep their headers main-side;
  // the renderer only sees the probe outcome. Failures must never block
  // playback — this channel is purely informational.
  ipcMain.handle(
    IPC_CHANNELS.PLAYER.PROBE_ITEM,
    async (_event, input: ProbeItemInput): Promise<ActionResult<unknown>> => {
      if (!input || typeof input !== 'object' || !isMediaRef(input.ref)) {
        return err('VALIDATION_FAILED', '探测引用不合法');
      }
      const mode = input.mode === 'transcode' ? 'transcode' : 'direct';
      try {
        const resolution = await resolvePlayback(
          {
            db,
            storage,
            secretStore,
            streamHeaders,
            streamRoutes,
            getResumePosition: (mediaType: string, mediaId: string) =>
              playbackStateManager!.getResumePosition(mediaType, mediaId),
            createOnlineClient: createClient,
          },
          // 探测要的是可直接抓取的真实 URL，与最终用哪个引擎无关；强制 mpv
          // 分支可以避开 qy-stream 代理（主进程探测拿不到自定义协议）。
          { ref: input.ref, mode, engineForce: 'mpv' }
        );
        // take() is single-use; a later playback resolve stashes fresh
        // headers, so consuming the probe's own session is safe.
        const stashedHeaders = resolution.streamSessionId
          ? streamHeaders.take(resolution.streamSessionId)
          : undefined;
        const outcome = await mediaProbeService.probe({
          target: resolution.url,
          fingerprint: input.fingerprint ?? resolution.mediaContext.mediaId,
          ...(stashedHeaders ? { httpHeaders: [stashedHeaders] } : {}),
        });
        return ok(outcome);
      } catch (e) {
        if (e instanceof ResolverError) {
          if (e.code === 'SERVER_NOT_FOUND' || e.code === 'ITEM_NOT_FOUND') {
            return err('NOT_FOUND', e.message);
          }
          if (e.code === 'NO_CREDENTIAL') {
            return err('AUTH_REQUIRED', e.message);
          }
          return err('UNAVAILABLE', e.message, { retryable: true });
        }
        return err('INTERNAL', '探测技术信息失败');
      }
    }
  );

  ipcMain.handle(IPC_CHANNELS.PLAYER.CONTROL, async (_event, action: string, ...args: unknown[]) => {
    switch (action) {
      case 'play':
      case 'resume':
        await player.resume();
        break;
      case 'pause':
        await player.pause();
        break;
      case 'stop':
        // QYP3-067：mpv stop 卸载当前文件（音乐引擎切换 / 队尾停）。
        // 先收尾保存（final=true，服务端走 Stopped）再清媒体上下文——
        // mpv 已无播放，10s 定时器不能再对旧媒体反复保存
        await player.stop();
        playbackStateManager?.saveProgressNow();
        playbackStateManager?.clearCurrentMedia();
        break;
      case 'toggle-pause':
        await player.togglePause();
        break;
      case 'seek':
        await player.seek(args[0] as number, (args[1] as 'relative' | 'absolute') || 'absolute');
        break;
      case 'volume':
        await player.setVolume(args[0] as number);
        break;
      case 'fullscreen':
        await player.setFullscreen(args[0] as boolean);
        break;
      case 'aspect-ratio':
        await player.setAspectRatio(args[0] as string);
        break;
      case 'cycle-audio':
        await player.cycleAudio();
        break;
      case 'cycle-sub':
        await player.cycleSub();
        break;
      case 'set-audio':
        await player.setTrack('aid', args[0] as number);
        break;
      case 'set-sub':
        await player.setTrack('sid', args[0] as number);
        break;
      case 'set-ontop':
        await player.setOntop(args[0] as boolean);
        break;
      case 'set-maximized':
        await player.setMaximized(args[0] as boolean);
        break;
      case 'set-window-scale':
        await player.setWindowScale(args[0] as number);
        break;
      case 'cycle-subtitle':
        await player.cycleSubtitle();
        break;
      case 'add-subtitle':
        await player.addSubtitle(args[0] as string);
        break;
      case 'subtitle-delay':
        await player.setSubtitleDelay(args[0] as number);
        break;
      default:
        throw new Error(`Unknown player control action: ${action}`);
    }
  });

  ipcMain.handle(IPC_CHANNELS.PLAYER.GET_STATE, () => {
    return player.getState();
  });

  ipcMain.handle(IPC_CHANNELS.PLAYER.GET_TRACKS, async () => {
    if (!player.isReady()) return [];
    try {
      return await player.getTracks();
    } catch {
      return [];
    }
  });

  // Library handlers
  ipcMain.handle(IPC_CHANNELS.LIBRARY.OPEN_FILE, async () => {
    const { dialog } = await import('electron');
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [
        { name: '视频文件', extensions: ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'm2ts', 'ts', 'flv', 'webm'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle(IPC_CHANNELS.LIBRARY.OPEN_FOLDER, async () => {
    const { dialog } = await import('electron');
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
    });
    if (result.canceled) return [];

    const path = await import('path');
    const fs = await import('fs');
    const videoExts = new Set(['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.m2ts', '.ts', '.flv', '.webm']);

    const scanDir = (dir: string): string[] => {
      const files: string[] = [];
      try {
        const entries = fs.readdirSync(dir);
        for (const entry of entries) {
          const fullPath = path.join(dir, entry);
          const stat = fs.statSync(fullPath);
          if (stat.isDirectory()) {
            files.push(...scanDir(fullPath));
          } else if (videoExts.has(path.extname(entry).toLowerCase())) {
            files.push(fullPath);
          }
        }
      } catch {
        // Ignore inaccessible directories
      }
      return files;
    };

    return scanDir(result.filePaths[0]);
  });

  ipcMain.handle(IPC_CHANNELS.LIBRARY.GET_RECENTLY_PLAYED, (_event, limit?: number, opts?: { localOnly?: boolean }) => {
    return storage.getWatchHistory(limit, opts);
  });

  ipcMain.handle(IPC_CHANNELS.LIBRARY.CLEAR_HISTORY, () => {
    storage.clearWatchHistory();
  });

  ipcMain.handle(IPC_CHANNELS.LIBRARY.DELETE_HISTORY, (_event, mediaType: string, mediaId: string) => {
    storage.deleteWatchHistory(mediaType, mediaId);
  });

  // Progress handlers
  ipcMain.handle(IPC_CHANNELS.PROGRESS.SAVE, (_event, progress) => {
    storage.saveProgress(progress);
  });

  ipcMain.handle(IPC_CHANNELS.PROGRESS.GET, (_event, mediaType: string, mediaId: string) => {
    return storage.getProgress(mediaType, mediaId);
  });

  ipcMain.handle(IPC_CHANNELS.PROGRESS.GET_CONTINUE, (_event, limit?: number) => {
    return storage.getContinueWatching(limit);
  });

  // Settings handlers (secret config keys never cross the IPC boundary)
  ipcMain.handle(IPC_CHANNELS.SETTINGS.GET, (_event, key: string) => {
    assertNotSecretConfigKey(key);
    // 与 SETTINGS.SET 的 JSON.stringify 对称（见 config-value.ts）
    return decodeConfigValue(storage.getConfig(key));
  });

  ipcMain.handle(IPC_CHANNELS.SETTINGS.SET, (_event, key: string, value: unknown) => {
    assertNotSecretConfigKey(key);
    storage.setConfig(key, encodeConfigValue(value));
  });

  ipcMain.handle(IPC_CHANNELS.SETTINGS.GET_SERVERS, () => {
    return storage.getServers().map((server) => sanitizeServerForRenderer(server, secretStore));
  });

  // Capability flag (not a secret): whether secrets survive a restart. The
  // WebDAV form uses it to set storage expectations honestly (plan §8.3).
  ipcMain.handle(IPC_CHANNELS.SETTINGS.SECRETS_PERSISTENT, () => secretStore.isPersistent());

  ipcMain.handle(IPC_CHANNELS.SETTINGS.SAVE_SERVER, async (_event, server: ServerConfig & { password?: string }) => {
    // QYP2-015: the renderer passes the password (not a token). The main
    // process authenticates and stores the token in the SecretStore; tokens
    // never round-trip through the renderer anymore. Editing without a new
    // password keeps the stored secret untouched.
    let userId = server.userId;
    let freshToken: string | undefined;
    if (server.password) {
      if (!server.username) throw new Error('保存需要用户名');
      const client = createClient({
        type: server.type,
        baseUrl: server.baseUrl,
      });
      const auth = await client.authenticate(server.username, server.password);
      userId = auth.userId;
      freshToken = auth.accessToken;
    }
    const id = storage.saveServer({
      id: server.id,
      type: server.type,
      name: server.name ?? '',
      baseUrl: server.baseUrl,
      username: server.username,
      userId,
      isActive: server.isActive,
    });
    if (freshToken) {
      // Throws on readback failure; nothing is cleared before that.
      secretStore.setSecret(MEDIA_SERVER_NAMESPACE, String(id), freshToken);
    }
    return id;
  });

  ipcMain.handle(IPC_CHANNELS.SETTINGS.TEST_SERVER, async (_event, server: ServerConfig & { password?: string }) => {
    try {
      const client = createClient(server);
      await client.discover();
      // If credentials provided, verify them and return the token
      if (server.username && server.password) {
        try {
          await client.authenticate(server.username, server.password);
          // QYP2-015: credentials are verified here, but the token never
          // leaves the main process — SAVE_SERVER authenticates again and
          // stores directly into the SecretStore.
          return { ok: true };
        } catch (authErr) {
          console.error('[SERVER-TEST] 认证失败:', authErr);
          const status = (authErr as { response?: { status?: number } })?.response?.status;
          if (status === 401) {
            return { ok: false, error: '用户名或密码错误' };
          }
          if (status === 400) {
            return { ok: false, error: `认证请求被拒绝 (HTTP 400)，服务器返回: ${(authErr as { response?: { data?: string } })?.response?.data || '无详情'}` };
          }
          return { ok: false, error: `认证失败 (HTTP ${status ?? '无响应'})，请查看日志` };
        }
      }
      return { ok: true };
    } catch (err) {
      console.error('[SERVER-TEST] 连接失败:', err);
      return { ok: false, error: describeNetworkError(err) };
    }
  });

  // Online handlers
  ipcMain.handle(IPC_CHANNELS.ONLINE.GET_LIBRARIES, async (_event) => {
    const results = [];
    for (const serverConfig of storage.getServers().filter((s) => s.is_active)) {
      const apiKey = resolveServerApiKey(serverConfig, secretStore);
      if (!apiKey || !serverConfig.user_id) {
        results.push({
          serverId: serverConfig.id,
          serverName: serverConfig.name,
          serverType: serverConfig.type,
          baseUrl: serverConfig.base_url,
          views: [],
          error: '服务器未登录，请到媒体库中编辑并填写密码以完成登录',
        });
        continue;
      }
      try {
        const client = createClient({
          type: serverConfig.type as 'jellyfin' | 'emby',
          baseUrl: serverConfig.base_url,
          apiKey,
          userId: serverConfig.user_id,
        });
        const views = await client.getViews();
        results.push({
          serverId: serverConfig.id,
          serverName: serverConfig.name,
          serverType: serverConfig.type,
          baseUrl: serverConfig.base_url,
          views,
        });
      } catch (err) {
        console.error(`[GET-LIBRARIES] 服务器 ${serverConfig.name} 获取失败:`, err);
        results.push({
          serverId: serverConfig.id,
          serverName: serverConfig.name,
          serverType: serverConfig.type,
          baseUrl: serverConfig.base_url,
          views: [],
          error: describeNetworkError(err),
        });
      }
    }
    return results;
  });

  ipcMain.handle(IPC_CHANNELS.ONLINE.GET_ITEMS, async (_event, parentId: string, options?: unknown, serverId?: number) => {
    // QYP2-015: strict routing when the caller knows the server.
    if (Number.isInteger(serverId) && (serverId as number) > 0) {
      try {
        const binding = bindServerById(storage, secretStore, serverId as number);
        const client = createClient({
          type: binding.type,
          baseUrl: binding.baseUrl,
          apiKey: binding.apiKey,
          userId: binding.userId,
        });
        return await client.getItems(parentId, options as Record<string, unknown>);
      } catch (e) {
        console.error('[GET-ITEMS] 服务器列表获取失败:', e instanceof Error ? e.message : e);
        return [];
      }
    }
    for (const { config, client } of getActiveServerClients(storage, secretStore)) {
      try {
        return await client.getItems(parentId, options as Record<string, unknown>);
      } catch (err) {
        console.error(`[GET-ITEMS] 服务器 ${config.name} 获取失败:`, err);
        continue;
      }
    }
    return [];
  });

  ipcMain.handle(IPC_CHANNELS.ONLINE.GET_ITEM_DETAILS, async (_event, itemId: string, serverId?: number) => {
    // QYP2-015: when the caller knows the server, route strictly to it
    // (bindOnlineServer throws on mismatch; no cross-server fallthrough).
    if (Number.isInteger(serverId) && (serverId as number) > 0) {
      try {
        const binding = bindServerById(storage, secretStore, serverId as number);
        const client = createClient({
          type: binding.type,
          baseUrl: binding.baseUrl,
          apiKey: binding.apiKey,
          userId: binding.userId,
        });
        return await client.getItemDetails(itemId);
      } catch (e) {
        console.error('[GET-ITEM-DETAILS] 服务器详情获取失败:', e instanceof Error ? e.message : e);
        return null;
      }
    }
    for (const { config, client } of getActiveServerClients(storage, secretStore)) {
      try {
        return await client.getItemDetails(itemId);
      } catch (err) {
        console.error(`[GET-ITEM-DETAILS] 服务器 ${config.name} 获取详情失败:`, err);
        continue;
      }
    }
    console.error('[GET-ITEM-DETAILS] 所有服务器都无法获取详情');
    return null;
  });

  // 服务器歌单条目（P2 只读）：必须在 serverId 上严格路由——歌单 id
  // 只在其所属服务器上有意义，跨服务器试等于拿别人的 id 乱问。
  ipcMain.handle(
    IPC_CHANNELS.ONLINE.GET_PLAYLIST_ITEMS,
    async (_event, playlistId: string, serverId: number) => {
      if (typeof playlistId !== 'string' || !playlistId) return [];
      if (!Number.isInteger(serverId) || serverId <= 0) return [];
      try {
        const binding = bindServerById(storage, secretStore, serverId);
        const client = createClient({
          type: binding.type,
          baseUrl: binding.baseUrl,
          apiKey: binding.apiKey,
          userId: binding.userId,
        });
        return await client.getPlaylistItems(playlistId);
      } catch (e) {
        console.error('[GET-PLAYLIST-ITEMS] 服务器歌单获取失败:', e instanceof Error ? e.message : e);
        return [];
      }
    }
  );

  ipcMain.handle(IPC_CHANNELS.ONLINE.GET_STREAM_URL, async (_event, itemId: string, mediaSourceId: string, mode?: 'direct' | 'transcode') => {
    for (const { config, client } of getActiveServerClients(storage, secretStore)) {
      try {
        const playSessionId = randomUUID();
        const url = client.getStreamingUrl(
          itemId,
          mediaSourceId,
          mode === 'transcode' ? 'transcode' : 'direct',
          playSessionId
        );
        // Transcode segments carry no api_key - the player must send the
        // token as an HTTP header on every request (http-header-fields).
        // The header is stashed MAIN-SIDE and handed back via the opaque
        // streamSessionId: the token never crosses the IPC boundary.
        const sessionId = randomUUID();
        if (mode === 'transcode') {
          streamHeaders.stash(sessionId, `X-Emby-Token: ${config.api_key}`);
        }
        return { url, sessionId, mode: mode === 'transcode' ? 'transcode' : 'direct' };
      } catch (err) {
        console.error(`[GET-STREAM-URL] 服务器 ${config.name} 生成播放地址失败:`, err);
        continue;
      }
    }
    console.error('[GET-STREAM-URL] 所有服务器都无法生成播放地址');
    return null;
  });

  ipcMain.handle(IPC_CHANNELS.ONLINE.GET_CONTINUE_WATCHING, async () => {
    const results = [];
    for (const { config, client } of getActiveServerClients(storage, secretStore)) {
      try {
        const items = await client.getContinueWatching();
        results.push(...items.map((item) => ({ ...item, serverId: config.id, serverType: config.type })));
      } catch (err) {
        console.error(`[GET-CONTINUE-WATCHING] 服务器 ${config.name} 获取失败:`, err);
      }
    }
    return results;
  });

  ipcMain.handle(IPC_CHANNELS.ONLINE.SEARCH, async (_event, query: string, type?: string) => {
    const results = [];
    for (const { config, client } of getActiveServerClients(storage, secretStore)) {
      try {
        const items = await client.getItems(undefined, {
          searchTerm: query,
          includeItemTypes: type,
          recursive: true,
          limit: 50,
        });
        results.push(...items.map((item) => ({ ...item, serverId: config.id, serverType: config.type })));
      } catch (err) {
        console.error(`[SEARCH] 服务器 ${config.name} 搜索失败:`, err);
      }
    }
    return results;
  });

  // Cleanup on app quit
  ipcMain.handle('app:quit', () => {
    closeDatabase();
  });

  registerCatalogHandlers(db, secretStore, catalogRepo, pluginConfigService, scrapeJobs);
}

// ---------------------------------------------------------------------------
// Catalog sources (plan §7; QYP2-008)
// ---------------------------------------------------------------------------

const LOCAL_SOURCE_CAPABILITIES: SourceCapabilities = {
  canSeek: true,
  canDelete: false, // deletion arrives with the safe-delete service (QYP2-024)
  supportsEtag: false,
  supportsRange: true,
};

const activeScanJobs = new Map<number, ScanJobController>();
/** One push callback per registered sender; keyed by webContents id. */
const scanEventSenders = new Map<number, (event: ScanProgressEvent) => void>();

function broadcastScanEvent(event: ScanProgressEvent): void {
  for (const push of scanEventSenders.values()) {
    try {
      push(event);
    } catch (err) {
      // One failing listener must not break the others.
      console.error('[SCAN-EVENTS] 监听器异常:', err instanceof Error ? err.message : err);
    }
  }
}

/**
 * Minimal per-entry indexer so the 008 UI already shows real results.
 * QYP2-009 replaces this with recursive traversal and movie/series
 * classification; until then only root-level files are indexed.
 */
function registerCatalogHandlers(
  db: ReturnType<typeof getDatabase>,
  secretStore: SecretStore,
  catalogRepo: ReturnType<typeof createCatalogRepository>,
  pluginConfigService: PluginConfigService,
  scrapeJobs: ScrapeJobService
): void {
  // Legacy tables (watch_history) live in the same database; the series
  // resume merge (RESUME.SERIES) needs them alongside the catalog repo.
  const storage = createStorage(db);
  // Subtitle attachments live under <userData>/subtitles/<itemId>/
  // (plan §13). Interrupted imports leave .tmp- files; sweep them once at
  // startup (restart recovery, QYP2-020).
  const subtitleManagedRoot = join(app.getPath('userData'), 'subtitles');
  const subtitleService = new SubtitleService({
    repo: catalogRepo,
    managedRoot: subtitleManagedRoot,
  });
  // Metadata editor (QYP2-023): images live under <userData>/images/.
  const metadataImagesDir = join(app.getPath('userData'), 'images');
  // QYP3-019：歌词缓存（扫描期从标签落盘，人工可编辑）
  const lyricsDir = join(app.getPath('userData'), 'lyrics');
  // Two-phase safe delete (QYP2-024, plan §14.2): short-lived single-use
  // tokens; renderer supplies only {sourceId, itemId}, never paths.
  const safeDelete = new SafeDeleteService({
    repo: catalogRepo,
    resolveInside: (id, relativePath) => {
      const { adapter } = getAdapterForSource(db, id, secretStore);
      if (!(adapter instanceof LocalSourceAdapter)) {
        throw new Error('非本地来源不支持本地路径解析');
      }
      return adapter.resolveInside(relativePath);
    },
    trashFn: async (absolutePath) => {
      const { shell } = await import('electron');
      // shell.trashItem throws when the trash move fails; the service
      // treats that as TRASH_FAILED and never falls back to a real delete.
      await shell.trashItem(absolutePath);
    },
    webdavDelete: async ({ sourceId, relativePath, ifMatch }) => {
      const { adapter } = getAdapterForSource(db, sourceId, secretStore);
      if (!(adapter instanceof WebDavSourceAdapter)) {
        throw new Error('非 WebDAV 来源不支持远程删除');
      }
      return adapter.deleteTree(relativePath, new AbortController().signal, ifMatch);
    },
    managedCacheRoots: [subtitleManagedRoot, metadataImagesDir],
    // Managed DB rows die with the item: subtitle associations and image
    // slots (the service already removed the files themselves).
    removeManagedCache: (deletedItemId) => {
      for (const row of catalogRepo.listSubtitlesByItem(deletedItemId)) {
        catalogRepo.deleteSubtitle(deletedItemId, row.id);
      }
      for (const field of ['poster', 'fanart']) {
        catalogRepo.deleteMetadataSource(deletedItemId, field, 'manual');
      }
    },
  });
  try {
    cleanupTempFiles(subtitleManagedRoot, new Set(catalogRepo.listAllSubtitlePaths()));
  } catch {
    // best effort; the next startup retries
  }
  const repo = catalogRepo;

  ipcMain.handle(IPC_CHANNELS.CATALOG.PICK_DIR, async () => {
    const { dialog } = await import('electron');
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: '选择媒体库目录',
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle(IPC_CHANNELS.CATALOG.SOURCE_LIST, () => {
    const entries: SourceListEntry[] = repo.listSources().map((source) => {
      const lastRun = repo.getLatestScanRun(source.id);
      const health = readPersistedHealth(source);
      return {
        id: source.id,
        kind: source.kind,
        name: source.name,
        root: source.root,
        readOnly: source.read_only === 1,
        // WebDAV never offers delete in phase 2; ETag/Range per plan §8.1.
        capabilities:
          source.kind === 'webdav'
            ? { canSeek: true, canDelete: false, supportsEtag: true, supportsRange: true }
            : { ...LOCAL_SOURCE_CAPABILITIES },
        hasCredential: source.secret_ref ? secretStore.hasSecretByRef(source.secret_ref) : false,
        purpose: source.purpose,
        ...(health
          ? {
              health: health.health,
              ...(health.checkedAt !== undefined ? { healthCheckedAt: health.checkedAt * 1000 } : {}),
            }
          : {}),
        ...(lastRun
          ? {
              lastRun: {
                status: lastRun.status,
                ...(lastRun.processed_count !== null ? { processed: lastRun.processed_count } : {}),
                ...(lastRun.total_count !== null ? { total: lastRun.total_count } : {}),
                ...(lastRun.error ? { message: lastRun.error } : {}),
                at: (lastRun.finished_at ?? lastRun.started_at ?? 0) * 1000,
              },
            }
          : {}),
      };
    });
    return entries;
  });

  ipcMain.handle(IPC_CHANNELS.CATALOG.SOURCE_TEST, async (_event, input: unknown): Promise<ActionResult<SourceCapabilities>> => {
    try {
      if (isCreateWebDavSourceInput(input)) {
        // Credentials travel once from the form; nothing here is logged.
        return ok(await testWebDavConnection(input));
      }
      if (isCreateLocalSourceInput(input)) {
        const root = LocalSourceAdapter.canonicalizeRoot(input.root);
        const adapter = LocalSourceAdapter.fromSource(0, root);
        return ok(await adapter.testConnection(new AbortController().signal));
      }
      return err('VALIDATION_FAILED', '来源输入不合法');
    } catch (e) {
      return err('UNAVAILABLE', e instanceof Error ? e.message : '连接不可用', { retryable: true });
    }
  });

  ipcMain.handle(IPC_CHANNELS.CATALOG.SOURCE_SAVE, (_event, input: unknown): ActionResult<{ sourceId: number; root: string; name: string }> => {
    try {
      if (isCreateWebDavSourceInput(input)) {
        return ok(createWebDavSource(db, secretStore, input));
      }
      if (isCreateLocalSourceInput(input)) {
        return ok(createLocalSourceFromSelection(db, input.root, { name: input.name, purpose: input.purpose }));
      }
      return err('VALIDATION_FAILED', '来源输入不合法');
    } catch (e) {
      return err('VALIDATION_FAILED', e instanceof Error ? e.message : '来源创建失败');
    }
  });

  ipcMain.handle(IPC_CHANNELS.CATALOG.SOURCE_REMOVE, (_event, sourceId: number): ActionResult<true> => {
    if (!Number.isInteger(sourceId) || sourceId <= 0) {
      return err('VALIDATION_FAILED', '来源 ID 不合法');
    }
    activeScanJobs.get(sourceId)?.cancel();
    activeScanJobs.delete(sourceId);
    try {
      removeSource(db, sourceId, secretStore);
      return ok(true);
    } catch (e) {
      return err('NOT_FOUND', e instanceof Error ? e.message : '来源不存在');
    }
  });

  // 来源转域（QYP3-055）：把已有来源改成音乐/影视来源。只改用途标签——
  // 已索引的内容不动，音乐域的查询按 purpose 过滤后立即生效（不用重扫）。
  // 扫描进行中不允许转（半新半旧的索引说不清归属）。
  ipcMain.handle(
    IPC_CHANNELS.CATALOG.SOURCE_SET_PURPOSE,
    (_event, args: { sourceId: number; purpose: unknown }): ActionResult<{ purpose: string }> => {
      const sourceId = Number(args?.sourceId);
      if (!Number.isInteger(sourceId) || sourceId <= 0) {
        return err('VALIDATION_FAILED', '来源 ID 不合法');
      }
      if (!isSourcePurpose(args?.purpose)) {
        return err('VALIDATION_FAILED', '来源用途不合法');
      }
      const purpose = args.purpose;
      if (activeScanJobs.has(sourceId)) {
        return err('UNAVAILABLE', '正在扫描中，请等扫描结束再改');
      }
      const source = repo.getSource(sourceId);
      if (!source) return err('NOT_FOUND', '来源不存在');
      if (source.purpose === purpose) return ok({ purpose });
      repo.setSourcePurpose(sourceId, purpose);
      return ok({ purpose });
    }
  );

  ipcMain.handle(IPC_CHANNELS.CATALOG.SOURCE_HEALTH, async (_event, sourceId: number): Promise<ActionResult<string>> => {
    if (!Number.isInteger(sourceId) || sourceId <= 0) {
      return err('VALIDATION_FAILED', '来源 ID 不合法');
    }
    try {
      const { adapter } = getAdapterForSource(db, sourceId, secretStore);
      const capabilities = await adapter.testConnection(new AbortController().signal);
      const state: SourceHealthState = capabilities.canSeek ? 'ok' : 'degraded';
      persistSourceHealth(repo, sourceId, state);
      return ok(state);
    } catch (e) {
      // WebDAV 401/403 is auth failure, not offline (plan §6.1 health map).
      const status = (e as { status?: number }).status;
      const state: SourceHealthState = status === 401 || status === 403 ? 'auth-required' : 'offline';
      persistSourceHealth(repo, sourceId, state);
      if (status === 401 || status === 403) {
        return err('AUTH_REQUIRED', '认证失败：请检查用户名与密码');
      }
      return err('UNAVAILABLE', e instanceof Error ? e.message : '来源不可达', { retryable: true });
    }
  });

  ipcMain.handle(IPC_CHANNELS.CATALOG.SCAN_START, (_event, sourceId: number): ActionResult<true> => {
    if (!Number.isInteger(sourceId) || sourceId <= 0) {
      return err('VALIDATION_FAILED', '来源 ID 不合法');
    }
    if (activeScanJobs.has(sourceId)) {
      return err('CONFLICT', '该来源已有扫描任务在运行');
    }
    let adapter;
    try {
      ({ adapter } = getAdapterForSource(db, sourceId, secretStore));
    } catch (e) {
      return err('NOT_FOUND', e instanceof Error ? e.message : '来源不存在');
    }
    // Recursive walk over the adapter; deterministic order also drives the
    // movie-group flush and the resume cursor semantics (QYP2-009).
    // Depth 0/1 stays inside the webdav adapter; Depth infinity is forbidden.
    const scanningAdapter: SourceAdapter = {
      ...adapter,
      list: (path: string, signal: AbortSignal) => walkSourceTree(adapter, path, signal),
    };
    // 用途过滤（QYP3-039/041）：来源按域扫描，音乐源只索引音频，视频源只索引视频
    const purpose = repo.getSource(sourceId)?.purpose ?? 'video';
    const driver =
      adapter.kind === 'webdav'
        ? createWebDavScanDriver({
            repo,
            sourceId,
            adapter,
            purpose,
            // QYP3-060：WebDAV 音频与本地同待遇——头部标签解析（bounded GET，
            // Range 0-524287）、封面/歌词落盘、时长解析版本闸门
            coversDir: join(app.getPath('userData'), 'covers'),
            lyricsDir,
            durationScanVersion: Number(storage.getConfig('music.durationScanVersion')) || 0,
            onDurationScanVersion: (version) => {
              try {
                storage.setConfig('music.durationScanVersion', String(version));
              } catch {
                // 写不进去只影响下一轮是否重复解析，不影响扫描结果
              }
            },
          })
        : createLocalScanDriver({
            repo,
            sourceId,
            purpose,
            coversDir: join(app.getPath('userData'), 'covers'), // QYP3-005
            lyricsDir, // QYP3-019
            // NFO contents are read through the adapter's containment check,
            // so a stored relative path can never escape the source root.
            readNfo: async (relativePath) =>
              readFile((adapter as LocalSourceAdapter).resolveInside(relativePath)),
            // QYP3-004：本地音频读标签。只读头部 512 KiB（ID3v2/APIC/FLAC
            // 元数据块都在头部）。时长（QYP3-052）在扫描期尽力解析（mp3 的
            // Xing/TLEN、APE 的 MAC 头），解析不出来的由播放期回填
            readAudio: async (entry) => {
              const fh = (await openFile(
                (adapter as LocalSourceAdapter).resolveInside(entry.relativePath),
                'r'
              )) as import('node:fs/promises').FileHandle;
              try {
                const len = Math.min(512 * 1024, (await fh.stat()).size);
                const buf = Buffer.alloc(len);
                await fh.read(buf, 0, len, 0);
                return buf;
              } finally {
                await fh.close();
              }
            },
            // QYP3-006：CUE 文本（小文件，整读）
            readText: async (entry) =>
              (await readFile((adapter as LocalSourceAdapter).resolveInside(entry.relativePath))) as Buffer,
            // QYP3-052：时长解析能力版本——低于当前版本时，本轮会给"指纹没变
            // 但缺时长"的曲目强制补解析一次（收尾写回，只补这一轮）
            durationScanVersion: Number(storage.getConfig('music.durationScanVersion')) || 0,
            onDurationScanVersion: (version) => {
              try {
                storage.setConfig('music.durationScanVersion', String(version));
              } catch {
                // 写不进去只影响下一轮是否重复解析，不影响扫描结果
              }
            },
          });
    const controller = new ScanJobController({
      repo,
      adapter: scanningAdapter,
      driver,
      sourceId,
      root: repo.getSource(sourceId)?.root ?? '',
      onEvent: broadcastScanEvent,
    });
    activeScanJobs.set(sourceId, controller);
    void controller
      .start()
      .then((runId) => {
        // Availability downgrade to 'missing' happens only after a
        // successful FULL scan (plan §6.1); ipc has no resume path yet.
        const run = repo.getScanRun(runId);
        if (run?.status === 'completed') {
          // 仅音乐来源的批次里没有视频路径（QYP3-039），可用性降级会把
          // 存量视频条目全部误标 missing——必须跳过
          if (purpose !== 'music') {
            markAvailabilityAfterScan(repo, sourceId, driver.seen, { fullScan: true });
          }
          // Idempotent: legacy local_media progress migrates onto catalog
          // items once the files exist (plan §6.4 / QYP2-011 acceptance).
          try {
            const legacy = migrateLegacyProgressForSource(db, sourceId);
            if (legacy.migrated > 0) {
              console.log(`[SCAN] 来源 ${sourceId} 旧进度迁移完成: ${legacy.migrated} 条`);
            }
          } catch (e) {
            console.error('[SCAN] 旧进度迁移失败（不影响扫描结果）:', e instanceof Error ? e.message : e);
          }
        }
      })
      .catch((e) => {
        console.error(`[SCAN] 来源 ${sourceId} 扫描异常:`, e instanceof Error ? e.message : e);
      })
      .finally(() => {
        activeScanJobs.delete(sourceId);
      });
    return ok(true);
  });

  ipcMain.handle(IPC_CHANNELS.CATALOG.SCAN_CANCEL, (_event, sourceId: number): ActionResult<true> => {
    if (!Number.isInteger(sourceId) || sourceId <= 0) {
      return err('VALIDATION_FAILED', '来源 ID 不合法');
    }
    const job = activeScanJobs.get(sourceId);
    if (!job) {
      return err('NOT_FOUND', '该来源没有正在运行的扫描');
    }
    job.cancel();
    return ok(true);
  });

  // ---- Browse / search / detail / playback (QYP2-011) -------------------

  const queryService = createCatalogQueryService(db);

  ipcMain.handle(IPC_CHANNELS.CATALOG.LIST, (_event, input: CatalogBrowseQuery): ActionResult<unknown> => {
    if (!isCatalogBrowseQuery(input)) {
      return err('VALIDATION_FAILED', '浏览查询不合法');
    }
    try {
      return ok(queryService.listPage(input));
    } catch (e) {
      console.error('[CATALOG] 浏览失败:', e instanceof Error ? e.message : e);
      return err('INTERNAL', '浏览目录失败');
    }
  });

  ipcMain.handle(IPC_CHANNELS.CATALOG.SEARCH, (_event, input: CatalogSearchQuery): ActionResult<unknown> => {
    if (!isCatalogSearchQuery(input)) {
      return err('VALIDATION_FAILED', '搜索查询不合法');
    }
    try {
      return ok(queryService.search(input));
    } catch (e) {
      console.error('[CATALOG] 搜索失败:', e instanceof Error ? e.message : e);
      return err('INTERNAL', '搜索失败');
    }
  });

  ipcMain.handle(IPC_CHANNELS.CATALOG.GET, (_event, sourceId: number, itemId: number): ActionResult<unknown> => {
    if (!Number.isInteger(sourceId) || sourceId <= 0 || !Number.isInteger(itemId) || itemId <= 0) {
      return err('VALIDATION_FAILED', '来源或条目 ID 不合法');
    }
    try {
      const detail = queryService.getDetail(sourceId, itemId);
      return detail ? ok(detail) : err('NOT_FOUND', '条目不存在');
    } catch (e) {
      console.error('[CATALOG] 详情失败:', e instanceof Error ? e.message : e);
      return err('INTERNAL', '加载详情失败');
    }
  });

  ipcMain.handle(IPC_CHANNELS.CATALOG.RESOLVE, (_event, sourceId: number, itemId: number): ActionResult<unknown> => {
    if (!Number.isInteger(sourceId) || sourceId <= 0 || !Number.isInteger(itemId) || itemId <= 0) {
      return err('VALIDATION_FAILED', '来源或条目 ID 不合法');
    }
    try {
      const intent = queryService.getPlayback(sourceId, itemId);
      if (!intent) return err('NOT_FOUND', '条目不存在或没有可播放的文件');
      const resolved = getAdapterForSource(db, sourceId);
      if (!(resolved.adapter instanceof LocalSourceAdapter)) {
        return err('UNAVAILABLE', '该来源类型暂不支持本地播放路径解析');
      }
      // The adapter enforces string + realpath containment; the stored
      // relative path can never escape the source root.
      const path = resolved.adapter.resolveInside(intent.relativePath);
      const { relativePath: _rp, ...rest } = intent;
      return ok({ ...rest, path });
    } catch (e) {
      console.error('[CATALOG] 解析播放路径失败:', e instanceof Error ? e.message : e);
      return err('INTERNAL', '解析播放路径失败');
    }
  });

  // ---- Subtitles (QYP2-020, plan §13) ----
  ipcMain.handle(IPC_CHANNELS.SUBTITLES.PICK_FILE, async () => {
    const { dialog } = await import('electron');
    const result = await dialog.showOpenDialog({
      title: '选择字幕文件',
      properties: ['openFile'],
      filters: [{ name: '字幕', extensions: ['srt', 'ass', 'ssa', 'sub', 'vtt'] }],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle(IPC_CHANNELS.SUBTITLES.IMPORT, (_event, input: ImportSubtitleInput) => {
    return subtitleService.import({
      itemId: input?.itemId,
      sourcePath: input?.sourcePath,
      language: input?.language,
      title: input?.title,
      isDefault: input?.isDefault,
    });
  });

  ipcMain.handle(IPC_CHANNELS.SUBTITLES.LIST, (_event, itemId: number) => {
    return subtitleService.list(itemId);
  });

  ipcMain.handle(IPC_CHANNELS.SUBTITLES.REMOVE, (_event, itemId: number, rowId: number) => {
    return subtitleService.remove(itemId, rowId);
  });

  ipcMain.handle(IPC_CHANNELS.SUBTITLES.SET_DEFAULT, (_event, itemId: number, rowId: number) => {
    return subtitleService.setDefault(itemId, rowId);
  });

  // ---- Metadata editor (QYP2-023, plan §14.1) ----
  ipcMain.handle(IPC_CHANNELS.METADATA.GET, (_event, itemId: number) => {
    if (!Number.isInteger(itemId) || itemId <= 0) {
      return err('VALIDATION_FAILED', '条目 ID 无效');
    }
    if (!catalogRepo.getItem(itemId)) return err('NOT_FOUND', '条目不存在');
    return ok({ itemId, fields: describeItemFields(catalogRepo, itemId) });
  });

  ipcMain.handle(IPC_CHANNELS.METADATA.SAVE, (_event, itemId: number, patches: ManualPatch[]) => {
    // toEditorActionResult maps EditorResult (ok/conflict/validation) onto
    // the envelope without double wrapping - conflicts stay observable.
    return toEditorActionResult(itemId, patches, catalogRepo);
  });

  ipcMain.handle(IPC_CHANNELS.METADATA.RESTORE, (_event, itemId: number, fields?: string[]) => {
    if (!Number.isInteger(itemId) || itemId <= 0) {
      return err('VALIDATION_FAILED', '条目 ID 无效');
    }
    const result = restoreManualFields(catalogRepo, itemId, fields);
    return ok({ cleared: result.cleared });
  });

  ipcMain.handle(IPC_CHANNELS.METADATA.PICK_IMAGE, async () => {
    const { dialog } = await import('electron');
    const result = await dialog.showOpenDialog({
      title: '选择图片',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp'] }],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle(
    IPC_CHANNELS.METADATA.IMPORT_IMAGES,
    (_event, itemId: number, inputs: Array<{ kind: 'poster' | 'fanart'; sourcePath: string }>) => {
      const result = importItemImages(catalogRepo, itemId, metadataImagesDir, inputs);
      if (!result.ok) {
        return err(
          result.code === 'ITEM_NOT_FOUND' ? 'NOT_FOUND' : result.code === 'IO_ERROR' ? 'INTERNAL' : 'VALIDATION_FAILED',
          result.message
        );
      }
      return ok({ imported: result.imported });
    }
  );

  // ---- Scrape jobs (QYP2-032, plan §11.2) ----
  const assertScrapePluginUsable = (pluginId: unknown): string | null => {
    if (typeof pluginId !== 'string' || pluginId.length === 0) return '插件参数不合法';
    if (!getPlugin(pluginId)) return '插件未注册';
    if (!pluginConfigService.getConfig(pluginId).enabled) return '插件已停用';
    return null;
  };

  ipcMain.handle(IPC_CHANNELS.SCRAPE.START, (_event, pluginId: unknown, itemIds: unknown, jobId: unknown) => {
    const pluginProblem = assertScrapePluginUsable(pluginId);
    if (pluginProblem) return err('VALIDATION_FAILED', pluginProblem);
    if (!Array.isArray(itemIds) || itemIds.some((id) => !Number.isInteger(id) || id <= 0) || itemIds.length === 0) {
      return err('VALIDATION_FAILED', '条目列表不合法');
    }
    if (itemIds.length > 500) return err('VALIDATION_FAILED', '单批最多 500 个条目');
    if (jobId !== undefined && jobId !== null && typeof jobId !== 'string') {
      return err('VALIDATION_FAILED', '任务 id 不合法');
    }
    return ok(scrapeJobs.startJob(pluginId as string, itemIds as number[], (jobId as string) ?? undefined));
  });

  ipcMain.handle(IPC_CHANNELS.SCRAPE.JOBS, () => {
    return ok(scrapeJobs.listJobs());
  });

  ipcMain.handle(IPC_CHANNELS.SCRAPE.STATUS, (_event, jobId: unknown) => {
    if (typeof jobId !== 'string' || jobId.length === 0) return err('VALIDATION_FAILED', '任务 id 不合法');
    return ok(scrapeJobs.getJob(jobId));
  });

  ipcMain.handle(IPC_CHANNELS.SCRAPE.CANCEL, (_event, jobId: unknown) => {
    if (typeof jobId !== 'string' || jobId.length === 0) return err('VALIDATION_FAILED', '任务 id 不合法');
    return ok({ cancelled: scrapeJobs.cancelJob(jobId) });
  });

  ipcMain.handle(
    IPC_CHANNELS.SCRAPE.APPLY,
    async (_event, pluginId: unknown, itemId: unknown, candidateId: unknown) => {
      const pluginProblem = assertScrapePluginUsable(pluginId);
      if (pluginProblem) return err('VALIDATION_FAILED', pluginProblem);
      if (!Number.isInteger(itemId) || (itemId as number) <= 0) return err('VALIDATION_FAILED', '条目 id 不合法');
      if (typeof candidateId !== 'string' || candidateId.length === 0) return err('VALIDATION_FAILED', '候选 id 不合法');
      const item = catalogRepo.getItem(itemId as number);
      if (!item) return err('NOT_FOUND', '条目不存在');
      const kind = item.kind === 'series' ? 'series' : 'movie';
      return ok(await scrapeJobs.applyCandidate(pluginId as string, itemId as number, candidateId as string, kind));
    }
  );

  // ---- Series resume resolution (QYP2-034, plan §12.2) ----
  // The renderer never copies the algorithm: it collects the series'
  // episode snapshots (server UserData preferred, §12.1) and the pure
  // resolver decides target/position/reason main-side.
  ipcMain.handle(IPC_CHANNELS.RESUME.SERIES, (_event, episodes: unknown, mediaType?: unknown) => {
    if (!Array.isArray(episodes)) return err('VALIDATION_FAILED', '单集列表不合法');
    const inputs = [];
    for (const entry of episodes) {
      if (typeof entry !== 'object' || entry === null) return err('VALIDATION_FAILED', '单集条目不合法');
      const item = entry as Record<string, unknown>;
      if (typeof item.itemId !== 'string' && typeof item.itemId !== 'number') {
        return err('VALIDATION_FAILED', '单集 id 不合法');
      }
      inputs.push(item as unknown as ResumeEpisodeInput);
    }
    // 本地历史合并（防御：服务器同步可能失败/滞后——实测教训）。
    // 本地 watched_at 较新时覆盖服务器快照；决策仍全在 resolveSeriesResume。
    if (typeof mediaType === 'string' && (mediaType === 'jellyfin' || mediaType === 'emby')) {
      const ids = inputs.map((e) => String((e as { itemId: unknown }).itemId));
      const locals = storage.getWatchHistoryByMediaIds(mediaType, ids);
      for (const input of inputs) {
        const local = locals.get(String((input as { itemId: unknown }).itemId));
        if (!local) continue;
        const localMs = local.watched_at * 1000;
        const serverMs = (input as { progress?: { updatedAt?: number } }).progress?.updatedAt ?? -1;
        if (localMs > serverMs) {
          (input as { progress: unknown }).progress = {
            position: local.position,
            duration: local.duration ?? 0,
            isFinished: false, // 看完与否由 resolver 比例推导兜底
            updatedAt: localMs,
          };
        }
      }
    }
    return ok(resolveSeriesResume(inputs));
  });

  // ---- Next-episode pick (QYP2-035; pure main-side; renderer owns the
  // episode list it already loaded for the series page) ----
  // Next-episode pick (pure, main-side; renderer owns the episode list it
  // already loaded for the series page).
  ipcMain.handle(IPC_CHANNELS.RESUME.NEXT, (_event, input: unknown) => {
    if (typeof input !== 'object' || input === null) return err('VALIDATION_FAILED', '参数不合法');
    const { episodes, seasonNumber, episodeNumber } = input as {
      episodes?: unknown;
      seasonNumber?: unknown;
      episodeNumber?: unknown;
    };
    if (!Array.isArray(episodes)) return err('VALIDATION_FAILED', '单集列表不合法');
    const clean: AutoNextEpisodeLike[] = [];
    for (const entry of episodes) {
      if (typeof entry !== 'object' || entry === null) continue;
      const item = entry as Record<string, unknown>;
      if (typeof item.itemId !== 'string' && typeof item.itemId !== 'number') continue;
      const seasonOk = [null, undefined].includes(item.seasonNumber as never) || typeof item.seasonNumber === 'number';
      const episodeOk = [null, undefined].includes(item.episodeNumber as never) || typeof item.episodeNumber === 'number';
      if (seasonOk && episodeOk) {
        clean.push(item as unknown as AutoNextEpisodeLike);
      }
    }
    const next = pickNextEpisode(
      clean,
      typeof seasonNumber === 'number' ? seasonNumber : null,
      typeof episodeNumber === 'number' ? episodeNumber : null
    );
    return ok(next);
  });

  // ---- Plugin config (QYP2-027, plan §11.1/§11.3) ----
  ipcMain.handle(IPC_CHANNELS.PLUGINS.LIST, () => {
    return ok(
      listPlugins().map(({ manifest }) => {
        const config = pluginConfigService.getConfig(manifest.id);
        const secretKeys = [...REQUIRED_SECRET_KEYS].filter((key) =>
          pluginConfigService.hasSecret(manifest.id, key)
        );
        return {
          id: manifest.id,
          name: manifest.name,
          version: manifest.version,
          apiVersion: manifest.apiVersion,
          capability: manifest.capability,
          enabled: config.enabled,
          priority: config.priority,
          settings: config.settings,
          /** Fingerprints only - secret values never cross the boundary. */
          secrets: secretKeys.map((key) => ({ key, set: true })),
        };
      })
    );
  });

  ipcMain.handle(
    IPC_CHANNELS.PLUGINS.SET_CONFIG,
    (_event, pluginId: unknown, patch: { enabled?: boolean; priority?: number; settings?: Record<string, string | number | boolean> }) => {
      if (typeof pluginId !== 'string' || !/^[a-z][a-z0-9-]{1,31}$/.test(pluginId)) {
        return err('VALIDATION_FAILED', '插件 ID 无效');
      }
      if (!listPlugins().some(({ manifest }) => manifest.id === pluginId)) {
        return err('NOT_FOUND', '插件未注册');
      }
      try {
        return ok({ config: pluginConfigService.setConfig(pluginId, patch ?? {}) });
      } catch (e) {
        return err('VALIDATION_FAILED', e instanceof Error ? e.message : '配置无效');
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.PLUGINS.SET_SECRET,
    (_event, pluginId: unknown, key: unknown, value: unknown) => {
      if (typeof pluginId !== 'string' || !/^[a-z][a-z0-9-]{1,31}$/.test(pluginId)) {
        return err('VALIDATION_FAILED', '插件 ID 无效');
      }
      if (typeof key !== 'string' || typeof value !== 'string') {
        return err('VALIDATION_FAILED', 'secret 参数无效');
      }
      try {
        const { fingerprint } = pluginConfigService.setSecret(pluginId, key, value);
        return ok({ fingerprint }); // never the secret itself
      } catch (e) {
        return err('VALIDATION_FAILED', e instanceof Error ? e.message : 'secret 无效');
      }
    }
  );

  ipcMain.handle(IPC_CHANNELS.PLUGINS.DELETE_SECRET, (_event, pluginId: unknown, key: unknown) => {
    if (typeof pluginId !== 'string' || typeof key !== 'string' || !/^[a-z][a-z0-9-]{1,31}$/.test(pluginId)) {
      return err('VALIDATION_FAILED', '参数无效');
    }
    if (!listPlugins().some(({ manifest }) => manifest.id === pluginId)) {
      return err('NOT_FOUND', '插件未注册');
    }
    pluginConfigService.deleteSecret(pluginId, key);
    return ok({ deleted: true });
  });

  ipcMain.handle(IPC_CHANNELS.PLUGINS.TEST, async (_event, pluginId: unknown) => {
    if (typeof pluginId !== 'string' || !/^[a-z][a-z0-9-]{1,31}$/.test(pluginId)) {
      return err('VALIDATION_FAILED', '插件 ID 无效');
    }
    if (!listPlugins().some(({ manifest }) => manifest.id === pluginId)) {
      return err('NOT_FOUND', '插件未注册');
    }
    const health = await pluginConfigService.checkHealth(pluginId);
    return ok(health);
  });

  // ---- Safe delete (QYP2-024, plan §14.2) ----
  ipcMain.handle(IPC_CHANNELS.MEDIA.DELETE_PREVIEW, (_event, ref: { sourceId?: unknown; itemId?: unknown }) => {
    const sourceId = Number(ref?.sourceId);
    const itemId = Number(ref?.itemId);
    return mapDeletePreviewResult(safeDelete.preview(sourceId, itemId));
  });

  ipcMain.handle(
    IPC_CHANNELS.MEDIA.DELETE_EXECUTE,
    async (_event, args: { token?: unknown; confirmTitle?: unknown }) => {
      if (typeof args?.token !== 'string') {
        return err('VALIDATION_FAILED', '缺少确认令牌');
      }
      const result = await safeDelete.execute(args.token, {
        ...(typeof args.confirmTitle === 'string' ? { confirmTitle: args.confirmTitle } : {}),
      });
      return mapDeleteExecuteResult(result);
    }
  );

  // Push channel: renderers subscribe through preload (single dispatcher per
  // sender) and receive ScanProgressEvent payloads (<= 4Hz by controller).
  // Registration is deduped per sender: repeat subscribes stay single-shot.
  ipcMain.on(IPC_CHANNELS.CATALOG.SCAN_EVENTS, (event) => {
    if (scanEventSenders.has(event.sender.id)) return;
    const push = (e: ScanProgressEvent): void => {
      if (!event.sender.isDestroyed()) {
        event.sender.send(IPC_CHANNELS.CATALOG.SCAN_EVENTS, e);
      }
    };
    scanEventSenders.set(event.sender.id, push);
    event.sender.once('destroyed', () => {
      scanEventSenders.delete(event.sender.id);
    });
  });
}

/** 歌单导出编排（QYP3-016/017）：保存对话框 → 组装 → 写盘。 */
async function exportPlaylistFile(
  playlistId: number,
  format: 'm3u8',
  catalogRepo: ReturnType<typeof createCatalogRepository>
): Promise<{ ok: true; data: { canceled?: boolean; saved?: string; count?: number } }> {
  const { dialog } = await import('electron');
  const { writeFile } = await import('fs/promises');
  const result = await dialog.showSaveDialog({
    defaultPath: `playlist.${format}`,
    filters: [{ name: '播放列表', extensions: [format] }],
  });
  if (result.canceled || !result.filePath) {
    return { ok: true, data: { canceled: true } };
  }
  const tracks = await gatherExportTracks(playlistId, catalogRepo);
  const baseDir = result.filePath.split(/[\\/]/).slice(0, -1).join('/');
  const content = exportM3u8(tracks, baseDir);
  await writeFile(result.filePath, content, 'utf8');
  return { ok: true, data: { saved: result.filePath, count: tracks.length } };
}

async function exportPlaylistXspf(
  playlistId: number,
  catalogRepo: ReturnType<typeof createCatalogRepository>,
  playlistName: string
): Promise<{ canceled?: boolean; saved?: string; count?: number }> {
  const { dialog } = await import('electron');
  const { writeFile } = await import('fs/promises');
  const playlist = playlistName;
  const result = await dialog.showSaveDialog({
    defaultPath: `${playlist}.xspf`,
    filters: [{ name: 'XSPF 播放列表', extensions: ['xspf'] }],
  });
  if (result.canceled || !result.filePath) {
    return { canceled: true };
  }
  const tracks = await gatherExportTracks(playlistId, catalogRepo);
  await writeFile(result.filePath, exportXspf(tracks, playlist), 'utf8');
  return { saved: result.filePath, count: tracks.length };
}

/** 组装导出行：歌单条目 → 联表 → location（本地绝对/WebDAV URL）。 */
async function gatherExportTracks(
  playlistId: number,
  catalogRepo: ReturnType<typeof createCatalogRepository>
): Promise<PlaylistTrackInfo[]> {
  const items = catalogRepo.listPlaylistItems(playlistId);
  const rows: PlaylistTrackInfo[] = [];
  for (const item of items) {
    if (!item.track) continue; // 失效引用（音轨已删除）：导出时跳过
    const source = catalogRepo.getSource(item.track.source_id);
    if (!source) continue;
    rows.push(
      toExportInfo({
        trackId: item.track.id,
        sourceId: item.track.source_id,
        sourceKind: source.kind,
        sourceRoot: source.root,
        title: item.track.title,
        artist: item.track.artist,
        duration: item.track.duration,
        path: item.track.path,
      })
    );
  }
  return rows;
}
