/**
 * Douban experimental metadata-provider contract (QYP2-030, plan §11.4,
 * ADR-0006).
 *
 * 本文件只固化「数据入口 + 结构锚点」契约，不包含任何网络实现：
 * - 数据入口：无需登录的公开页面（subject_suggest JSON 端点 + 条目页
 *   内嵌 JSON-LD），host allowlist 仅 movie.douban.com。
 * - 上游改版检测：校验器对「必需锚点」做检查，偏差返回结构问题列表，
 *   语义对应 PluginError 'UPSTREAM_CHANGED'（fail-closed，绝不用空结果
 *   覆盖目录）。
 * - 发布门禁（ADR-0006）：人工产品/法律/技术评审签认前，豆瓣插件
 *   不注册进 registry、没有 plugin factory——本文件导出的类型/校验器
 *   供 QYP2-031 的实现与 contract test 复用，不构成"可启用"的功能。
 *   不得在任何 UI/文档中把该路径描述为正式可用。
 */

import { PluginError } from '../../../shared/types/plugins';

/** 唯一允许的豆瓣 host（allowlist 注册用，见 ADR-0006 入口④）。 */
export const DOUBAN_HOST = 'movie.douban.com';

/** 公开搜索候选端点（条目页搜索框自用，无需登录，仅 GET）。 */
export const DOUBAN_SUGGEST_ENDPOINT = `https://${DOUBAN_HOST}/j/subject_suggest`;

/** 条目详情页前缀；getDetails 的 id 参数 = 纯数字 subject id。 */
export const DOUBAN_SUBJECT_URL_PREFIX = `https://${DOUBAN_HOST}/subject/`;

/**
 * subject_suggest 响应条目的必需字段（结构锚点）。
 * 上游删改任一字段即视为结构变化。
 */
export const SUGGEST_REQUIRED_FIELDS = ['id', 'title', 'url', 'type'] as const;

/**
 * 详情页 JSON-LD 的必需键（结构锚点）。豆瓣条目页嵌
 * `<script type="application/ld+json">`，词表为 schema.org。
 */
export const DETAIL_LDJSON_MARKER = 'application/ld+json';
export const DETAIL_LDJSON_REQUIRED_FIELDS = ['@type', 'name'] as const;
export const DETAIL_LDJSON_TYPES = ['Movie', 'TVSeries'] as const;

/** subject_suggest 候选条目（文档化形状；多余字段忽略）。 */
export interface DoubanSuggestItem {
  /** 纯数字 subject id。 */
  id: string;
  /** 主标题（中文语境下的豆瓣译名/原名）。 */
  title: string;
  /** 条目 URL（用于校验 id 一致性与反混淆）。 */
  url: string;
  /** 'movie' | 'tv'（豆瓣的 suggest type）。 */
  type: string;
  /** 副标题/外文名（部分条目缺省）。 */
  sub_title?: string;
  /** 年份字符串（部分条目缺省或为区间，如 "2019" / "2019-2021"）。 */
  year?: string;
  /** 海报 URL（缺省常见）。 */
  img?: string;
  /** 剧集条目的集数提示（仅 tv，缺省常见）。 */
  episode?: string;
}

/** 详情页 JSON-LD 的已映射最小形状（文档化；只取用到的键）。 */
export interface DoubanDetailLd {
  '@type': string;
  name: string;
  image?: string;
  /** 条目简介（部分条目缺省）。 */
  description?: string;
  /** ISO 8601 日期或年份字符串。 */
  datePublished?: string;
  /** schema.org 作者/导演节点（name 必取）。 */
  director?: Array<{ name?: string }>;
  actor?: Array<{ name?: string }>;
  genre?: string | string[];
  aggregateRating?: { ratingValue?: number | string };
}

export interface StructureProblem {
  /** 偏差位置，如 `suggest[3]` / `ld-json`。 */
  where: string;
  /** 人类可读的结构偏差描述（不含网络细节）。 */
  problem: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 校验 subject_suggest 响应整体：必须是对象数组，且每条满足
 * SUGGEST_REQUIRED_FIELDS。任何偏差 → 结构问题列表（调用方转为
 * UPSTREAM_CHANGED，禁止把偏差静默成空结果）。
 */
export function validateDoubanSuggestPayload(body: unknown): StructureProblem[] {
  if (!Array.isArray(body)) {
    return [{ where: 'suggest', problem: '响应必须是数组' }];
  }
  const problems: StructureProblem[] = [];
  body.forEach((entry, index) => {
    const where = `suggest[${index}]`;
    if (!isRecord(entry)) {
      problems.push({ where, problem: '条目必须是对象' });
      return;
    }
    for (const field of SUGGEST_REQUIRED_FIELDS) {
      if (typeof entry[field] !== 'string' || (entry[field] as string).length === 0) {
        problems.push({ where, problem: `缺少必需字段 ${field}` });
      }
    }
    if (typeof entry.id === 'string' && !/^\d+$/.test(entry.id)) {
      problems.push({ where, problem: 'id 必须是纯数字 subject id' });
    }
    if (typeof entry.url === 'string' && !entry.url.startsWith(DOUBAN_SUBJECT_URL_PREFIX)) {
      problems.push({ where, problem: `url 必须以 ${DOUBAN_SUBJECT_URL_PREFIX} 开头` });
    }
    // url 必须内含本条目 id（url/id 一致性锚点，防错位关联）。
    if (
      typeof entry.id === 'string' &&
      typeof entry.url === 'string' &&
      entry.url.startsWith(DOUBAN_SUBJECT_URL_PREFIX) &&
      !entry.url.startsWith(`${DOUBAN_SUBJECT_URL_PREFIX}${entry.id}/`)
    ) {
      problems.push({ where, problem: 'url 与 id 不一致' });
    }
  });
  return problems;
}

/**
 * 校验详情页 JSON-LD 对象：@type 与必需键锚点。偏差 → 结构问题列表。
 */
export function validateDoubanDetailLd(ld: unknown): StructureProblem[] {
  if (!isRecord(ld)) {
    return [{ where: 'ld-json', problem: 'JSON-LD 必须是对象' }];
  }
  const problems: StructureProblem[] = [];
  for (const field of DETAIL_LDJSON_REQUIRED_FIELDS) {
    if (typeof ld[field] !== 'string' || (ld[field] as string).length === 0) {
      problems.push({ where: 'ld-json', problem: `缺少必需字段 ${field}` });
    }
  }
  if (typeof ld['@type'] === 'string' && !(DETAIL_LDJSON_TYPES as readonly string[]).includes(ld['@type'])) {
    problems.push({
      where: 'ld-json',
      problem: `@type 必须是 ${DETAIL_LDJSON_TYPES.join('|')}（收到 ${ld['@type']}）`,
    });
  }
  return problems;
}

/** 从 HTML 中提取全部 JSON-LD 块文本（QYP2-031 实现复用；此处仅契约）。 */
export function extractLdJsonBlocks(html: string): string[] {
  const blocks: string[] = [];
  const marker = DETAIL_LDJSON_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`<script[^>]*type="${marker}"[^>]*>([\\s\\S]*?)</script>`, 'gi');
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    blocks.push(match[1].trim());
  }
  return blocks;
}

/**
 * 结构偏差 → 插件错误的统一转换（§11.4：页面结构变化返回
 * UPSTREAM_CHANGED 并暂停批量任务）。QYP2-031 与 contract test 共用，
 * 保证语义只有一处定义。空列表属于调用方契约违反（结构没问题就不该
 * 调本函数），显式 fail-fast，不静默成合法。
 */
export function structureProblemsToError(problems: StructureProblem[]): PluginError {
  if (problems.length === 0) {
    throw new Error('structureProblemsToError：问题列表为空——结构合法时不应调用本函数');
  }
  const first = problems[0];
  return new PluginError('UPSTREAM_CHANGED', `豆瓣页面结构变化：${first.where} ${first.problem}`);
}
