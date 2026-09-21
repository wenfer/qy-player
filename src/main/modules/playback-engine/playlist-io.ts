/**
 * 歌单导出（QYP3-016/017，计划 §3）。
 *
 * 格式契约：
 * - 导出：m3u8（本地项相对路径 + EXTINF；WebDAV 项写完整 URL，
 *   凭据绝不内嵌）+ XSPF（全来源 URL 化）。
 * - m3u 导入功能已于 1.5.0 移除（QYP3-068k）：歌单只能在本应用内新建/编辑，
 *   不再从外部播放列表文件导入。
 * - item_ref 契约：`music:<sourceId>:<trackId>`。
 */

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

/**
 * 本地曲目的 file:// URL（QYP3-062）。
 *
 * 不用 node:url 的 pathToFileURL——它按**宿主平台**语义解析路径（Linux 上
 * 拿到 `C:\…` 会当相对路径解析进 cwd），导出的 URL 就不确定了。这里手工
 * 构造，三端行为一致：
 * - Windows 盘符路径（`C:\…` / `C:/…`）→ `file:///C:/…`（逐段编码）
 * - POSIX 绝对路径 → `file://` + encodeURI，**与历史输出逐字节一致**
 * - 其余（历史遗留的相对/非路径形态）保持旧的 `/${location}` 兜底
 */
export function localTrackFileUrl(location: string): string {
  if (/^[A-Za-z]:[\\/]/.test(location)) {
    const rest = location.slice(2).replace(/\\/g, '/');
    const segments = rest.split('/').filter((s) => s.length > 0);
    // slice(0,2) 已含冒号（'C:'），盘符大小写照原样保留
    return `file:///${location.slice(0, 2)}/${segments.map(encodeURIComponent).join('/')}`;
  }
  if (location.startsWith('/')) {
    return `file://${encodeURI(location)}`;
  }
  return `file://${encodeURI(`/${location}`)}`;
}

/** XSPF 导出（纯函数，1.0 规范最小集）。 */
export function exportXspf(tracks: PlaylistTrackInfo[], playlistName: string): string {
  const esc = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const body = tracks
    .map((t) => {
      const loc =
        t.sourceKind === 'local' && t.location
          ? localTrackFileUrl(t.location)
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
