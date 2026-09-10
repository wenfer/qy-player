import { JellyfinClient } from './jellyfin-client';
import { EmbyClient } from './emby-client';

export { JellyfinClient, EmbyClient };
export type * from './jellyfin-client';

/** Main-side client config (QYP2-015): tokens live here, never in shared types. */
export interface OnlineClientConfig {
  type: 'jellyfin' | 'emby';
  baseUrl: string;
  apiKey?: string;
  userId?: string;
}

export function createClient(server: OnlineClientConfig): JellyfinClient | EmbyClient {
  if (server.type === 'emby') {
    return new EmbyClient(server.baseUrl, server.apiKey, server.userId);
  }
  return new JellyfinClient(server.baseUrl, server.apiKey, server.userId);
}

// Bitrate mapping for resolution selection
export const RESOLUTION_BITRATES = {
  'original': undefined,
  '1080p': 10_000_000,
  '720p': 4_000_000,
  '480p': 2_000_000,
} as const;

export type Resolution = keyof typeof RESOLUTION_BITRATES;
