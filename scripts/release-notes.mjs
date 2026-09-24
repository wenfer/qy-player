#!/usr/bin/env node
/**
 * 把 CHANGELOG.md 里某个版本的段落抽成 GitHub Release 的说明。
 *
 * 之前 workflow 里挂着 `generate_release_notes: true`，实际一直没产生内容（1.4.0 /
 * 1.5.0 的发布页说明都是空的）。CHANGELOG 本来就是人工维护的真说明，从这里抽是最
 * 省的一条路——抽不到就**报错**，宁可 CI 红也不要发一个空说明的版本出来。
 *
 * 用法：node scripts/release-notes.mjs <version>（如 1.5.1）
 *      说明写 stdout。
 */
import { readFileSync } from 'node:fs';

/**
 * 抽取 `## <version>`（后面可以带中文副标题）到下一个 `## ` 之间的内容，标题行本身
 * 不要（发布页的标题就是 tag）。找不到返回 null。
 */
export function extractReleaseNotes(changelog, version) {
  const lines = changelog.split('\n');
  // 版本号后面允许跟副标题（`（xxx）`）或直接换行；负向排除是为了 1.5.1 不匹配到
  // 1.5.10 这类更长版本号的段落
  const heading = new RegExp(`^##\\s+${escapeRegExp(version)}(?![0-9.])`);
  const start = lines.findIndex((line) => heading.test(line.trim()));
  if (start === -1) return null;

  const body = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i].trim())) break;
    body.push(lines[i]);
  }
  const notes = body.join('\n').trim();
  return notes === '' ? null : `${notes}\n`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function main(argv) {
  const version = argv[2];
  if (!version) {
    process.stderr.write('用法：node scripts/release-notes.mjs <version>\n');
    return 2;
  }
  const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf-8');
  const notes = extractReleaseNotes(changelog, version);
  if (notes == null) {
    process.stderr.write(`CHANGELOG.md 里没有 ${version} 的段落，先补说明再发版\n`);
    return 1;
  }
  process.stdout.write(notes);
  return 0;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exitCode = main(process.argv);
}
