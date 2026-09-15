/**
 * 歌单导入/导出（QYP3-016/017，计划 §3）。
 *
 * 格式契约：
 * - 导入：m3u/m3u8（相对路径基准=文件所在目录；EXTINF 解析标题）。
 * - 导出：m3u8（本地项相对路径 + EXTINF；WebDAV 项写完整 URL，
 *   凭据绝不内嵌）+ XSPF（全来源 URL 化）。
 * - 导入匹配：绝对/相对路径 → 在全部音乐来源里找 basename 唯一命中；
 *   无法定位的行保留占位（null）并在报告里计数，绝不静默丢弃。
 * - item_ref 契约：`music:<sourceId>:<trackId>`。
 */

import type Database from 'better-sqlite3';

export interface PlaylistTrackInfo {
  trackId: number;
  sourceId: number;
  sourceKind: 'local' | 'webdav' | 'server';
  title: string;
  artist: string | null;
  /** 导出用：本地绝对路径 / WebDAV 完整 URL / null（服务器音频）。 */
  location: string | null;
  duration: number | null;
}

export interface M3uImportLine {
  /** 定位到的音轨（sourceId/trackId），未定位为 null。 */
  track: { sourceId: number; trackId: number; title: string } | null;
  title: string;
  location: string;
}

export interface M3uImportResult {
  matched: M3uImportLineResult[];
  unmatched: string[];
}

export interface M3uImportLineResult {
  ref: string;
  title: string;
}

export interface ParsedM3uLine {
  location: string;
  title: string;
}

/** 解析 m3u/m3u8 文本（EXTINF 标题可选；#EXTM3U 头可选；BOM 容错）。 */
export function parseM3u(content: string): ParsedM3uLine[] {
  const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/);
  const out: ParsedM3uLine[] = [];
  let pendingTitle: string | null = null;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#EXTM3U')) continue;
    if (line.startsWith('#EXTINF')) {
      // #EXTINF:duration,Artist - Title
      const comma = line.indexOf(',');
      if (comma !== -1) pendingTitle = line.slice(comma + 1).trim() || null;
      continue;
    }
    if (line.startsWith('#')) continue; // 其它注释忽略
    out.push({ location: line, title: pendingTitle ?? locationTitleOf(line) });
    pendingTitle = null;
  }
  return out;
}

/** 从路径/URL 提取显示标题（无扩展名）。 */
export function locationTitleOf(location: string): string {
  const base = location.split(/[\\/]/).pop() ?? location;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * 基准目录解析：相对路径行 → 文件所在目录（m3u 规范）。
 * `C:\music\a.mp3` / `/srv/a.mp3` / `a.mp3` → 拼基准。
 */
export function resolveM3uLocation(location: string, baseDir: string | null): string {
  const isAbsolute = /^([a-zA-Z]:[\\/]|https?:\/\/|\/|\\\\)/.test(location);
  if (isAbsolute || !baseDir) return location;
  return `${baseDir.replace(/[\\/]+$/, '')}/${location}`;
}

/**
 * 把 m3u 行匹配到 music_tracks：先 basename 精确唯一匹配，再按
 * 相对路径后缀匹配。返回 ref 或 null（未定位）。
 */
export function matchM3uLocationToTrack(
  location: string,
  catalog: ReadonlyArray<{
    trackId: number;
    sourceId: number;
    path: string;
    title: string;
  }>
): { sourceId: number; trackId: number; title: string } | null {
  const norm = (p: string): string => p.replace(/\\/g, '/').toLowerCase();
  const target = norm(location);
  // 1) 相对路径后缀匹配（最稳）
  const suffix = catalog.filter((c) => norm(c.path).endsWith(target.split('/').slice(-1)[0] === '' ? norm(c.path) : `/${norm(c.path)}`) || norm(c.path) === target);
  // 精确 path 匹配优先
  const exact = catalog.find((c) => norm(c.path) === target);
  if (exact) return { sourceId: exact.sourceId, trackId: exact.trackId, title: exact.title };
  // basename 唯一匹配
  const basename = norm(target.split('/').pop() ?? target);
  const byBasename = catalog.filter((c) => norm(c.path).split('/').pop() === basename);
  if (byBasename.length === 1) return { sourceId: byBasename[0].sourceId, trackId: byBasename[0].trackId, title: byBasename[0].title };
  // 后缀匹配唯一
  const bySuffix = catalog.filter((c) => norm(c.path).endsWith(basename));
  if (bySuffix.length === 1) return { sourceId: bySuffix[0].sourceId, trackId: bySuffix[0].trackId, title: bySuffix[0].title };
  void suffix;
  return null;
}

/** m3u8 导出（纯函数）：本地项相对路径（基于导出目录）+ WebDAV URL。 */
export function exportM3u8(
  tracks: PlaylistTrackInfo[],
  exportBaseDir: string | null
): string {
  const lines = ['#EXTM3U'];
  for (const t of tracks) {
    const meta = `#EXTINF:${Math.max(0, Math.round(t.duration ?? -1))},${t.artist ? `${t.artist} - ` : ''}${t.title}`;
    lines.push(meta);
    let location: string;
    if (t.sourceKind === 'local' && t.location) {
      // 相对化（导出目录基准）；失败回退绝对路径
      if (exportBaseDir && t.location.startsWith(exportBaseDir.replace(/[\\/]+$/, ''))) {
        location = t.location.slice(exportBaseDir.length).replace(/^[/\\]/, '');
      } else {
        location = t.location;
      }
    } else {
      location = t.location ?? `music:track:${t.trackId}`; // 占位（WebDAV null 凭据已由调用方处理）
    }
    lines.push(location);
  }
  return lines.join('\n') + '\n';
}

/** XSPF 导出（纯函数，1.0 规范最小集）。 */
export function exportXspf(tracks: PlaylistTrackInfo[], playlistName: string): string {
  const esc = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const body = tracks
    .map((t) => {
      const loc =
        t.sourceKind === 'local' && t.location
          ? `file://${encodeURI(t.location.startsWith('/') ? t.location : `/${t.location}`)}`
          : t.location ?? '';
      const artist = t.artist ? `        <creator>${esc(t.artist)}</creator>\n` : '';
      return `    <track>\n      <title>${esc(t.title)}</title>\n${artist}      <location>${loc}</location>\n      <meta rel="qy:trackId">${t.trackId}</meta>\n    </track>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<playlist version="1" xmlns="http://xspf.org/ns/0/">
  <title>${esc(playlistName)}</title>
  <trackList>
${body}
  </trackList>
</playlist>
`;
}

/** 把 catalog 查询结果（repository listMusicTracksPaged 语义）转导出行。 */
export interface ExportCatalogRow {
  trackId: number;
  sourceId: number;
  sourceKind: 'local' | 'webdav';
  sourceRoot: string;
  title: string;
  artist: string | null;
  duration: number | null;
  path: string;
}

export function toExportInfo(row: ExportCatalogRow): PlaylistTrackInfo {
  return {
    trackId: row.trackId,
    sourceId: row.sourceId,
    sourceKind: row.sourceKind,
    title: row.title,
    artist: row.artist,
    location:
      row.sourceKind === 'local'
        ? `${row.sourceRoot.replace(/[\\/]+$/, '')}/${row.path}`
        : webdavLocation(row.sourceRoot, row.path), // 凭据不在 sourceRoot 里（不落盘契约）
    duration: row.duration,
  };
}

/** WebDAV 导出 URL（base + relativePath；不含凭据）。 */
export function webdavLocation(baseUrl: string, relativePath: string): string {
  const base = baseUrl.replace(/[\\/]+$/, '');
  return `${base}/${relativePath.split('/').map(encodeURIComponent).join('/')}`;
}

/** 导入：逐行匹配 + 报告（主进程 orchestrator 用）。 */
export function importM3u(
  content: string,
  baseDir: string | null,
  catalog: ReadonlyArray<{ trackId: number; sourceId: number; path: string; title: string }>
): { refs: Array<{ ref: string; title: string }>; unmatched: string[] } {
  const lines = parseM3u(content);
  const refs: Array<{ ref: string; title: string }> = [];
  const unmatched: string[] = [];
  for (const line of lines) {
    const resolved = resolveM3uLocation(line.location, baseDir);
    const track = matchM3uLocationToTrack(resolved, catalog);
    if (track) {
      unmatched.length;
      const ref = `music:${track.sourceId}:${track.trackId}`;
      if (!unmatched.includes(resolved)) {
        // matched
      }
      refs.push({ ref, title: line.title || track.title });
    } else {
      unmatched.push(resolved);
    }
  }
  return { refs, unmatched };
}

/** 读取整库音轨目录（导入匹配用；不含敏感字段）。 */
export function listTrackCatalog(db: Database.Database): Array<{ trackId: number; sourceId: number; path: string; title: string }> {
  return db
    .prepare('SELECT id AS trackId, source_id AS sourceId, path, title FROM music_tracks')
    .all() as Array<{ trackId: number; sourceId: number; path: string; title: string }>;
}
