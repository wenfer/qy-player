/**
 * Douban page-shape → MetadataPayload mappers (QYP2-031, plan §11.4).
 *
 * 字段范围刻意保守（ADR-0006）：只映射 JSON-LD / suggest 里真实可靠
 * 的字段，拿不到的留空——不猜测、不从 HTML 布局抠脆弱字段。
 */

import type { MetadataCandidate, MetadataPayload } from '../../../shared/types/plugins';
import type { DoubanDetailLd, DoubanSuggestItem } from './types';

/** subject_suggest 条目 → 候选（score 由宿主 matcher 计算，§11.2）。 */
export function suggestToCandidates(items: DoubanSuggestItem[]): MetadataCandidate[] {
  const out: MetadataCandidate[] = [];
  for (const item of items) {
    if (typeof item.id !== 'string' || !/^\d+$/.test(item.id)) continue;
    if (typeof item.title !== 'string' || item.title.trim().length === 0) continue;
    const year = typeof item.year === 'string' ? Number(item.year.slice(0, 4)) : NaN;
    out.push({
      id: item.id,
      title: item.title.trim(),
      ...(typeof item.sub_title === 'string' && item.sub_title.trim() ? { originalTitle: item.sub_title.trim() } : {}),
      ...(Number.isInteger(year) ? { year } : {}),
      score: 0,
    });
  }
  return out;
}

function numberOr(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function stringOr(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * 条目页 JSON-LD → payload。kind 按 @type（Movie→movie / TVSeries→tvshow）。
 * 豆瓣不提供季/集粒度——LookupInput 带季/集时上层直接 NOT_FOUND，
 * 不在本函数处理。
 */
export function detailLdToPayload(ld: DoubanDetailLd, subjectId: string): MetadataPayload {
  const kind = ld['@type'] === 'TVSeries' ? 'tvshow' : 'movie';
  const premiered = stringOr(ld.datePublished);
  const rating = numberOr(ld.aggregateRating?.ratingValue);
  const image = stringOr(ld.image);
  const genres = Array.isArray(ld.genre)
    ? ld.genre.map((entry) => stringOr(entry)).filter((entry): entry is string => entry !== undefined)
    : [stringOr(ld.genre)].filter((entry): entry is string => entry !== undefined);
  const actors = Array.isArray(ld.actor)
    ? ld.actor
        .map((entry) => stringOr(entry?.name))
        .filter((entry): entry is string => entry !== undefined)
        .map((name) => ({ name, role: undefined, thumb: undefined }))
    : [];
  const directors = (Array.isArray(ld.director) ? ld.director : [])
    .map((entry) => stringOr(entry?.name))
    .filter((entry): entry is string => entry !== undefined);

  const payload: MetadataPayload = {
    kind,
    title: stringOr(ld.name),
    premiered,
    plot: stringOr(ld.description),
    runtime: undefined,
    rating: rating !== undefined && rating >= 0 && rating <= 10 ? rating : undefined,
    genres: genres.slice(0, 20),
    studios: [],
    countries: [],
    actors: actors.slice(0, 50),
    directors: directors.slice(0, 10),
    uniqueIds: [{ provider: 'douban', id: subjectId }],
    thumbs: image !== undefined ? [image] : [],
    ...(premiered && premiered.length >= 4 ? { year: Number(premiered.slice(0, 4)) } : {}),
  };
  return payload;
}
