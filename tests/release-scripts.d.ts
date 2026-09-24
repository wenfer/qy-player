// Ambient types for the release-plumbing helpers used by
// .github/workflows/release.yml. Both implementations are plain .mjs; these
// declarations give the imports an explicit, typechecked contract.
declare module '*release-notes.mjs' {
  /** 抽取 CHANGELOG.md 里某个版本的段落（不含 `## ` 标题行），找不到返回 null。 */
  export function extractReleaseNotes(changelog: string, version: string): string | null;
}

declare module '*merge-mac-update-info.mjs' {
  export interface UpdateInfoFileEntry {
    url?: string;
    sha512?: string;
    size?: string;
    blockMapSize?: string;
    [key: string]: string | undefined;
  }

  export interface UpdateInfo {
    version: string | null;
    releaseDate: string | null;
    path: string | null;
    sha512: string | null;
    files: UpdateInfoFileEntry[];
  }

  export function parseUpdateInfo(text: string): UpdateInfo;
  export function mergeMacUpdateInfo(texts: string[]): string;
}
