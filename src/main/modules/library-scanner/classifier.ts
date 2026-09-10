/**
 * Media filename/path classifier (plan §6.2, QYP2-009).
 *
 * Pure string analysis: no filesystem, no database, no I/O. Single source
 * of truth for video extension lists so no adapter copies its own set.
 * Low-confidence content must degrade to kind 'video', never be guessed
 * into movie/episode (plan §6.2).
 */

export const VIDEO_EXTENSIONS: ReadonlySet<string> = new Set([
  '.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v', '.mpg',
  '.mpeg', '.m2ts', '.ts', '.vob', '.ogv', '.3gp', '.rmvb', '.rm', '.asf',
  '.divx', '.f4v',
]);

const NFO_EXTENSIONS: ReadonlySet<string> = new Set(['.nfo']);
const SIDECAR_EXTENSIONS: ReadonlySet<string> = new Set([
  '.jpg', '.jpeg', '.png', '.tbn', // artwork
  '.srt', '.ass', '.ssa', '.sub', '.smi', // subtitles
]);

export type MediaFileClass = 'video' | 'nfo' | 'sidecar' | 'ignored';

export interface EpisodeInfo {
  season: number;
  episode: number;
  /** Multi-episode file: the last covered episode (inclusive). */
  episodeEnd?: number;
  seriesTitle: string;
  episodeTitle?: string;
}

export interface Classification {
  fileClass: MediaFileClass;
  isSample: boolean;
  isExtra: boolean;
  episode?: EpisodeInfo;
  movie?: { title: string; year?: number };
  /** Low-confidence fallback title (kind stays 'video'). */
  videoTitle?: string;
  /** 'high' = trusted movie/episode parse; 'low' = generic video. */
  confidence: 'high' | 'low';
}

/** Season-directory segment: "Season 01", "S1", "Specials" → 0. */
const SEASON_DIR = /^(?:season)[\s._-]?(\d{1,2})$/i;
const SEASON_DIR_SHORT = /^s(\d{1,2})$/i;
const SPECIALS_DIR = /^specials$/i;

/** SxxExy with up to two extra episode numbers (multi-episode files). */
const EPISODE_SXE = /^(.*?)[\s.(\[-]*s(\d{1,2})[\s._-]?e(\d{1,3})((?:[\s._-]?e[\s._-]?\d{1,3}){0,2})[\s.)_-]*(.*)$/i;
/** 1x02 style. */
const EPISODE_X = /^(.*?)[\s.(\[-]*(\d{1,2})x(\d{1,3})[\s.)_-]*(.*)$/i;
/** Bare episode number, only trusted inside a season directory. */
const BARE_NUMBER = /^[(\s]*(\d{1,3})[)\s]*$/;
/** "E03" / "EP03", only trusted inside a season directory. */
const E_PREFIX = /^e(?:p)?[\s._-]*(\d{1,3})$/i;
/** Four-digit year. */
const YEAR = /[\(\[\s._-](19\d{2}|20\d{2})(?=[\)\]\s._-]|$)/;
/** Common release tags stripped from titles (from the end). */
const RELEASE_TAG = /^(?:\d{3,4}[pi]|blu-?ray|web-?dl|webrip|hdrip|brrip|dvdrip|hdtv|h\.?264|x264|x265|h\.?265|hevc|aac|dts(?:-hd)?|ac3|ddp?5\.1|truehd|atmos|hdr|hdr10|dv|dolby|vision|10bit|8bit|remux|repack|proper|extended|unrated|remastered|imax|60fps)$/i;
const SAMPLE = /^sample(?:[\s._-].*)?$/i;
const EXTRA_MARKERS: ReadonlyArray<RegExp> = [
  /^(?:trailer|featurette|extras|other|interview|interviews)(?:[\s._-].*)?$/i,
  /^deleted(?:[.\s_-])?scenes(?:[\s._-].*)?$/i,
  /^behind(?:[.\s_-])?the(?:[.\s_-])?scenes(?:[\s._-].*)?$/i,
  /^making(?:[.\s_-])?of(?:[\s._-].*)?$/i,
];

/** Collapse separators into spaces and trim. */
function cleanTitle(raw: string): string {
  return raw.replace(/[._]+/g, ' ').replace(/\s*-\s*/g, ' - ').replace(/[\s_]+/g, ' ').trim();
}

/** Strip trailing release tags ("1080p BluRay x264"); may return ''. */
function stripReleaseTags(title: string): string {
  const parts = title.split(' ');
  while (parts.length > 0 && RELEASE_TAG.test(parts[parts.length - 1])) {
    parts.pop();
  }
  return parts.join(' ').trim();
}

/** Stable identity key from a display name (ADR-0001: key is data). */
export function normalizeNameKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[._-]+/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^the\s+/i, '');
}

function extensionOf(path: string): string {
  const name = path.split('/').pop() ?? path;
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot).toLowerCase();
}

function fileClassOf(ext: string): MediaFileClass {
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  if (NFO_EXTENSIONS.has(ext)) return 'nfo';
  if (SIDECAR_EXTENSIONS.has(ext)) return 'sidecar';
  return 'ignored';
}

/** Extract year from a title-ish string; returns the cleaned remainder. */
function extractYear(text: string): { title: string; year?: number } {
  const matches = [...text.matchAll(new RegExp(YEAR.source, 'g'))];
  if (matches.length === 0) return { title: stripReleaseTags(cleanTitle(text)) };
  const last = matches[matches.length - 1];
  const year = Number(last[1]);
  const title = stripReleaseTags(cleanTitle(text.slice(0, last.index)));
  return { title, year };
}

/** Find the deepest season-directory context in the path segments. */
function seasonContext(dirs: string[]): { season: number; segmentIndex: number } | null {
  let found: { season: number; segmentIndex: number } | null = null;
  dirs.forEach((segment, index) => {
    const m = segment.match(SEASON_DIR) ?? segment.match(SEASON_DIR_SHORT);
    if (m) {
      found = { season: Number(m[1]), segmentIndex: index };
      return;
    }
    if (SPECIALS_DIR.test(segment)) {
      found = { season: 0, segmentIndex: index };
    }
  });
  return found;
}

function episodeFromBare(base: string): number | null {
  const bare = base.match(BARE_NUMBER);
  if (bare) return Number(bare[1]);
  const prefixed = base.match(E_PREFIX);
  if (prefixed) return Number(prefixed[1]);
  return null;
}

/**
 * Classify one path (segments separated by '/'; the last segment is the
 * filename). Pure: the same input always yields the same classification.
 */
export function classifyPath(relativePath: string): Classification {
  const segments = relativePath.split('/');
  const fileName = segments[segments.length - 1];
  const dirs = segments.slice(0, -1);
  const ext = extensionOf(fileName);
  const fileClass = fileClassOf(ext);
  const base = fileClass === 'video' ? fileName.slice(0, fileName.length - ext.length) : '';

  const isSample = fileClass === 'video' && SAMPLE.test(base);
  const isExtra = fileClass === 'video' && !isSample && EXTRA_MARKERS.some((re) => re.test(base));

  if (fileClass !== 'video') {
    return { fileClass, isSample: false, isExtra: false, confidence: 'low' };
  }

  const ctx = seasonContext(dirs);

  // SxxExy (+ multi-episode).
  const sxe = base.match(EPISODE_SXE);
  if (sxe) {
    const seriesTitle = cleanTitle(sxe[1]);
    const season = Number(sxe[2]);
    const first = Number(sxe[3]);
    const extras = [...sxe[4].matchAll(/e[\s._-]?(\d{1,3})/gi)].map((m) => Number(m[1]));
    const episodeTitle = stripReleaseTags(cleanTitle(sxe[5])) || undefined;
    if (seriesTitle) {
      const end = extras.length > 0 ? Math.max(...extras) : undefined;
      const episodeEnd = end !== undefined && end > first ? end : undefined;
      return {
        fileClass,
        isSample,
        isExtra,
        confidence: 'high',
        episode: {
          season,
          episode: first,
          ...(episodeEnd ? { episodeEnd } : {}),
          seriesTitle,
          ...(episodeTitle ? { episodeTitle } : {}),
        },
      };
    }
  }

  // N x MM style.
  const xform = base.match(EPISODE_X);
  if (xform && xform[1].trim()) {
    return {
      fileClass,
      isSample,
      isExtra,
      confidence: 'high',
      episode: { season: Number(xform[2]), episode: Number(xform[3]), seriesTitle: cleanTitle(xform[1]) },
    };
  }

  // Season-directory context: series title from the enclosing directory.
  if (ctx) {
    const beforeSeason = dirs.slice(0, ctx.segmentIndex).filter(
      (segment) => !(SEASON_DIR.test(segment) || SEASON_DIR_SHORT.test(segment) || SPECIALS_DIR.test(segment))
    );
    const seriesTitle = beforeSeason.length > 0 ? cleanTitle(beforeSeason[beforeSeason.length - 1]) : '';
    const episodeNumber = episodeFromBare(base);
    if (seriesTitle && episodeNumber !== null) {
      return {
        fileClass,
        isSample,
        isExtra,
        confidence: 'high',
        episode: { season: ctx.season, episode: episodeNumber, seriesTitle },
      };
    }
  }

  // Movie candidate (grouping/main-file selection happens in the scanner).
  const { title, year } = extractYear(base);
  if (year !== undefined && title) {
    return {
      fileClass,
      isSample,
      isExtra,
      confidence: 'high',
      movie: { title, year },
    };
  }

  return {
    fileClass,
    isSample,
    isExtra,
    confidence: 'low',
    videoTitle: stripReleaseTags(cleanTitle(base)) || fileName,
  };
}
