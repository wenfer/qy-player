import { ipcMain } from 'electron';
import { readFile } from 'fs/promises';
import { randomUUID } from 'crypto';
import { basename, extname, join } from 'path';
import { app } from 'electron';
import { IPC_CHANNELS } from '../../shared/ipc-channels';
import { PlayerCore } from '../modules/player-core';
import { getDatabase, createStorage, closeDatabase } from '../modules/storage/db';
import { PlaybackStateManager } from '../modules/playback-state';
import { createClient } from '../modules/online-connector';
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
import { resolveSeriesResume } from '../modules/playback-state/resume-resolver';
import type { ResumeEpisodeInput } from '../../shared/types/playback';
import type { ProbeItemInput } from '../../shared/types/media-info';
import {
  isCatalogBrowseQuery,
  isCatalogSearchQuery,
} from '../../shared/types';
import type { CatalogBrowseQuery, CatalogSearchQuery } from '../../shared/types';

export let playbackStateManager: PlaybackStateManager | null = null;

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

export function registerIpcHandlers(player: PlayerCore): void {
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
  playbackStateManager = new PlaybackStateManager(player, storage, {
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
  });
  playbackStateManager.init();

  // Player handlers
  ipcMain.handle(IPC_CHANNELS.PLAYER.LOAD_FILE, async (
    _event,
    path: string,
    startPosition?: number,
    httpHeaders?: string,
    mediaContext?: { mediaType: string; mediaId: string; title?: string; seriesName?: string; seasonNumber?: number; episodeNumber?: number; mediaSourceId?: string },
    streamSessionId?: string
  ) => {
    if (!player.isReady()) {
      await player.start();
    }

    // Real headers never cross the IPC boundary: the renderer hands back the
    // opaque session id it received from GET_STREAM_URL.
    const stashedHeaders = streamSessionId ? streamHeaders.take(streamSessionId) : undefined;
    const effectiveHeaders = stashedHeaders ?? httpHeaders;

    // Determine if this is a local file
    const isLocal = isLocalFilePath(path);

    if (isLocal) {
      // Ensure local_media record exists
      const title = extractTitleFromPath(path);
      storage.upsertLocalMedia({ path, title });
      const localMedia = storage.getLocalMediaByPath(path);
      const localMediaId = localMedia?.id;

      // Query resume position
      const resumePosition = playbackStateManager!.getResumePosition('local', path);
      const finalPosition = startPosition !== undefined && startPosition > 0
        ? startPosition
        : (resumePosition > 0 ? resumePosition : undefined);

      // Set current media for progress tracking
      playbackStateManager!.setCurrentMedia('local', path, title, undefined, localMediaId);

      await player.loadFile(path, finalPosition, effectiveHeaders);
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
      playbackStateManager!.setCurrentMedia(
        mediaType,
        mediaId,
        mediaContext?.title,
        mediaContext?.seriesName,
        undefined,
        mediaContext?.seasonNumber,
        mediaContext?.episodeNumber,
        mediaContext?.mediaSourceId
      );
      // Resume from last position (same rule as local: skip if nearly finished)
      const resumePosition = playbackStateManager!.getResumePosition(mediaType, mediaId);
      const finalPosition = startPosition !== undefined && startPosition > 0
        ? startPosition
        : (resumePosition > 0 ? resumePosition : undefined);
      await player.loadFile(path, finalPosition, effectiveHeaders);
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
        await client.reportProgress(
          payload.mediaId,
          payload.mediaSourceId || payload.mediaId,
          Math.floor(payload.position * 10000000),
          payload.isFinished,
          !player.getState().isPlaying
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
      options: { mode?: 'direct' | 'transcode'; mediaSourceId?: string } = {}
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
            getResumePosition: (mediaType: string, mediaId: string) =>
              playbackStateManager!.getResumePosition(mediaType, mediaId),
            createOnlineClient: createClient,
          },
          { ref, mode, ...(mediaSourceId ? { mediaSourceId } : {}) }
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
            getResumePosition: (mediaType: string, mediaId: string) =>
              playbackStateManager!.getResumePosition(mediaType, mediaId),
            createOnlineClient: createClient,
          },
          { ref: input.ref, mode }
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

  ipcMain.handle(IPC_CHANNELS.LIBRARY.GET_RECENTLY_PLAYED, (_event, limit?: number) => {
    return storage.getWatchHistory(limit);
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
    return storage.getConfig(key);
  });

  ipcMain.handle(IPC_CHANNELS.SETTINGS.SET, (_event, key: string, value: unknown) => {
    assertNotSecretConfigKey(key);
    storage.setConfig(key, JSON.stringify(value));
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
          error: '服务器未登录，请到设置中编辑并填写密码以完成登录',
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
        return ok(createLocalSourceFromSelection(db, input.root, { name: input.name }));
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
    const driver =
      adapter.kind === 'webdav'
        ? createWebDavScanDriver({ repo, sourceId, adapter })
        : createLocalScanDriver({
            repo,
            sourceId,
            // NFO contents are read through the adapter's containment check,
            // so a stored relative path can never escape the source root.
            readNfo: async (relativePath) =>
              readFile((adapter as LocalSourceAdapter).resolveInside(relativePath)),
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
          markAvailabilityAfterScan(repo, sourceId, driver.seen, { fullScan: true });
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
  ipcMain.handle(IPC_CHANNELS.RESUME.SERIES, (_event, episodes: unknown) => {
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
    return ok(resolveSeriesResume(inputs));
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
