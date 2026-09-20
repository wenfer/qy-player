/**
 * 「当前播放的音乐」（QYP3-053）。
 *
 * 用户诉求：**播放音频不记历史**，只需要保存"上次在放哪首、放到哪"。
 * 所以音乐不再写 `watch_history` / `playback_progress`（那两张表是影视的
 * 观看历史），改成 `app_config` 里的一条记录：
 *
 * - 下次启动把播放条恢复出来（曲目 + 进度，**不自动出声**）
 * - 点同一首歌**从头播**（不再有 per-track 续播）
 * - 服务器（Emby/Jellyfin）回传照旧——只是本地不留痕
 *
 * 形态照 `ui-shell/window-state.ts`：纯解析 + 只依赖 config 读写两件事，
 * 便于单测；任何一处不合法都当作"没有记录"，宁可空手启动也不崩。
 */

export const NOW_PLAYING_KEY = 'music.nowPlaying';

/** 记录类型：track = 本地/WebDAV 音轨（music_tracks 行）；server = 服务器条目。 */
export type NowPlayingKind = 'track' | 'server';

export interface NowPlayingRecord {
  type: NowPlayingKind;
  /** type = 'track'：music_tracks 的定位键。 */
  sourceId?: number;
  trackId?: number;
  /** type = 'server'：Jellyfin/Emby 条目。 */
  serverId?: number;
  provider?: 'jellyfin' | 'emby';
  itemId?: string;
  title: string;
  artist?: string | null;
  albumartist?: string | null;
  duration?: number | null;
  /** 上次离开时的播放位置（秒）。 */
  position: number;
  updatedAt: number;
}

/** 只需要 config 读写两件事，避免这里依赖整个 Storage 接口。 */
export interface ConfigStore {
  getConfig(key: string): string | undefined;
  setConfig(key: string, value: string): void;
}

/** 标题/条目 id 的长度上限：防御性地挡住畸形配置（正常值远小于此）。 */
const MAX_TITLE_LENGTH = 512;
const MAX_ID_LENGTH = 1024;

function finiteNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function positiveInt(v: unknown): number | null {
  const n = finiteNumber(v);
  return n !== null && Number.isInteger(n) && n > 0 ? n : null;
}

function optionalText(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_TITLE_LENGTH ? v : null;
}

/**
 * 解析落盘记录。**任何一处不合法都返回 null**（坏 JSON、缺 title、position
 * 非有限/为负、type 对应的定位键缺失）——启动路径上没有重试机会，宁可当
 * 作没有记录，也不要拿半条数据去喂播放器。
 */
export function parseNowPlaying(raw: string | undefined): NowPlayingRecord | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const o = parsed as Record<string, unknown>;

  const type = o.type;
  if (type !== 'track' && type !== 'server') return null;

  const title = optionalText(o.title);
  if (!title) return null;

  const position = finiteNumber(o.position);
  if (position === null || position < 0) return null;

  const durationRaw = finiteNumber(o.duration);
  const duration = durationRaw !== null && durationRaw > 0 ? durationRaw : null;
  const updatedAt = finiteNumber(o.updatedAt);
  const base = {
    title,
    artist: optionalText(o.artist),
    albumartist: optionalText(o.albumartist),
    duration,
    position,
    updatedAt: updatedAt ?? Date.now(),
  };

  if (type === 'track') {
    const sourceId = positiveInt(o.sourceId);
    const trackId = positiveInt(o.trackId);
    // 本地音轨的解析永远按 (sourceId, trackId) 查 music_tracks —— 不持久化
    // path/codec，避免配置里出现绝对路径
    if (sourceId === null || trackId === null) return null;
    return { ...base, type, sourceId, trackId };
  }

  const serverId = positiveInt(o.serverId);
  const itemId = optionalText(o.itemId);
  if (serverId === null || !itemId || itemId.length > MAX_ID_LENGTH) return null;
  return { ...base, type, serverId, itemId, provider: o.provider === 'emby' ? 'emby' : 'jellyfin' };
}

export function serializeNowPlaying(record: NowPlayingRecord): string {
  return JSON.stringify(record);
}

export function readNowPlaying(store: ConfigStore): NowPlayingRecord | null {
  try {
    return parseNowPlaying(store.getConfig(NOW_PLAYING_KEY));
  } catch {
    return null; // 库还没就绪之类的意外：当作没有记录
  }
}

/** 落盘（失败静默：这是非关键路径，不能影响播放或退出流程）。 */
export function writeNowPlaying(store: ConfigStore, record: NowPlayingRecord): void {
  try {
    store.setConfig(NOW_PLAYING_KEY, serializeNowPlaying(record));
  } catch {
    // 忽略
  }
}

/** 清空（app_config 无删除接口，写空串即可让 parse 判定为"没有记录"）。 */
export function clearNowPlaying(store: ConfigStore): void {
  try {
    store.setConfig(NOW_PLAYING_KEY, '');
  } catch {
    // 忽略
  }
}
