import { ipcMain } from 'electron';
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
import type { SourceEntry } from '../modules/library-sources/types';
import { ScanJobController } from '../modules/library-scanner/job-controller';
import {
  createLocalSourceFromSelection,
  getAdapterForSource,
  removeSource,
} from '../modules/catalog/source-service';
import { createCatalogRepository } from '../modules/catalog/repository';
import type { CatalogRepository } from '../modules/catalog/repository';
import {
  isCreateLocalSourceInput,
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

  ipcMain.handle(IPC_CHANNELS.SETTINGS.SAVE_SERVER, (_event, server: ServerConfig) => {
    // The API key goes to the SecretStore, never into the DB column. When no
    // key is provided (editing without re-auth), the existing secret and any
    // legacy column value are left untouched.
    const id = storage.saveServer({
      id: server.id,
      type: server.type,
      name: server.name ?? '',
      baseUrl: server.baseUrl,
      username: server.username,
      userId: server.userId,
      isActive: server.isActive,
    });
    if (server.apiKey) {
      // Throws on readback failure; nothing is cleared before that.
      secretStore.setSecret(MEDIA_SERVER_NAMESPACE, String(id), server.apiKey);
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
          const auth = await client.authenticate(server.username, server.password);
          // Transitional (QYP2-013/015): the fresh token still round-trips
          // through the renderer for the save flow; PlaybackResolver will
          // own auth injection and remove this pass-through later.
          return { ok: true, accessToken: auth.accessToken, userId: auth.userId };
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

  ipcMain.handle(IPC_CHANNELS.ONLINE.GET_ITEMS, async (_event, parentId: string, options?: unknown) => {
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

  ipcMain.handle(IPC_CHANNELS.ONLINE.GET_ITEM_DETAILS, async (_event, itemId: string) => {
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
const scanEventListeners = new Set<(event: ScanProgressEvent) => void>();

function broadcastScanEvent(event: ScanProgressEvent): void {
  for (const listener of scanEventListeners) {
    try {
      listener(event);
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
function createBasicScanDriver(repo: CatalogRepository, sourceId: number): {
  index(entry: SourceEntry, signal: AbortSignal): Promise<void>;
} {
  return {
    async index(entry) {
      if (entry.isDirectory) return;
      const title = entry.relativePath.replace(/\.[^.]+$/, '').split('/').pop() ?? entry.relativePath;
      const itemId = repo.upsertItem({
        sourceId,
        sourceKey: entry.relativePath,
        kind: 'video',
        title,
      });
      repo.upsertFile({
        sourceId,
        itemId,
        relativePath: entry.relativePath,
        size: entry.size,
        mtime: entry.mtime,
      });
    },
  };
}

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
      return {
        id: source.id,
        kind: source.kind,
        name: source.name,
        root: source.root,
        readOnly: source.read_only === 1,
        capabilities: { ...LOCAL_SOURCE_CAPABILITIES },
        hasCredential: source.secret_ref ? secretStore.hasSecretByRef(source.secret_ref) : false,
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
    if (!isCreateLocalSourceInput(input)) {
      return err('VALIDATION_FAILED', '来源输入不合法');
    }
    try {
      const root = LocalSourceAdapter.canonicalizeRoot(input.root);
      const adapter = LocalSourceAdapter.fromSource(0, root);
      const capabilities = await adapter.testConnection(new AbortController().signal);
      return ok(capabilities);
    } catch (e) {
      return err('UNAVAILABLE', e instanceof Error ? e.message : '目录不可用', { retryable: true });
    }
  });

  ipcMain.handle(IPC_CHANNELS.CATALOG.SOURCE_SAVE, (_event, input: unknown): ActionResult<{ sourceId: number; root: string; name: string }> => {
    if (!isCreateLocalSourceInput(input)) {
      return err('VALIDATION_FAILED', '来源输入不合法');
    }
    try {
      const created = createLocalSourceFromSelection(db, input.root, { name: input.name });
      return ok(created);
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
      removeSource(db, sourceId);
      return ok(true);
    } catch (e) {
      return err('NOT_FOUND', e instanceof Error ? e.message : '来源不存在');
    }
  });

  ipcMain.handle(IPC_CHANNELS.CATALOG.SOURCE_HEALTH, async (_event, sourceId: number): Promise<ActionResult<string>> => {
    try {
      const { adapter } = getAdapterForSource(db, sourceId);
      const capabilities = await adapter.testConnection(new AbortController().signal);
      return ok(capabilities.canSeek ? 'ok' : 'degraded');
    } catch (e) {
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
      ({ adapter } = getAdapterForSource(db, sourceId));
    } catch (e) {
      return err('NOT_FOUND', e instanceof Error ? e.message : '来源不存在');
    }
    const controller = new ScanJobController({
      repo,
      adapter,
      driver: createBasicScanDriver(repo, sourceId),
      sourceId,
      root: repo.getSource(sourceId)?.root ?? '',
      onEvent: broadcastScanEvent,
    });
    activeScanJobs.set(sourceId, controller);
    void controller
      .start()
      .catch((e) => {
        console.error(`[SCAN] 来源 ${sourceId} 扫描异常:`, e instanceof Error ? e.message : e);
      })
      .finally(() => {
        activeScanJobs.delete(sourceId);
      });
    return ok(true);
  });

  ipcMain.handle(IPC_CHANNELS.CATALOG.SCAN_CANCEL, (_event, sourceId: number): ActionResult<true> => {
    const job = activeScanJobs.get(sourceId);
    if (!job) {
      return err('NOT_FOUND', '该来源没有正在运行的扫描');
    }
    job.cancel();
    return ok(true);
  });

  // Push channel: renderers subscribe through preload (single dispatcher per
  // sender) and receive ScanProgressEvent payloads (<= 4Hz by controller).
  ipcMain.on(IPC_CHANNELS.CATALOG.SCAN_EVENTS, (event) => {
    const push = (e: ScanProgressEvent): void => {
      if (!event.sender.isDestroyed()) {
        event.sender.send(IPC_CHANNELS.CATALOG.SCAN_EVENTS, e);
      }
    };
    scanEventListeners.add(push);
    event.sender.once('destroyed', () => {
      scanEventListeners.delete(push);
    });
  });
}
