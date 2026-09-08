export const LANGUAGE_MAP: Record<string, string> = {
  // Chinese variants
  'chs': 'zh',
  'cht': 'zh-Hant',
  'zh-cn': 'zh',
  'zh-tw': 'zh-Hant',
  'zh-hk': 'zh-Hant',
  'zh-sg': 'zh',
  'chinese': 'zh',
  '中文': 'zh',
  '简': 'zh',
  '繁': 'zh-Hant',

  // English
  'eng': 'en',
  'en': 'en',
  'english': 'en',

  // Japanese
  'jpn': 'ja',
  'jp': 'ja',
  'japanese': 'ja',
  '日': 'ja',

  // Korean
  'kor': 'ko',
  'ko': 'ko',
  'korean': 'ko',
  '韩': 'ko',

  // Spanish
  'spa': 'es',
  'es': 'es',
  'spanish': 'es',

  // French
  'fre': 'fr',
  'fra': 'fr',
  'fr': 'fr',
  'french': 'fr',

  // German
  'ger': 'de',
  'deu': 'de',
  'de': 'de',
  'german': 'de',

  // Russian
  'rus': 'ru',
  'ru': 'ru',
  'russian': 'ru',

  // Portuguese
  'por': 'pt',
  'pt': 'pt',
  'portuguese': 'pt',

  // Italian
  'ita': 'it',
  'it': 'it',
  'italian': 'it',

  // Arabic
  'ara': 'ar',
  'ar': 'ar',
  'arabic': 'ar',

  // Hindi
  'hin': 'hi',
  'hi': 'hi',
  'hindi': 'hi',

  // Thai
  'tha': 'th',
  'th': 'th',
  'thai': 'th',

  // Vietnamese
  'vie': 'vi',
  'vi': 'vi',
  'vietnamese': 'vi',
};

export function detectLanguage(filename: string): { code: string; name: string } {
  const lower = filename.toLowerCase();

  // Extract language tag from filename (e.g., Movie.zh.srt, Movie.chs.ass)
  const match = lower.match(/[.\[]([a-zA-Z0-9\u4e00-\u9fa5]+)[.\]]/);
  if (match) {
    const tag = match[1];
    const code = LANGUAGE_MAP[tag];
    if (code) {
      return { code, name: getLanguageName(code) };
    }
  }

  return { code: 'und', name: '未知语言' };
}

function getLanguageName(code: string): string {
  const names: Record<string, string> = {
    'zh': '中文',
    'zh-Hant': '繁体中文',
    'en': 'English',
    'ja': '日本語',
    'ko': '한국어',
    'es': 'Español',
    'fr': 'Français',
    'de': 'Deutsch',
    'ru': 'Русский',
    'pt': 'Português',
    'it': 'Italiano',
    'ar': 'العربية',
    'hi': 'हिन्दी',
    'th': 'ไทย',
    'vi': 'Tiếng Việt',
  };
  return names[code] || code;
}
