/**
 * Shared helpers for building media-server image URLs.
 * Replaces the old hardcoded `http://localhost:8096` URLs so images
 * load from whichever server the item actually belongs to.
 */

export interface ServerEntry {
  id: number;
  name: string;
  type: string;
  base_url: string;
  user_id?: string;
  is_active: number;
}

/** Load active servers and build an id -> server map. */
export async function getServerMap(): Promise<Map<number, ServerEntry>> {
  const servers = (await window.electronAPI.getServers()) as ServerEntry[];
  return new Map(servers.filter((s) => s.is_active).map((s) => [s.id, s]));
}

/** Find the first active server of the given type (single-server fallback). */
export function findServerByType(
  servers: ServerEntry[],
  type: string
): ServerEntry | undefined {
  return servers.find((s) => s.is_active && s.type === type);
}

export interface ServerMediaItemLike {
  Id?: string;
  id?: string;
  Name?: string;
  ImageTags?: {
    Primary?: string;
    Thumb?: string;
    Backdrop?: string;
    [key: string]: string | undefined;
  };
  PrimaryImageItemId?: string;
  PrimaryImageTag?: string;
  BackdropImageTags?: string[];
  ParentThumbItemId?: string;
  ParentThumbImageTag?: string;
}

/**
 * Resolve the itemId and tag to use for an item's Primary image.
 * Handles Emby's inheritance where ImageTags is empty but PrimaryImageItemId & PrimaryImageTag
 * are provided, or returns undefined if the item has no image so UI can show a fallback placeholder.
 */
export function resolveItemPrimaryImage(
  item: ServerMediaItemLike | undefined | null
): { itemId: string; tag?: string } | undefined {
  if (!item) return undefined;
  const selfId = item.Id ?? item.id;
  if (item.ImageTags?.Primary && selfId) {
    return { itemId: selfId, tag: item.ImageTags.Primary };
  }
  if (item.PrimaryImageItemId) {
    return { itemId: item.PrimaryImageItemId, tag: item.PrimaryImageTag ?? item.ImageTags?.Primary };
  }
  if (item.PrimaryImageTag && selfId) {
    return { itemId: selfId, tag: item.PrimaryImageTag };
  }
  return undefined;
}

/**
 * Resolve the itemId and tag to use for an item's Thumb image.
 */
export function resolveItemThumbImage(
  item: ServerMediaItemLike | undefined | null
): { itemId: string; tag?: string } | undefined {
  if (!item) return undefined;
  const selfId = item.Id ?? item.id;
  if (item.ImageTags?.Thumb && selfId) {
    return { itemId: selfId, tag: item.ImageTags.Thumb };
  }
  if (item.ParentThumbItemId && item.ParentThumbImageTag) {
    return { itemId: item.ParentThumbItemId, tag: item.ParentThumbImageTag };
  }
  return undefined;
}

/**
 * Build a Primary/backdrop image URL for an item.
 * Routes through the local qy-file://image-cache disk cache by default,
 * avoiding repeated remote network pulls and supporting offline/unstable connections.
 * Set useCache = false to obtain the raw server URL.
 */
export function buildImageUrl(
  serverMap: Map<number, ServerEntry>,
  serverId: number | undefined,
  serverType: string,
  itemId: string,
  imageType = 'Primary',
  tag?: string,
  maxHeight = 500,
  useCache = true
): string | undefined {
  const server = serverId !== undefined ? serverMap.get(serverId) : undefined;
  if (!server) return undefined;
  const isEmby = (serverType || server.type) === 'emby';
  const prefix = isEmby ? '/emby' : '';
  const tagParam = tag ? `&tag=${tag}` : '';
  const remoteUrl = `${server.base_url}${prefix}/Items/${itemId}/Images/${imageType}?maxHeight=${maxHeight}&quality=90${tagParam}`;
  if (!useCache) return remoteUrl;
  const safeTag = tag ? tag.replace(/[^a-zA-Z0-9]/g, '') : 'default';
  const cacheKey = `s${server.id}-${itemId}-${imageType}-${safeTag}-${maxHeight}.jpg`;
  return `qy-file://image-cache/${cacheKey}?src=${encodeURIComponent(remoteUrl)}`;
}

/**
 * Build an image URL directly from a server media item, taking into account
 * Emby's PrimaryImageItemId, falling back gracefully to undefined if no image exists,
 * and routing through the local disk cache.
 */
export function buildItemImageUrl(
  serverMap: Map<number, ServerEntry>,
  serverId: number | undefined,
  serverType: string,
  item: ServerMediaItemLike | undefined | null,
  imageType: 'Primary' | 'Thumb' = 'Primary',
  maxHeight = 500,
  useCache = true
): string | undefined {
  const target = imageType === 'Thumb' ? resolveItemThumbImage(item) : resolveItemPrimaryImage(item);
  if (!target) return undefined;
  return buildImageUrl(serverMap, serverId, serverType, target.itemId, imageType, target.tag, maxHeight, useCache);
}
