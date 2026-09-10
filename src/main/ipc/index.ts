import { ipcMain } from 'electron';
import { readFile } from 'fs/promises';
import { randomUUID } from 'crypto';
import { basename, extname } from 'path';
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
  bindOnlineServer,
  resolvePlayback,
  ResolverError,
} from '../modules/player-core/playback-resolver';
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
  try {
    migrateServerTokensToSecretStore(db, storage.getServers(), secretStore);
  } catch (err) {
    console.error('[SECRET-MIGRATION] 服务器令牌迁移失败，将在下次启动重试:', err instanceof Error ? err.message : err);
  }

  // Stream headers are stashed main-side; renderers only see session ids.
  const streamHeaders: StreamHeaderCache = createStreamHeaderCache();

  // Initialize playback state manager
  playbackStateManager = new PlaybackStateManager(player, storage);
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
      } as ServerConfig);
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
      const providers = ['jellyfin', 'emby'] as const;
      for (const provider of providers) {
        try {
          const binding = bindOnlineServer(storage, secretStore, provider, serverId as number);
          const client = createClient({
            type: binding.type,
            baseUrl: binding.baseUrl,
            apiKey: binding.apiKey,
            userId: binding.userId,
          });
          return await client.getItems(parentId, options as Record<string, unknown>);
        } catch (e) {
          if (e instanceof ResolverError && e.code === 'SERVER_NOT_FOUND') continue;
          console.error('[GET-ITEMS] 服务器列表获取失败:', e instanceof Error ? e.message : e);
          return [];
        }
      }
      return [];
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
      const providers = ['jellyfin', 'emby'] as const;
      for (const provider of providers) {
        try {
          const binding = bindOnlineServer(storage, secretStore, provider, serverId as number);
          const client = createClient({
            type: binding.type,
            baseUrl: binding.baseUrl,
            apiKey: binding.apiKey,
            userId: binding.userId,
          });
          return await client.getItemDetails(itemId);
        } catch (e) {
          if (e instanceof ResolverError && e.code === 'SERVER_NOT_FOUND') continue;
          console.error('[GET-ITEM-DETAILS] 服务器详情获取失败:', e instanceof Error ? e.message : e);
          return null;
        }
      }
      console.error('[GET-ITEM-DETAILS] 指定服务器无法获取详情');
      return null;
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

  registerCatalogHandlers(db, secretStore);
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
function registerCatalogHandlers(db: ReturnType<typeof getDatabase>, secretStore: SecretStore): void {
  const repo = createCatalogRepository(db);

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
