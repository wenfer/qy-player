/**
 * Douban experimental metadata plugin (QYP2-031, plan §11.4, ADR-0006).
 *
 * ⚠️ 发布门禁（ADR-0006）：本工厂**未注册进 registry、没有任何启用
 * 开关**——人工产品/法律/技术评审签认 ADR-0006 之前，豆瓣插件保持
 * 「已内置（代码就绪）但不可启用」。接入 registry 属于签认后的接线
 * 动作，不得提前。本文件不得在任何 UI/文档中呈现为正式可用功能。
 *
 * 安全降级语义（§11.4）：
 * - 结构变化 → UPSTREAM_CHANGED（job-service 收到后暂停整批任务）；
 * - 限流 → RATE_LIMITED（可稍后重试）；
 * - 无季/集粒度 → NOT_FOUND（诚实拒绝，不假装支持）；
 * - 合法空结果 → []（matcher 保留现有元数据，绝不覆盖）；
 * - 任何失败不阻断播放（插件只被刮削任务调用）。
 */

import {
  PluginError,
  type MetadataCandidate,
  type MetadataLookupInput,
  type MetadataPayload,
  type MetadataProviderPlugin,
  type MetadataSearchInput,
} from '../../../shared/types/plugins';
import { validateMetadataPayload } from '../../modules/metadata/metadata-merger';
import { DoubanClient } from './client';
import { detailLdToPayload, suggestToCandidates } from './mapper';

export interface DoubanPluginOptions {
  /** 仅测试用：压缩自限速间隔（生产保持默认 3s）。 */
  minIntervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export function buildDoubanPlugin(options: DoubanPluginOptions = {}): MetadataProviderPlugin {
  return {
    manifest: {
      id: 'douban',
      name: '豆瓣（实验性）',
      version: '0.1.0',
      apiVersion: 1,
      capability: 'metadata-provider',
    },

    async search(input: MetadataSearchInput, context): Promise<MetadataCandidate[]> {
      const client = new DoubanClient(context, options);
      context.http.allowHosts(['movie.douban.com']);
      const items = await client.searchSuggest(input.query, input.kind);
      return suggestToCandidates(items);
    },

    async getDetails(id: string, input: MetadataLookupInput, context): Promise<MetadataPayload> {
      // 豆瓣条目页无分集结构：诚实拒绝而不是返回整季数据冒充单集。
      if (input.season !== undefined || input.episode !== undefined) {
        throw new PluginError('NOT_FOUND', '豆瓣实验插件不提供季/集分集元数据');
      }
      const client = new DoubanClient(context, options);
      context.http.allowHosts(['movie.douban.com']);
      const ld = await client.fetchSubjectDetail(id);
      const payload = detailLdToPayload(ld, id);
      const problems = validateMetadataPayload(payload);
      if (problems.length > 0) {
        throw new PluginError('INVALID_RESPONSE', `豆瓣输出不合法：${problems[0]}`);
      }
      return payload;
    },
  };
}
