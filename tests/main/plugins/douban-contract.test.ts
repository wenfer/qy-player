import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PluginError } from '../../../src/shared/types/plugins';
import { validateManifest } from '../../../src/main/modules/plugin-runtime/registry';
import { listPlugins } from '../../../src/main/modules/plugin-runtime/registry';
import {
  DOUBAN_HOST,
  DOUBAN_SUBJECT_URL_PREFIX,
  DOUBAN_SUGGEST_ENDPOINT,
  DETAIL_LDJSON_MARKER,
  DETAIL_LDJSON_TYPES,
  SUGGEST_REQUIRED_FIELDS,
  extractLdJsonBlocks,
  structureProblemsToError,
  validateDoubanDetailLd,
  validateDoubanSuggestPayload,
} from '../../../src/main/plugins/douban/types';

/**
 * QYP2-030 contract test (plan §11.4, ADR-0006).
 *
 * 豆瓣发布门禁的离线可执行形式：
 * 1. fixture（合成结构样本）必须通过锚点校验器——证明契约自洽；
 * 2. 人为破坏锚点必须被检出——证明「结构变化 → fail-closed」可检测，
 *    而不是静默返回空结果；
 * 3. 门禁未签认前：registry 不含 douban、plugins/douban 目录无 plugin
 *    factory——插件「已内置（契约）但不可启用」，防回归；
 * 4. 实验路径不得宣称正式可用：文档与 UI 文案的检查锚在 ADR + 测试命名，
 *    types.ts 不导出任何「启用/注册」入口。
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const FIXTURE_DIR = join(REPO_ROOT, 'tests/fixtures/douban');

const suggestFixture: unknown = JSON.parse(
  readFileSync(join(FIXTURE_DIR, 'subject-suggest.json'), 'utf8')
);

function readFixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), 'utf8');
}

function parseDetailLd(html: string): unknown {
  const blocks = extractLdJsonBlocks(html);
  expect(blocks.length).toBeGreaterThan(0);
  return JSON.parse(blocks[0]);
}

describe('douban contract (QYP2-030 / ADR-0006)', () => {
  it('endpoints and anchors match the ADR-documented entry', () => {
    expect(DOUBAN_HOST).toBe('movie.douban.com');
    expect(DOUBAN_SUGGEST_ENDPOINT).toBe('https://movie.douban.com/j/subject_suggest');
    expect(DOUBAN_SUBJECT_URL_PREFIX).toBe('https://movie.douban.com/subject/');
    expect(DETAIL_LDJSON_MARKER).toBe('application/ld+json');
    expect(SUGGEST_REQUIRED_FIELDS).toEqual(['id', 'title', 'url', 'type']);
    expect(DETAIL_LDJSON_TYPES).toEqual(['Movie', 'TVSeries']);
  });

  it('suggest fixture conforms to the documented shape', () => {
    expect(validateDoubanSuggestPayload(suggestFixture)).toEqual([]);
  });

  it('movie and tv detail fixtures conform to the JSON-LD anchors', () => {
    expect(validateDoubanDetailLd(parseDetailLd(readFixture('subject-detail.html')))).toEqual([]);
    expect(validateDoubanDetailLd(parseDetailLd(readFixture('subject-detail-tv.html')))).toEqual([]);
  });

  it('detects structural drift: missing anchor field fails loudly', () => {
    // 模拟豆瓣删掉 suggest 的 type 字段 → 必须产生结构问题（UPSTREAM_CHANGED
    // 语义），而不是把坏条目当合法数据。
    const drifted = JSON.parse(JSON.stringify(suggestFixture)) as Array<Record<string, unknown>>;
    delete drifted[0].type;
    const problems = validateDoubanSuggestPayload(drifted);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ where: 'suggest[0]', problem: expect.stringContaining('type') });
  });

  it('detects structural drift: id shape / url prefix / ld @type', () => {
    const badId = JSON.parse(JSON.stringify(suggestFixture)) as Array<Record<string, unknown>>;
    badId[1].id = 'subject-35465232'; // 豆瓣若改成非纯数字 id → 检出
    expect(validateDoubanSuggestPayload(badId)).toEqual([
      { where: 'suggest[1]', problem: 'id 必须是纯数字 subject id' },
      { where: 'suggest[1]', problem: 'url 与 id 不一致' }, // id 形状变 → 一致性锚点连坐检出
    ]);

    const badUrl = JSON.parse(JSON.stringify(suggestFixture)) as Array<Record<string, unknown>>;
    badUrl[2].url = 'https://other.example.com/subject/1292052/';
    expect(validateDoubanSuggestPayload(badUrl)).toEqual([
      { where: 'suggest[2]', problem: expect.stringContaining('movie.douban.com/subject/') },
    ]);

    const badLd = { '@type': 'Product', name: 'x' };
    expect(validateDoubanDetailLd(badLd)).toEqual([
      { where: 'ld-json', problem: expect.stringContaining('Movie|TVSeries') },
    ]);

    expect(validateDoubanDetailLd({ '@type': 'Movie' })).toEqual([
      { where: 'ld-json', problem: expect.stringContaining('name') },
    ]);
  });

  it('structure problems map to a single UPSTREAM_CHANGED PluginError (§11.4)', () => {
    const error = structureProblemsToError([
      { where: 'ld-json', problem: '缺少必需字段 name' },
      { where: 'suggest[0]', problem: '条目必须是对象' },
    ]);
    expect(error).toBeInstanceOf(PluginError);
    expect(error.code).toBe('UPSTREAM_CHANGED');
    expect(error.message).toContain('结构变化');
  });

  it('GATE: douban is NOT registered in the plugin registry (不可启用)', () => {
    expect(listPlugins().map((p) => p.manifest.id)).not.toContain('douban');
  });

  it('GATE: buildDoubanPlugin is never wired into the app (无注册/启用开关)', () => {
    // 源码级静态检查：除 plugins/douban 自身外，任何启动/接线代码
    // 不得引用豆瓣插件工厂（ADR-0006：人工评审签认前不可启用）。
    // 边界说明：本检查按工厂名匹配——启用必经 registry 接线，而接线
    // 必然引用工厂名；直接 import client/mapper 不构成启用路径。
    const scan = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = join(dir, entry.name);
        return entry.isDirectory() ? scan(full) : full.endsWith('.ts') ? [full] : [];
      });
    const mainDir = join(REPO_ROOT, 'src/main');
    const doubanDir = join(mainDir, 'plugins/douban');
    const offenders = scan(mainDir)
      .filter((file) => !file.startsWith(doubanDir))
      .filter((file) => readFileSync(file, 'utf8').includes('buildDoubanPlugin'));
    expect(offenders).toEqual([]);
  });

  it('a future douban manifest passes registry validation (id 形状兼容)', () => {
    const { errors } = validateManifest({
      id: 'douban',
      name: '豆瓣（实验性）',
      version: '0.1.0',
      apiVersion: 1,
      capability: 'metadata-provider',
    });
    expect(errors).toEqual([]);
  });
});
