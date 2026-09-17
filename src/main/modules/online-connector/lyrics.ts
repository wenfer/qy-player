import type { JellyfinLyrics } from './jellyfin-client';

/**
 * 服务器歌词 → LRC 文本（QYP3-020b）。
 *
 * Jellyfin 10.9+ 的 `/Audio/{id}/Lyrics` 返回结构化行（Text + Start ticks），
 * 本地歌词全部按 LRC 文本流转（面板/桌面歌词共用 lrc-parser 的纯函数），
 * 所以服务器歌词在这里一次性归一成 LRC，下游不需要第二套解析。
 */

const TICKS_PER_SECOND = 10_000_000;

/** `[mm:ss.xx]`（与 lrc-parser 支持的标准行级标签一致）。 */
function lrcStamp(seconds: number): string {
  const total = Math.max(0, seconds);
  const minutes = Math.floor(total / 60);
  const rest = total - minutes * 60;
  return `[${String(minutes).padStart(2, '0')}:${rest.toFixed(2).padStart(5, '0')}]`;
}

/**
 * 结构化歌词 → LRC 文本。空行/无文本行丢弃；缺 Start（老版本服务器或
 * 纯文本歌词）落在 0 秒。无有效行时返回 null（= 无词，桌面歌词隐藏）。
 */
export function lyricsToLrc(lyrics: JellyfinLyrics | null | undefined): string | null {
  const lines = lyrics?.Lyrics;
  if (!Array.isArray(lines)) return null;
  const out: string[] = [];
  for (const line of lines) {
    const text = typeof line?.Text === 'string' ? line.Text.trim() : '';
    if (!text) continue;
    const start =
      typeof line.Start === 'number' && Number.isFinite(line.Start) && line.Start > 0
        ? line.Start / TICKS_PER_SECOND
        : 0;
    out.push(`${lrcStamp(start)}${text}`);
  }
  return out.length > 0 ? out.join('\n') : null;
}
