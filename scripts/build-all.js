#!/usr/bin/env node
/**
 * 一键打包脚本 - 支持多种 Linux 包格式
 * Usage: node scripts/build-all.js [formats...]
 *   formats: appimage, deb, rpm, pacman, tar (默认全部)
 * Example: node scripts/build-all.js deb rpm
 */

import { spawn, execSync } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';

const DIST_DIR = resolve(process.cwd(), 'dist');

// 检测系统依赖
function checkSystemDep(cmd, installHint) {
  try {
    execSync(`which ${cmd}`, { stdio: 'ignore' });
    return { ok: true };
  } catch {
    return { ok: false, hint: installHint };
  }
}

const SYSTEM_DEPS = {
  rpm: checkSystemDep('rpmbuild', 'sudo apt install rpm (Debian/Ubuntu/Deepin)'),
  pacman: checkSystemDep('pacman', '仅 Arch Linux 可用'),
};

const FORMATS = {
  appimage: {
    cmd: 'npx',
    args: ['electron-builder', '--linux', 'appimage'],
    ext: 'AppImage',
    env: { ELECTRON_BUILDER_BINARIES_MIRROR: 'https://npmmirror.com/mirrors/electron-builder-binaries/' },
  },
  deb: {
    cmd: 'npx',
    args: ['electron-builder', '--linux', 'deb'],
    ext: 'deb',
    env: {},
  },
  rpm: {
    cmd: 'npx',
    args: ['electron-builder', '--linux', 'rpm'],
    ext: 'rpm',
    env: { ELECTRON_BUILDER_BINARIES_MIRROR: 'https://npmmirror.com/mirrors/electron-builder-binaries/' },
  },
  pacman: {
    cmd: 'npx',
    args: ['electron-builder', '--linux', 'pacman'],
    ext: 'pkg.tar.zst',
    env: { ELECTRON_BUILDER_BINARIES_MIRROR: 'https://npmmirror.com/mirrors/electron-builder-binaries/' },
  },
  tar: {
    cmd: 'npx',
    args: ['electron-builder', '--linux', 'tar.gz', 'tar.xz'],
    ext: 'tar.gz / tar.xz',
    env: {},
  },
};

function runCommand(cmd, args, label, env = {}) {
  return new Promise((resolve, reject) => {
    console.log(`\n[${label}] 开始打包...`);
    const start = Date.now();
    const child = spawn(cmd, args, {
      stdio: 'inherit',
      shell: process.platform === 'win32',
      env: { ...process.env, ...env },
    });

    child.on('close', (code) => {
      const duration = ((Date.now() - start) / 1000).toFixed(1);
      if (code === 0) {
        console.log(`[${label}] ✅ 打包成功 (${duration}s)`);
        resolve();
      } else {
        console.error(`[${label}] ❌ 打包失败 (exit ${code}, ${duration}s)`);
        reject(new Error(`Exit code ${code}`));
      }
    });

    child.on('error', (err) => {
      console.error(`[${label}] ❌ 启动失败: ${err.message}`);
      reject(err);
    });
  });
}

async function main() {
  const requested = process.argv.slice(2);
  let formats = requested.length > 0
    ? requested.filter((f) => FORMATS[f])
    : Object.keys(FORMATS);

  if (requested.length > 0 && formats.length === 0) {
    console.error('未知的格式:', requested.join(', '));
    console.error('可用格式:', Object.keys(FORMATS).join(', '));
    process.exit(1);
  }

  if (!existsSync(DIST_DIR)) {
    mkdirSync(DIST_DIR, { recursive: true });
  }

  console.log('========================================');
  console.log('  QY Player 多格式打包');
  console.log('========================================');

  // 检查系统依赖
  let skipped = [];
  for (const fmt of [...formats]) {
    const sysDep = SYSTEM_DEPS[fmt];
    if (sysDep && !sysDep.ok) {
      console.warn(`\n⚠️  [${fmt.toUpperCase()}] 跳过 - 缺少系统依赖`);
      console.warn(`   安装方式: ${sysDep.hint}`);
      skipped.push(fmt);
      formats = formats.filter((f) => f !== fmt);
    }
  }

  if (formats.length === 0) {
    console.error('\n❌ 没有可打包的格式，请先安装依赖');
    process.exit(1);
  }

  console.log('目标格式:', formats.join(', '));
  if (skipped.length > 0) {
    console.log('跳过格式:', skipped.join(', '));
  }
  console.log('输出目录:', DIST_DIR);
  console.log('');

  // 先执行生产构建
  console.log('[BUILD] 开始生产构建...');
  try {
    execSync('npm run build', { stdio: 'inherit' });
  } catch {
    console.error('\n❌ 生产构建失败');
    process.exit(1);
  }

  const results = [];

  for (const format of formats) {
    const config = FORMATS[format];
    try {
      await runCommand(config.cmd, config.args, format.toUpperCase(), config.env);
      results.push({ format, success: true });
    } catch {
      results.push({ format, success: false });
    }
  }

  console.log('\n========================================');
  console.log('  打包结果汇总');
  console.log('========================================');

  for (const { format, success } of results) {
    const status = success ? '✅ 成功' : '❌ 失败';
    console.log(`  ${format.padEnd(12)} ${status}`);
  }
  for (const fmt of skipped) {
    console.log(`  ${fmt.padEnd(12)} ⚠️  跳过 (缺少依赖)`);
  }

  const successCount = results.filter((r) => r.success).length;
  const totalCount = results.length + skipped.length;

  console.log(`\n总计: ${successCount}/${totalCount} 个格式打包成功`);

  if (successCount > 0) {
    console.log('\n输出文件:');
    try {
      const files = execSync(`ls -lh ${DIST_DIR}/`).toString().split('\n').filter((l) => l.trim() && !l.includes('total'));
      for (const file of files) {
        console.log(' ', file);
      }
    } catch {
      // ignore
    }
  }

  process.exit(successCount < results.length ? 1 : 0);
}

main().catch((err) => {
  console.error('打包脚本错误:', err);
  process.exit(1);
});
