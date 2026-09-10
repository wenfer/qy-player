import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import type { MediaRef } from '../../../shared/types';
import { createCatalogQueryService, type PlaybackIntent } from '../catalog/query-service';
import { getAdapterForSource } from '../catalog/source-service';
import { LocalSourceAdapter } from '../library-sources/local-source';
import { loadWebDavSecret } from '../library-sources/webdav-source';
import { parseWebDavBaseUrl, relativePathToRequestPath } from '../library-sources/url-guard';
import { resolveServerApiKey, type SecretStore, type StreamHeaderCache } from '../security/secret-store';
import type { createStorage } from '../storage/db';
import type { createClient } from '../online-connector';

/**
 * Unified PlaybackResolver (QYP2-015).
 *
 * Every playback decision is made main-side: the renderer only ever holds a
 * MediaRef and receives back a ready-to-load payload. Secrets never cross
 * the IPC boundary (headers travel via the opaque streamHeaders session),
 * URLs are built by main, and online sources are routed STRICTLY by
 * serverId — no more try-every-active-server fallthrough.
 */

export type ResolveMode = 'direct' | 'transcode';

export interface ResolvePlaybackInput {
  ref: MediaRef;
  mode?: ResolveMode;
  /** Online items may pin a specific media source id. */
  mediaSourceId?: string;
}

export type ResolvedKind = 'local-file' | 'webdav-stream' | 'online-direct' | 'online-transcode';

export interface ResolvedMediaContext {
  mediaType: string;
  mediaId: string;
  title?: string;
  seriesName?: string;
  seasonNumber?: number;
  episodeNumber?: number;
  mediaSourceId?: string;
}

export interface PlaybackResolution {
  kind: ResolvedKind;
  /** Ready-to-load path (local file) or stream URL (webdav/online). */
  url: string;
  /** Opaque header session for transcode/webdav-auth; renderer passes back. */
  streamSessionId?: string;
  startPosition: number;
  mediaContext: ResolvedMediaContext;
}

export class ResolverError extends Error {
  readonly code:
    | 'SERVER_NOT_FOUND'
    | 'NO_CREDENTIAL'
    | 'ITEM_NOT_FOUND'
    | 'UNPLAYABLE'
    | 'UNAVAILABLE';
  constructor(code: ResolverError['code'], message: string) {
    super(message);
    this.name = 'ResolverError';
    this.code = code;
  }
}

export interface ResolverDeps {
  db: Database.Database;
  storage: ReturnType<typeof createStorage>;
  secretStore: SecretStore;
  streamHeaders: StreamHeaderCache;
  getResumePosition: (mediaType: string, mediaId: string) => number;
  createOnlineClient: typeof createClient;
  newSessionId?: () => string;
}

interface OnlineServerBinding {
  id: number;
  type: 'jellyfin' | 'emby';
  baseUrl: string;
  apiKey: string;
  userId?: string;
}

/** STRICT server lookup by id (plan §4.1/§15: no cross-server fallthrough). */
export function bindOnlineServer(
  storage: ResolverDeps['storage'],
  secretStore: SecretStore,
  provider: 'jellyfin' | 'emby',
  serverId: number
): OnlineServerBinding {
  const servers = storage.getServers();
  const server = servers.find((s) => s.id === serverId);
  if (!server) {
    throw new ResolverError('SERVER_NOT_FOUND', '服务器不存在或已被移除');
  }
  if (server.type !== provider) {
    throw new ResolverError('SERVER_NOT_FOUND', '服务器类型不匹配');
  }
  const apiKey = resolveServerApiKey(server, secretStore);
  if (!apiKey) {
    throw new ResolverError('NO_CREDENTIAL', '服务器未登录，请先在设置中完成登录');
  }
  if (!server.user_id) {
    throw new ResolverError('NO_CREDENTIAL', '服务器缺少用户信息，请重新登录');
  }
  return {
    id: server.id,
    type: server.type as 'jellyfin' | 'emby',
    baseUrl: server.base_url,
    apiKey,
    userId: server.user_id,
  };
}

interface PlayableOnlineTarget {
  playId: string;
  title: string;
  seriesName?: string;
  seasonNumber?: number;
  episodeNumber?: number;
  mediaSourceId: string;
}

type OnlineClient = ReturnType<typeof createClient>;

/** Resolve a container (Series/Season/Folder) to its first playable child. */
async function resolvePlayableChild(
  client: OnlineClient,
  containerId: string,
  preferredMediaSourceId?: string
): Promise<PlayableOnlineTarget> {
  // Prefer the first episode with stable season/episode ordering.
  const episodes = (await client.getItems(containerId, {
    includeItemTypes: 'Episode',
    recursive: true,
    sortBy: 'ParentIndexNumber,IndexNumber',
    sortOrder: 'Ascending',
    limit: 1,
  })) as Array<{ Id: string; Name?: string; SeriesName?: string; ParentIndexNumber?: number; IndexNumber?: number }>;
  const first = episodes[0];
  if (first) {
    const details = await client.getItemDetails(first.Id);
    const ms = details.MediaSources ?? [];
    const pinned = preferredMediaSourceId ? ms.find((m) => m.Id === preferredMediaSourceId) : undefined;
    const chosen = pinned ?? ms[0];
    if (chosen) {
      return {
        playId: first.Id,
        title: first.Name ?? details.Name,
        seriesName: details.SeriesName ?? first.SeriesName,
        seasonNumber: details.ParentIndexNumber ?? first.ParentIndexNumber,
        episodeNumber: details.IndexNumber ?? first.IndexNumber,
        mediaSourceId: chosen.Id,
      };
    }
  }
  // Generic container fallback (e.g. Folder wrapping one movie).
  const children = (await client.getItems(containerId, {
    recursive: true,
    sortBy: 'SortName',
    limit: 20,
  })) as unknown as Array<Record<string, unknown>>;
  const playable = children.find(
    (it) => ((it.MediaSources as Array<unknown> | undefined)?.length ?? 0) > 0
  );
  if (playable) {
    const mediaSources = playable.MediaSources as Array<{ Id: string }>;
    return {
      playId: playable.Id as string,
      title: (playable.Name as string) ?? '',
      mediaSourceId: mediaSources[0].Id,
    };
  }
  throw new ResolverError('UNPLAYABLE', '未找到可播放的媒体文件');
}

export async function resolvePlayback(
  deps: ResolverDeps,
  input: ResolvePlaybackInput
): Promise<PlaybackResolution> {
  const mode: ResolveMode = input.mode === 'transcode' ? 'transcode' : 'direct';
  const ref = input.ref;

  // -- Local / WebDAV catalog sources ------------------------------------
  if (ref.provider === 'catalog') {
    const sourceId = ref.sourceId;
    const itemId = Number(ref.itemId);
    if (!Number.isInteger(itemId) || itemId <= 0) {
      throw new ResolverError('ITEM_NOT_FOUND', '条目不存在');
    }
    let intent: PlaybackIntent | null;
    let adapter;
    try {
      const queryService = createCatalogQueryService(deps.db);
      intent = queryService.getPlayback(sourceId, itemId);
      ({ adapter } = getAdapterForSource(deps.db, sourceId, deps.secretStore));
    } catch (err) {
      if (err instanceof ResolverError) throw err;
      throw new ResolverError('UNAVAILABLE', err instanceof Error ? err.message : '来源不可用');
    }
    if (!intent) {
      throw new ResolverError('ITEM_NOT_FOUND', '条目不存在或没有可播放的文件');
    }

    if (adapter.kind === 'local') {
      // Containment-checked absolute path; the stored relative path can
      // never escape the source root.
      let path: string;
      try {
        path = (adapter as LocalSourceAdapter).resolveInside(intent.relativePath);
      } catch (err) {
        throw new ResolverError('UNAVAILABLE', err instanceof Error ? err.message : '路径不可用');
      }
      // Progress keys stay path-based for local files (migration-compatible).
      const startPosition = deps.getResumePosition('local', path);
      return {
        kind: 'local-file',
        url: path,
        startPosition,
        mediaContext: {
          mediaType: 'local',
          mediaId: path,
          title: intent.title,
          seriesName: intent.seriesTitle,
          seasonNumber: intent.seasonNumber,
          episodeNumber: intent.episodeNumber,
        },
      };
    }

    // WebDAV: mpv streams the https URL; auth travels as a stashed header
    // the renderer hands back as an opaque session id.
    const base = parseWebDavBaseUrl(
      getAdapterForSource(deps.db, sourceId, deps.secretStore).root
    );
    const requestPath = relativePathToRequestPath(intent.relativePath, base);
    const url = `${new URL(base.url).origin}${requestPath}`;
    const secret = loadWebDavSecret(deps.secretStore, sourceId);
    const newId = deps.newSessionId ?? randomUUID;
    let streamSessionId: string | undefined;
    if (secret) {
      streamSessionId = newId();
      const token = Buffer.from(`${secret.username}:${secret.password}`).toString('base64');
      deps.streamHeaders.stash(streamSessionId, `Authorization: Basic ${token}`);
    }
    const mediaId = `${sourceId}:${intent.relativePath}`;
    return {
      kind: 'webdav-stream',
      url,
      ...(streamSessionId ? { streamSessionId } : {}),
      startPosition: deps.getResumePosition('webdav', mediaId),
      mediaContext: {
        mediaType: 'webdav',
        mediaId,
        title: intent.title,
        seriesName: intent.seriesTitle,
        seasonNumber: intent.seasonNumber,
        episodeNumber: intent.episodeNumber,
      },
    };
  }

  // -- Jellyfin / Emby: strict serverId routing ----------------------------
  const binding = bindOnlineServer(deps.storage, deps.secretStore, ref.provider, ref.serverId);
  const client = deps.createOnlineClient({
    type: binding.type,
    baseUrl: binding.baseUrl,
    apiKey: binding.apiKey,
    userId: binding.userId,
  });
  let details;
  try {
    details = await client.getItemDetails(ref.itemId);
  } catch (err) {
    throw new ResolverError('ITEM_NOT_FOUND', err instanceof Error ? `获取详情失败: ${err.message}` : '获取详情失败');
  }
  if (!details) {
    throw new ResolverError('ITEM_NOT_FOUND', '条目不存在');
  }

  let target: PlayableOnlineTarget;
  const mediaSources = details.MediaSources ?? [];
  const pinned = input.mediaSourceId ? mediaSources.find((m) => m.Id === input.mediaSourceId) : undefined;
  const direct = pinned ?? mediaSources[0];
  if (direct) {
    target = {
      playId: ref.itemId,
      title: details.Name,
      seriesName: details.SeriesName,
      seasonNumber: details.ParentIndexNumber,
      episodeNumber: details.IndexNumber,
      mediaSourceId: direct.Id,
    };
  } else if (details.Type === 'Series' || details.Type === 'Season') {
    target = await resolvePlayableChild(client, ref.itemId, input.mediaSourceId);
  } else {
    target = await resolvePlayableChild(client, ref.itemId, input.mediaSourceId);
  }

  const newId = deps.newSessionId ?? randomUUID;
  const playSessionId = newId();
  const url = client.getStreamingUrl(target.playId, target.mediaSourceId, mode, playSessionId);
  let streamSessionId: string | undefined;
  if (mode === 'transcode') {
    // Transcode segments carry no api_key — the token is stashed main-side
    // as an mpv http header and handed back as an opaque session id.
    streamSessionId = newId();
    deps.streamHeaders.stash(streamSessionId, `X-Emby-Token: ${binding.apiKey}`);
  }
  const mediaType = binding.type;
  const startPosition = deps.getResumePosition(mediaType, target.playId);
  return {
    kind: mode === 'transcode' ? 'online-transcode' : 'online-direct',
    url,
    ...(streamSessionId ? { streamSessionId } : {}),
    startPosition,
    mediaContext: {
      mediaType,
      mediaId: target.playId,
      title: target.title,
      ...(target.seriesName ? { seriesName: target.seriesName } : {}),
      ...(target.seasonNumber !== undefined ? { seasonNumber: target.seasonNumber } : {}),
      ...(target.episodeNumber !== undefined ? { episodeNumber: target.episodeNumber } : {}),
      mediaSourceId: target.mediaSourceId,
    },
  };
}
