import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CacheManager,
  CONCURRENCY_BUDGET,
  MAX_EVENT_HZ,
  MAX_PAGE_SIZE,
} from '../../../src/main/modules/cache/cache-manager';
import {
  buildDiagnosticsSummary,
  maskUrl,
  redactValue,
} from '../../../src/main/modules/diagnostics';
import { ScrapeCache } from '../../../src/main/modules/plugin-runtime/cache';
import * as fsmod from 'node:fs';
const fs = fsmod as typeof import('node:fs');

/**
 * QYP2-037: 缓存配额/LRU/过期、并发预算与诊断脱敏。
 * 10,000 项扫描基线由 tests/main/library-scanner/{local,webdav}-scan 的
 * 既有基线测试维持（本轮复跑 local≈16.7s / webdav≈16.9s，门限 <60s
 * 未回退）；本文件不重复跑 benchmark。
 */

let tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'diag-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

describe('§16.4 并发预算常量（验收阈值）', () => {
  it('local≤8、WebDAV≤4、probe≤1、scraper≤2；事件 ≤4Hz；页 ≤200', () => {
    expect(CONCURRENCY_BUDGET.localScan).toBeLessThanOrEqual(8);
    expect(CONCURRENCY_BUDGET.webdavScan).toBeLessThanOrEqual(4);
    expect(CONCURRENCY_BUDGET.probe).toBe(1);
    expect(CONCURRENCY_BUDGET.scraper).toBe(2);
    expect(MAX_EVENT_HZ).toBeLessThanOrEqual(4);
    expect(MAX_PAGE_SIZE).toBeLessThanOrEqual(200);
  });
});

describe('CacheManager 配额清扫与字幕保护', () => {
  it('sweep 按 mtime 最旧先删，到配额即停', () => {
    const dir = makeTempDir();
    for (const [name, mtime] of [
      ['old.bin', 1000],
      ['mid.bin', 2000],
      ['new.bin', 3000],
    ] as const) {
      const full = `${dir}/${name}`;
      writeFileSync(full, Buffer.alloc(100));
      fs.utimesSync(full, new Date(mtime), new Date(mtime));
    }
    const manager = new CacheManager();
    manager.register({ id: 'p', description: '', rootDir: dir, quota: {}, sweepable: true });
    const result = manager.sweep('p', 150); // 旧(100B)+中(100B) 被删即超 150B，新保留
    expect(result.deletedFiles).toBe(2);
    expect(fs.readFileSync(`${dir}/new.bin`)).toBeTruthy();
    expect(() => fs.readFileSync(`${dir}/old.bin`)).toThrow();
  });

  it('人工字幕受保护：sweepable 分区里字幕目录绝不进入删除候选', () => {
    const root = makeTempDir();
    const subtitlesDir = `${root}/subtitles`;
    mkdirSync(subtitlesDir);
    writeFileSync(`${subtitlesDir}/s1.srt`, '字幕内容');
    for (const name of ['cache-a', 'cache-b']) {
      writeFileSync(`${root}/${name}`, Buffer.alloc(512));
    }
    const manager = new CacheManager();
    manager.register(
      { id: 'media-cache', description: '', rootDir: root, quota: {}, sweepable: true },
      ['subtitles'] // 人工字幕目录名受保护
    );
    const sweep = manager.sweep('media-cache', 100000);
    expect(sweep.deletedFiles).toBe(2); // 只有 cache-a/b 被删
    expect(readFileSync(`${subtitlesDir}/s1.srt`, 'utf8')).toBe('字幕内容');
  });

  it('未注册分区 sweep 报错（防误删）', () => {
    const manager = new CacheManager();
    expect(() => manager.sweep('nope', 100)).toThrow();
  });
});

describe('诊断脱敏（验收：无秘密/完整私有 URL）', () => {
  it('maskUrl 打码主机/端口/路径/查询', () => {
    expect(maskUrl('http://192.168.1.10:8096')).toBe('http://***');
    expect(maskUrl('https://nas.local:5006/webdav?token=abc')).toBe('https://***/*');
    expect(maskUrl('not a url')).toBe('***');
  });

  it('redactValue: 疑似秘密键名/URL 内嵌凭据整段替换', () => {
    expect(redactValue('api_key', 'anything')).toBe('***');
    expect(redactValue('access_token', 'abc.def.ghi')).toBe('***');
    expect(redactValue('note', 'http://u:p@host/x?token=1')).toBe('***');
    expect(redactValue('plain', '普通内容保留')).toBe('普通内容保留');
  });

  it('buildDiagnosticsSummary: 无 api key/token、无完整私有 URL、无绝对路径', () => {
    const dir = makeTempDir();
    const manager = new CacheManager();
    manager.register(
      { id: 'plugin-response', description: '插件缓存', rootDir: dir, quota: { maxEntries: 10 }, sweepable: true },
      []
    );
    writeFileSync(`${dir}/entry.bin`, Buffer.alloc(10));
    const summary = buildDiagnosticsSummary({
      appVersion: '1.1.0',
      servers: [
        { id: 1, name: '家里服务器', type: 'jellyfin', base_url: 'http://192.168.1.10:8096', is_active: 1 },
        { id: 2, name: 'NAS', type: 'emby', base_url: 'https://nas.local:8920/emby', is_active: 1 },
      ],
      cacheManager: manager,
      subsystems: [{ id: 'sqlite', ok: true, detail: '已打开' }],
    });
    const serialized = JSON.stringify(summary);
    // 秘密红线
    expect(serialized).not.toContain('192.168.1.10');
    expect(serialized).not.toContain('nas.local');
    expect(serialized).not.toContain(dir);
    expect(serialized).toMatch(/generatedAt/);
    // 服务器地址已脱敏
    const masked = summary.servers.map((s) => s.addressMasked);
    expect(masked.every((addr) => addr.includes('***'))).toBe(true);
    // 缓存分区根目录脱敏
    expect(summary.caches.every((c) => c.rootDirMasked === null || c.rootDirMasked.includes('*'))).toBe(true);
    // 预算展示
    expect(summary.budgets).toMatchObject({ localScan: 8, webdavScan: 4, probe: 1, scraper: 2 });
    expect(summary.caches.find((c) => c.id === 'plugin-response')?.approxBytes).toBe(10);
  });

  it('subsystem detail / server name pass through redaction (脱敏兜底)', () => {
    const summary = buildDiagnosticsSummary({
      appVersion: 't',
      servers: [{ id: 1, name: '服务器-api_key=abcd', type: 'jellyfin', base_url: 'http://x', is_active: 1 }],
      cacheManager: new CacheManager(),
      subsystems: [{ id: 'probe', ok: false, detail: '失败于 http://192.168.1.10:8096 连接' }],
    });
    expect(JSON.stringify(summary)).not.toContain('abcd');
    expect(JSON.stringify(summary)).not.toContain('192.168.1.10');
  });
});

describe('插件响应缓存配额与字幕安全共存', () => {
  it('ScrapeCache 超配额驱逐最旧 mtime，不影响外部字幕目录', () => {
    const dir = makeTempDir();
    const clock = { n: Date.now() };
    const cache2 = new ScrapeCache({ dir, maxEntries: 2, now: () => clock.n });
    cache2.set('tmdb', 'ns', 'k1', { a: 1 });
    clock.n += 10;
    cache2.set('tmdb', 'ns', 'k2', { b: 2 });
    clock.n += 10;
    cache2.set('tmdb', 'ns', 'k3', { c: 3 });
    // 最旧 mtime 被驱逐（真 LRU）；剩下最多 2 条（k1 与 k2 中最旧者出局）。
    expect(cache2.get('tmdb', 'ns', 'k1')).toBeUndefined();
    expect(cache2.size).toBeLessThanOrEqual(2);
    expect(cache2.get('tmdb', 'ns', 'k2')).toEqual({ b: 2 });
    expect(cache2.get('tmdb', 'ns', 'k3')).toEqual({ c: 3 });
  });
});
