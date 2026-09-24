/**
 * 卡片展示用的两个小换算，给首页/搜索/海报卡共用。
 *
 * 分开存在的理由很简单：同一个 IP 的 kind 有两种写法——本地 catalog 表是小写
 * （`kind TEXT CHECK(kind IN ('movie','series','season','episode','video'))`），
 * 在线来源直接透传 Jellyfin/Emby 的 `Type`（`Movie` / `Series` / `Episode`）。
 * 以前各处各自比字符串，`Episode` 因为比不过小写分支就兜底成 `Movie`——
 * 「继续观看」里一整部电视剧被标成了电影。
 */

/** kind → 展示类型（PosterCard 的 TYPE_LABELS 只认下面这几个键）。 */
export function mediaTypeFromKind(kind?: string): string {
  switch ((kind ?? '').toLowerCase()) {
    case 'series':
      return 'Series';
    case 'episode':
      return 'Episode';
    case 'season':
      return 'Season';
    case 'video':
      return 'Video';
    default:
      return 'Movie';
  }
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * `S01E05`。两个编号都缺就没有东西可显示（返回空串），与详情页
 * SeriesResumeButton 的文案同一格式。
 */
export function episodeCode(seasonNumber?: number | null, episodeNumber?: number | null): string {
  if (seasonNumber == null && episodeNumber == null) return '';
  return `S${pad(seasonNumber ?? 0)}E${pad(episodeNumber ?? 0)}`;
}
