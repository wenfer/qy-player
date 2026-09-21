#!/usr/bin/env node
/**
 * QYP3-064: 下载 Windows 版 mpv 到 build/mpv-win/，供 electron-builder
 * 经 extraResources 打进安装包（resources/mpv/mpv.exe）。
 *
 * 来源：zhongfly/mpv-winbuild（shinchiro 工具链的持续构建，静态链接
 * ffmpeg，mpv.exe 即开即用，无需额外 DLL——d3dcompiler_47.dll 随包携带）。
 *
 * 用法：
 *   node scripts/fetch-mpv-win.js                 # 使用内置固定 tag
 *   MPV_WINBUILD_TAG=<tag> node scripts/fetch-mpv-win.js
 *   SEVENZIP=/path/to/7z node scripts/fetch-mpv-win.js   # 指定 7z 可执行
 *
 * 幂等：build/mpv-win/mpv.exe 已存在时直接跳过（CI 缓存友好）。
 * 固定 tag 的原因：发布产物必须可复现，不能悄悄跟着 upstream 漂移。
 */
import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const REPO = 'zhongfly/mpv-winbuild';
const DEFAULT_TAG = '2026-09-20-e76a35ec95';
// 只要普通 x86_64 构建：排除 v3（要求 AVX2 的指令集子集）、debug、dev（libmpv 头文件包）
const ASSET_PATTERN = /^mpv-x86_64-\d{8}-git-[0-9a-f]+\.7z$/;

const tag = process.env.MPV_WINBUILD_TAG || DEFAULT_TAG;
const outDir = path.resolve('build/mpv-win');
const exePath = path.join(outDir, 'mpv.exe');
// 解压后只保留运行所需文件；doc/installer/mpv/ 等杂物清掉，安装包不带
const KEEP_FILES = new Set(['mpv.exe', 'mpv.com']);

function log(msg) {
  console.log(`[fetch-mpv-win] ${msg}`);
}

function findSevenZip() {
  const candidates = [
    process.env.SEVENZIP,
    '7z',
    '7za',
    'C:\\Program Files\\7-Zip\\7z.exe',
  ].filter(Boolean);
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['i'], { stdio: 'ignore', shell: false });
    // 127 = 命令不存在；ENOENT 时 status 为 null，同样视为不可用
    if (probe.status !== null && probe.status !== 127 && !probe.error) return candidate;
  }
  return null;
}

async function main() {
  if (existsSync(exePath)) {
    log(`已存在 ${exePath}，跳过下载（如需重新获取请先删除 build/mpv-win）`);
    return;
  }

  log(`查询 release tag=${tag}`);
  const releaseRes = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${tag}`, {
    headers: { 'User-Agent': 'qy-player-release-script', 'Accept': 'application/vnd.github+json' },
  });
  if (!releaseRes.ok) {
    throw new Error(
      `查询 release 失败（HTTP ${releaseRes.status}）。` +
      `请确认 tag 是否存在于 https://github.com/${REPO}/releases，` +
      `或用 MPV_WINBUILD_TAG=<tag> 指定其它版本`
    );
  }
  const release = await releaseRes.json();
  const asset = (release.assets ?? []).find((a) => ASSET_PATTERN.test(a.name));
  if (!asset) {
    throw new Error(
      `tag ${tag} 下没有匹配 ${ASSET_PATTERN} 的资产。` +
      `现有资产：${(release.assets ?? []).map((a) => a.name).join(', ')}`
    );
  }
  log(`下载 ${asset.name}（${Math.round(asset.size / 1024 / 1024)} MB）`);

  mkdirSync(outDir, { recursive: true });
  const archivePath = path.join(outDir, asset.name);
  const downloadRes = await fetch(asset.browser_download_url, {
    headers: { 'User-Agent': 'qy-player-release-script' },
  });
  if (!downloadRes.ok || !downloadRes.body) {
    throw new Error(`下载失败（HTTP ${downloadRes.status}）：${asset.browser_download_url}`);
  }
  await pipeline(Readable.fromWeb(downloadRes.body), createWriteStream(archivePath));
  const downloaded = statSync(archivePath).size;
  if (downloaded !== asset.size) {
    throw new Error(`下载不完整：期望 ${asset.size} 字节，实际 ${downloaded}`);
  }

  const sevenZip = findSevenZip();
  if (!sevenZip) {
    rmSync(archivePath, { force: true });
    throw new Error('未找到 7z。Ubuntu: apt-get install p7zip-full；Windows: 安装 7-Zip 或用 SEVENZIP= 指定路径');
  }
  log(`解压 ${asset.name} → ${outDir}`);
  const extract = spawnSync(sevenZip, ['x', '-y', `-o${outDir}`, archivePath], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (extract.status !== 0) {
    throw new Error(`解压失败（exit ${extract.status}）：${extract.stderr?.toString() ?? ''}`);
  }
  for (const entry of readdirSync(outDir, { withFileTypes: true })) {
    if (KEEP_FILES.has(entry.name)) continue;
    rmSync(path.join(outDir, entry.name), { recursive: true, force: true });
  }
  rmSync(archivePath, { force: true });

  if (!existsSync(exePath)) {
    throw new Error(`解压完成但未找到 mpv.exe（目录内容：${readdirSync(outDir).join(', ')}）`);
  }
  log(`完成：${exePath}`);
}

main().catch((error) => {
  console.error(`[fetch-mpv-win] 失败：${error.message}`);
  process.exit(1);
});
