/**
 * 服务器音乐浏览（QYP3-025）：纯函数映射层。
 *
 * 只做"服务器条目 → UI 结构"的归一与容错：Jellyfin/Emby 的 Items 响应
 * 字段可能缺失（旧版本、不同库类型），缺字段一律降级而不是抛错。
 * 服务器音乐不落本地库（以服务器为准，避免与扫描音轨双份），
 * 播放走 mpv 引擎（ADR-0007：服务器 → mpv）。
 */

export interface ServerLibraryGroup {
  serverId: number;
  serverName: string;
  serverType: string;
  /** 服务器视图（未登录/请求失败时可能缺失）。 */
  views?: Array<{ Id?: string; id?: string; Name?: string; CollectionType?: string }>;
  error?: string;
}

export interface MusicLibraryRef {
  serverId: number;
  serverName: string;
  serverType: string;
  viewId: string;
  viewName: string;
}

/** 挑出所有音乐库（CollectionType = music）。 */
export function pickMusicLibraries(groups: ServerLibraryGroup[]): MusicLibraryRef[] {
  const out: MusicLibraryRef[] = [];
  for (const group of groups) {
    if (group.error) continue;
    for (const view of group.views ?? []) {
      if ((view.CollectionType ?? '').toLowerCase() !== 'music') continue;
      const viewId = view.Id ?? view.id;
      if (!viewId) continue;
      out.push({
        serverId: group.serverId,
        serverName: group.serverName,
        serverType: group.serverType,
        viewId,
        viewName: view.Name ?? '音乐库',
      });
    }
  }
  return out;
}

export interface ServerAlbum {
  id: string;
  name: string;
  artist: string | null;
  year: number | null;
  /** 主图 tag（拼图片 URL 用；无图则 null）。 */
  tag: string | null;
}

export interface ServerTrack {
  id: string;
  name: string;
  artist: string | null;
  album: string | null;
  duration: number | null;
  index: number | null;
}

interface RawItem {
  Id?: string;
  Name?: string;
  AlbumArtist?: string;
  Album?: string;
  Artists?: string[];
  ProductionYear?: number;
  RunTimeTicks?: number;
  IndexNumber?: number;
  ImageTags?: { Primary?: string };
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

export function mapServerAlbums(items: unknown[]): ServerAlbum[] {
  return (items as RawItem[])
    .filter((it) => str(it?.Id))
    .map((it) => ({
      id: it.Id as string,
      name: str(it.Name) ?? '未知专辑',
      artist: str(it.AlbumArtist) ?? (Array.isArray(it.Artists) ? str(it.Artists[0]) : null),
      year: typeof it.ProductionYear === 'number' ? it.ProductionYear : null,
      tag: str(it.ImageTags?.Primary),
    }));
}

export function mapServerTracks(items: unknown[]): ServerTrack[] {
  return (items as RawItem[])
    .filter((it) => str(it?.Id))
    .map((it) => ({
      id: it.Id as string,
      name: str(it.Name) ?? '未知曲目',
      artist: str(it.AlbumArtist) ?? (Array.isArray(it.Artists) ? str(it.Artists[0]) : null),
      album: str(it.Album),
      duration: typeof it.RunTimeTicks === 'number' ? it.RunTimeTicks / 10_000_000 : null,
      index: typeof it.IndexNumber === 'number' ? it.IndexNumber : null,
    }));
}
