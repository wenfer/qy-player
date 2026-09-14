/** 音乐库共享类型（三期 QYP3-008）。 */

/** 单音轨（专辑视图/列表用；不含 path 之外的敏感字段）。 */
export interface MusicTrackRow {
  id: number;
  source_id: number;
  path: string;
  title: string;
  artist: string | null;
  album: string | null;
  albumartist: string | null;
  track_no: number | null;
  disc_no: number | null;
  year: number | null;
  duration: number | null;
  codec: string | null;
  bitrate: number | null;
  has_cover: number;
  has_lyrics: number;
}

/** 专辑聚合（网格视图，页 ≤200，§16.4）。 */
export interface MusicAlbumRow {
  albumartist: string | null;
  album: string | null;
  track_count: number;
  total_duration: number | null;
  year: number | null;
  /** 专辑内第一条有内嵌封面的音轨 id（封面 URL 用），无封面为 null。 */
  cover_track_id: number | null;
}
