import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

// db.ts imports { app } from 'electron'; stub it so integration tests run in
// plain Node. The mock is hoisted and must not close over outer variables.
vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => join(tmpdir(), 'qy-player-purpose-test', name),
  },
}));

import { openDatabaseAtPath } from '../../../src/main/modules/storage/db';
import { createCatalogRepository } from '../../../src/main/modules/catalog/repository';
import { isSourcePurpose } from '../../../src/shared/types/catalog';

const tmpRoots: string[] = [];
function makeDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qy-source-purpose-'));
  tmpRoots.push(dir);
  return join(dir, 'test.db');
}
afterAll(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
});

/**
 * 来源用途标记（QYP3-039 migration 009 / QYP3-041 migration 010）：
 * 一个来源只属于 music 或 video 一域——不支持音乐与视频混放在同一目录。
 * 「存量 'all' 归一为 video」的可升级行为在 catalog-migrations 里验（要造
 * 停在 009 的库），这里只管应用层读写与白名单。
 */
describe('source purpose (QYP3-039/041)', () => {
  it('reaches schema version 11 on a fresh database', () => {
    const db = openDatabaseAtPath(makeDbPath());
    const version = (db.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version: number }).version;
    expect(version).toBe(11);
    db.close();
  });

  it('createSource persists purpose and defaults to video', () => {
    const db = openDatabaseAtPath(makeDbPath());
    const repo = createCatalogRepository(db);
    const defaultId = repo.createSource({ kind: 'local', name: '未指定', root: '/mix' });
    const musicId = repo.createSource({ kind: 'local', name: '音乐盘', root: '/music', purpose: 'music' });
    const videoId = repo.createSource({ kind: 'local', name: '影片盘', root: '/movies', purpose: 'video' });
    expect(repo.getSource(defaultId)?.purpose).toBe('video');
    expect(repo.getSource(musicId)?.purpose).toBe('music');
    expect(repo.getSource(videoId)?.purpose).toBe('video');
    // 音乐来源与影视来源在库里是两个互不相交的集合
    const purposes = repo.listSources().map((s) => s.purpose);
    expect(new Set(purposes)).toEqual(new Set(['music', 'video']));
    db.close();
  });

  it('isSourcePurpose accepts only music/video', () => {
    expect(isSourcePurpose('music')).toBe(true);
    expect(isSourcePurpose('video')).toBe(true);
    expect(isSourcePurpose('all')).toBe(false); // 混放不再被接受
    expect(isSourcePurpose('both')).toBe(false);
    expect(isSourcePurpose('')).toBe(false);
    expect(isSourcePurpose(null)).toBe(false);
    expect(isSourcePurpose(1)).toBe(false);
  });
});
