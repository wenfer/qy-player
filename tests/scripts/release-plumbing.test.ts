import { describe, expect, it } from 'vitest';

// 两个都是 plain .mjs（CI 里由 node 直接跑），动态 import 以便给定类型声明。
const { extractReleaseNotes } = await import('../../scripts/release-notes.mjs');
const { mergeMacUpdateInfo, parseUpdateInfo } = await import('../../scripts/merge-mac-update-info.mjs');

// 结构与真实产物一致（取自 v1.5.1 发布的 latest-mac.yml）
const X64 = `version: 1.5.1
files:
  - url: qy-player-1.5.1-x64.dmg
    sha512: AAAA
    size: 134334618
path: qy-player-1.5.1-x64.dmg
sha512: AAAA
releaseDate: '2026-09-24T02:56:44.581Z'
`;

const ARM64 = `version: 1.5.1
files:
  - url: qy-player-1.5.1-arm64.dmg
    sha512: BBBB
    size: 133900000
path: qy-player-1.5.1-arm64.dmg
sha512: BBBB
releaseDate: '2026-09-24T02:59:10.114Z'
`;

const CHANGELOG = `# Changelog

## 1.5.10（假的未来版本）

### 变更
- 不应该被 1.5.1 抽到

## 1.5.1（界面减负）

### 变更
- 第一行
- 第二行

## 1.4.0（更早）

### 变更
- 更早就有的内容
`;

describe('macOS 更新元数据合并', () => {
  it('解析出顶层标量与 files 列表', () => {
    const info = parseUpdateInfo(X64);
    expect(info.version).toBe('1.5.1');
    // 顶层 path/sha512 不能被误认成 files 列表里那一条的字段
    expect(info.path).toBe('qy-player-1.5.1-x64.dmg');
    expect(info.sha512).toBe('AAAA');
    expect(info.releaseDate).toBe('2026-09-24T02:56:44.581Z');
    expect(info.files).toHaveLength(1);
    expect(info.files[0]).toEqual({
      url: 'qy-player-1.5.1-x64.dmg',
      sha512: 'AAAA',
      size: '134334618',
    });
  });

  it('合并后两个架构都在 files 里，releaseDate 取较早的那份', () => {
    const merged = mergeMacUpdateInfo([X64, ARM64]);
    expect(merged).toContain('- url: qy-player-1.5.1-x64.dmg');
    expect(merged).toContain('- url: qy-player-1.5.1-arm64.dmg');
    expect(merged.indexOf('x64.dmg')).toBeLessThan(merged.indexOf('arm64.dmg'));
    expect(merged).toContain("releaseDate: '2026-09-24T02:56:44.581Z'");
    expect(merged.startsWith('version: 1.5.1\nfiles:\n')).toBe(true);
  });

  it('同一 url 重复只留一条', () => {
    const merged = mergeMacUpdateInfo([X64, X64]);
    expect(merged.match(/- url:/g)).toHaveLength(1);
  });

  it('输入里没有 files 条目要报错，而不是产出半个元数据文件', () => {
    expect(() => mergeMacUpdateInfo(['version: 1.5.1\n'])).toThrow(/files/);
  });

  it('blockMapSize 有值时要跟着一起输出（Windows/AppImage 那种条目）', () => {
    const withBlockMap = X64.replace('    size: 134334618\n', '    size: 134334618\n    blockMapSize: 112086\n');
    expect(mergeMacUpdateInfo([withBlockMap, ARM64])).toContain('    blockMapSize: 112086');
  });
});

describe('发布说明抽取', () => {
  it('抽到对应版本段落，且不带 ## 标题行', () => {
    const notes = extractReleaseNotes(CHANGELOG, '1.5.1');
    expect(notes).toBe('### 变更\n- 第一行\n- 第二行\n');
  });

  it('不会把 1.5.1 匹配到 1.5.10', () => {
    const notes = extractReleaseNotes(CHANGELOG, '1.5.1');
    expect(notes).not.toContain('1.5.10');
    // 反过来：1.5.10 要能抽到自己的段落
    expect(extractReleaseNotes(CHANGELOG, '1.5.10')).toBe('### 变更\n- 不应该被 1.5.1 抽到\n');
  });

  it('版本不存在时返回 null（CLI 据此报错退出）', () => {
    expect(extractReleaseNotes(CHANGELOG, '9.9.9')).toBeNull();
  });

  it('段落内容为空也返回 null', () => {
    expect(extractReleaseNotes('# Changelog\n\n## 1.0.0\n\n', '1.0.0')).toBeNull();
  });
});
