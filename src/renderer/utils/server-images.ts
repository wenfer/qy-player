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

/**
 * Build a Primary/backdrop image URL for an item.
 * Returns undefined when the owning server cannot be resolved.
 */
export function buildImageUrl(
  serverMap: Map<number, ServerEntry>,
  serverId: number | undefined,
  serverType: string,
  itemId: string,
  imageType = 'Primary',
  tag?: string,
  maxHeight = 500
): string | undefined {
  const server = serverId !== undefined ? serverMap.get(serverId) : undefined;
  if (!server) return undefined;
  const prefix = serverType === 'emby' ? '/emby' : '';
  const tagParam = tag ? `&tag=${tag}` : '';
  return `${server.base_url}${prefix}/Items/${itemId}/Images/${imageType}?maxHeight=${maxHeight}&quality=90${tagParam}`;
}
