import { dirname, basename, extname, join } from 'path';
import { readdirSync, existsSync } from 'fs';
import { detectLanguage } from './lang-map';

export interface SubtitleTrack {
  path: string;
  title: string;
  language: string;
  languageCode: string;
  isDefault: boolean;
}

const SUBTITLE_EXTS = new Set(['.srt', '.ass', '.ssa', '.sub', '.vtt']);

export function scanForSubtitles(videoPath: string): SubtitleTrack[] {
  const dir = dirname(videoPath);
  const videoName = basename(videoPath, extname(videoPath));
  const tracks: SubtitleTrack[] = [];

  // Scan same directory
  tracks.push(...scanDirectory(dir, videoName));

  // Scan Subs/ Subtitles/ sub/ subtitle/ directories
  const subDirs = ['Subs', 'Subtitles', 'sub', 'subtitle'];
  for (const subDir of subDirs) {
    const subPath = join(dir, subDir);
    if (existsSync(subPath)) {
      tracks.push(...scanDirectory(subPath, videoName));
    }
  }

  // Sort: default language first, then by path
  return tracks.sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
    return a.path.localeCompare(b.path);
  });
}

function scanDirectory(dir: string, videoName: string): SubtitleTrack[] {
  const tracks: SubtitleTrack[] = [];

  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const ext = extname(entry).toLowerCase();
      if (!SUBTITLE_EXTS.has(ext)) continue;

      const entryName = basename(entry, ext);
      // Match if entry name starts with video name (fuzzy match)
      if (entryName === videoName || entryName.startsWith(videoName + '.')) {
        const fullPath = join(dir, entry);
        const lang = detectLanguage(entry);
        tracks.push({
          path: fullPath,
          title: `${lang.name} (${ext.slice(1).toUpperCase()})`,
          language: lang.name,
          languageCode: lang.code,
          isDefault: lang.code === 'zh' || lang.code === 'en',
        });
      }
    }
  } catch {
    // Ignore inaccessible directories
  }

  return tracks;
}

export function selectBestSubtitle(
  tracks: SubtitleTrack[],
  preferredLang = 'zh'
): SubtitleTrack | undefined {
  if (tracks.length === 0) return undefined;

  // Exact match preferred language
  const exact = tracks.find((t) => t.languageCode === preferredLang);
  if (exact) return exact;

  // Fallback to any Chinese variant
  if (preferredLang.startsWith('zh')) {
    const chinese = tracks.find((t) => t.languageCode.startsWith('zh'));
    if (chinese) return chinese;
  }

  // Fallback to English
  const english = tracks.find((t) => t.languageCode === 'en');
  if (english) return english;

  // Return first available
  return tracks[0];
}
