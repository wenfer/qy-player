#!/usr/bin/env node
/**
 * 合并 macOS 双架构的更新元数据（latest-mac.yml）。
 *
 * 背景：mac 的 x64 / arm64 必须分两个 job 构建（better-sqlite3 是按 runner 宿主
 * 架构编译的原生模块），而 electron-builder 给 **macOS** 写的更新元数据文件名
 * 不带架构后缀（getUpdateInfoFileName 只对 Linux 加 -<arch>）——两个 job 上传
 * 同名文件，后跑完的把先跑完的覆盖掉，线上只剩一个架构。
 *
 * 所以两个 job 各自把 dist/latest-mac.yml 改名成 latest-mac-<arch>.yml 再传制品，
 * 由本脚本在发布前合成一份同时列出两个 dmg 的文件。
 *
 * 用法：node scripts/merge-mac-update-info.mjs <file> [<file> ...]
 *      结果写 stdout（格式与 electron-builder 自己的产物一致）。
 */
import { readFileSync } from 'node:fs';

/** 去掉 electron-builder 给字符串加的一层引号 */
function stripQuotes(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * 行式解析——只认 electron-builder 写更新元数据用的那几种结构
 * （顶层标量 + `files:` 下一组 `- url:/sha512:/size:` 块）。上通用 YAML 解析器
 * 对这点结构化内容是不相称的依赖。
 */
export function parseUpdateInfo(text) {
  const scalars = { version: null, releaseDate: null, path: null, sha512: null };
  const files = [];
  let inFiles = false;
  let entry = null;

  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    // 顶层（没缩进）的行：标量，或者开启 files 列表——它一出现，说明 files 块结束
    if (!/^\s/.test(line)) {
      if (trimmed === 'files:') {
        inFiles = true;
        entry = null;
        continue;
      }
      const scalar = trimmed.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
      if (scalar) {
        inFiles = false;
        entry = null;
        if (scalar[1] in scalars) scalars[scalar[1]] = stripQuotes(scalar[2]);
        continue;
      }
    }

    const item = trimmed.match(/^-\s+([A-Za-z0-9_]+):\s*(.*)$/);
    if (item) {
      if (inFiles) {
        entry = { [item[1]]: stripQuotes(item[2]) };
        files.push(entry);
      }
      continue;
    }

    const field = trimmed.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (field && inFiles && entry) {
      entry[field[1]] = stripQuotes(field[2]);
    }
  }

  return { ...scalars, files };
}

/**
 * 合并若干份同版本、不同架构的更新元数据。
 * - `files` 按输入顺序拼接，同一 url 只留第一次出现的那条；
 * - 顶层 `path`/`sha512` 取第一条（与 electron-builder 自己在多目标构建时的写法一致）；
 * - `releaseDate` 取最早的那份（两个架构是分别构建的，取较早的更接近发布会时刻）。
 */
export function mergeMacUpdateInfo(texts) {
  const parsed = texts.map(parseUpdateInfo);
  const merged = [];
  const seen = new Set();
  for (const info of parsed) {
    for (const file of info.files) {
      if (!file.url || seen.has(file.url)) continue;
      seen.add(file.url);
      merged.push(file);
    }
  }
  if (merged.length === 0) {
    throw new Error('没有任何 files 条目：输入不像 electron-builder 的更新元数据');
  }

  const version = parsed.map((info) => info.version).find(Boolean) ?? null;
  const releaseDates = parsed.map((info) => info.releaseDate).filter(Boolean).sort();
  const first = merged[0];

  const lines = [`version: ${version}`, 'files:'];
  for (const file of merged) {
    lines.push(`  - url: ${file.url}`);
    lines.push(`    sha512: ${file.sha512}`);
    lines.push(`    size: ${file.size}`);
    if (file.blockMapSize != null) {
      lines.push(`    blockMapSize: ${file.blockMapSize}`);
    }
  }
  lines.push(`path: ${first.url}`);
  lines.push(`sha512: ${first.sha512}`);
  if (releaseDates.length > 0) {
    lines.push(`releaseDate: '${releaseDates[0]}'`);
  }
  return `${lines.join('\n')}\n`;
}

function main(argv) {
  const paths = argv.slice(2);
  if (paths.length < 2) {
    process.stderr.write('用法：node scripts/merge-mac-update-info.mjs <file> [<file> ...]\n');
    return 2;
  }
  const texts = paths.map((path) => readFileSync(path, 'utf-8'));
  process.stdout.write(mergeMacUpdateInfo(texts));
  return 0;
}

// 被 import 时不执行 CLI 部分（测试直接 import 上面的两个函数）
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exitCode = main(process.argv);
}
