import type { MetadataCandidate, MetadataPayload } from '../../../shared/types/plugins';

/**
 * TMDB → MetadataPayload mappers (QYP2-029, plan §11.3).
 *
 * Language fallback (§11.3): the zh-CN response is primary; the en-US
 * response fills only fields the zh response left missing/empty. The merge
 * is field-wise on the FINAL payload shape, after TMDB lists (genres etc.)
 * are already resolved to names — zh-CN TMDB often returns localized genre
 * names, which is what we want; en only fills outright gaps.
 */

interface TmdbListItem {
  id: number;
  title?: string;
  name?: string;
  original_title?: string;
  original_name?: string;
  release_date?: string;
  first_air_date?: string;
}

interface TmdbGenre {
  id: number;
  name: string;
}

interface TmdbCastMember {
  name: string;
  character?: string;
  profile_path?: string | null;
}

interface TmdbCrewMember {
  name: string;
  job?: string;
}

export function mapSearchResults(results: unknown, kind: 'movie' | 'series'): MetadataCandidate[] {
  if (!Array.isArray(results)) return [];
  const out: MetadataCandidate[] = [];
  for (const entry of results) {
    if (typeof entry !== 'object' || entry === null) continue;
    const item = entry as TmdbListItem;
    const id = typeof item.id === 'number' ? item.id : NaN;
    const title = item.title ?? item.name;
    const originalTitle = item.original_title ?? item.original_name;
    if (!Number.isInteger(id) || typeof title !== 'string' || title.length === 0) continue;
    const date = item.release_date ?? item.first_air_date;
    const year = typeof date === 'string' && date.length >= 4 ? Number(date.slice(0, 4)) : undefined;
    out.push({
      id: String(id),
      title,
      ...(originalTitle ? { originalTitle } : {}),
      ...(year !== undefined && Number.isFinite(year) ? { year } : {}),
      score: 0, // scored by the host matcher (plan §11.2)
      ...(kind === 'series' ? {} : {}),
    });
  }
  return out;
}

function stringOr(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function numberOr(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function genresOf(source: Record<string, unknown>): string[] {
  const genres = source.genres;
  if (!Array.isArray(genres)) return [];
  return genres
    .map((genre) => (typeof genre === 'object' && genre !== null ? (genre as TmdbGenre).name : undefined))
    .filter((name): name is string => typeof name === 'string' && name.length > 0);
}

function companiesOf(source: Record<string, unknown>): string[] {
  const companies = source.production_companies;
  if (!Array.isArray(companies)) return [];
  return companies
    .map((company) => (typeof company === 'object' && company !== null ? (company as { name?: unknown }).name : undefined))
    .filter((name): name is string => typeof name === 'string' && name.length > 0);
}

function countriesOf(source: Record<string, unknown>): string[] {
  const countries = source.production_countries;
  if (!Array.isArray(countries)) return [];
  return countries
    .map((country) => (typeof country === 'object' && country !== null ? (country as { name?: unknown }).name : undefined))
    .filter((name): name is string => typeof name === 'string' && name.length > 0);
}

function actorsOf(source: Record<string, unknown>): MetadataPayload['actors'] {
  const credits = source.credits as { cast?: unknown } | undefined;
  const cast = Array.isArray(credits?.cast) ? credits.cast : Array.isArray(source.cast) ? source.cast : [];
  const out: MetadataPayload['actors'] = [];
  for (const entry of cast) {
    if (typeof entry !== 'object' || entry === null) continue;
    const member = entry as TmdbCastMember;
    if (typeof member.name !== 'string' || member.name.length === 0) continue;
    out.push({
      name: member.name,
      ...(member.character ? { role: member.character } : {}),
      ...(member.profile_path ? { thumb: `https://${'image.tmdb.org'}/t/p/w185${member.profile_path}` } : {}),
    });
    if (out.length >= 50) break;
  }
  return out;
}

function directorsOf(source: Record<string, unknown>): string[] {
  const credits = source.credits as { crew?: unknown } | undefined;
  const crew = Array.isArray(credits?.crew) ? credits.crew : [];
  const out: string[] = [];
  for (const entry of crew) {
    if (typeof entry !== 'object' || entry === null) continue;
    const member = entry as TmdbCrewMember;
    if (member.job === 'Director' && typeof member.name === 'string') out.push(member.name);
  }
  return out;
}

function uniqueIdsOf(source: Record<string, unknown>, tmdbId: number): MetadataPayload['uniqueIds'] {
  const external = source.external_ids as Record<string, unknown> | undefined;
  const out: MetadataPayload['uniqueIds'] = [{ provider: 'tmdb', id: String(tmdbId) }];
  if (external && typeof external === 'object') {
    if (typeof external.imdb_id === 'string' && external.imdb_id) {
      out.push({ provider: 'imdb', id: external.imdb_id });
    }
    if (typeof external.tvdb_id === 'string' && external.tvdb_id) {
      out.push({ provider: 'tvdb', id: external.tvdb_id });
    }
  }
  return out;
}

function thumbsOf(source: Record<string, unknown>): string[] {
  const images = source.images as Record<string, unknown> | undefined;
  const out: string[] = [];
  if (images && typeof images === 'object') {
    for (const key of ['posters', 'backdrops']) {
      const list = images[key];
      if (!Array.isArray(list)) continue;
      for (const entry of list) {
        if (typeof entry !== 'object' || entry === null) continue;
        const path = (entry as { file_path?: unknown }).file_path;
        if (typeof path === 'string' && path) out.push(`https://${'image.tmdb.org'}/t/p/original${path}`);
        if (out.length >= 20) return out;
      }
    }
  }
  return out;
}

/** Fill zh-gaps with en values, field-wise on the final payload shape. */
function fillFromEn(base: Partial<MetadataPayload>, en: Partial<MetadataPayload>): void {
  for (const key of ['title', 'originalTitle', 'sortTitle', 'premiered', 'plot', 'tagline', 'contentRating'] as const) {
    const current = base[key];
    const fallback = en[key];
    if ((current === undefined || (typeof current === 'string' && current.trim().length === 0)) && typeof fallback === 'string') {
      (base as Record<string, unknown>)[key] = fallback;
    }
  }
  for (const key of ['genres', 'studios', 'countries', 'actors', 'directors', 'uniqueIds', 'thumbs'] as const) {
    const current = base[key];
    if ((current === undefined || current.length === 0) && Array.isArray(en[key])) {
      (base as Record<string, unknown>)[key] = en[key];
    }
  }
  if (base.runtime === undefined && typeof en.runtime === 'number') base.runtime = en.runtime;
  if (base.rating === undefined && typeof en.rating === 'number') base.rating = en.rating;
}

/** Movie details → payload (kind movie). */
export function mapMovieDetails(zh: Record<string, unknown>, en?: Record<string, unknown>): MetadataPayload {
  const id = numberOr(zh.id) ?? 0;
  const base: Partial<MetadataPayload> = {
    kind: 'movie',
    title: stringOr(zh.title),
    originalTitle: stringOr(zh.original_title),
    premiered: stringOr(zh.release_date),
    plot: stringOr(zh.overview),
    tagline: stringOr(zh.tagline),
    runtime: numberOr(zh.runtime),
    rating: numberOr(zh.vote_average),
    contentRating: undefined,
    genres: genresOf(zh),
    studios: companiesOf(zh),
    countries: countriesOf(zh),
    actors: actorsOf(zh),
    directors: directorsOf(zh),
    uniqueIds: uniqueIdsOf(zh, id),
    thumbs: thumbsOf(zh),
  };
  if (en) fillFromEn(base, mapMovieDetails(en));
  const payload = base as MetadataPayload;
  // §11.1: empty required collections still need to exist.
  payload.genres ??= [];
  payload.studios ??= [];
  payload.countries ??= [];
  payload.actors ??= [];
  payload.directors ??= [];
  payload.uniqueIds ??= [{ provider: 'tmdb', id: String(id) }];
  payload.thumbs ??= [];
  return payload;
}

/** TV series details → payload (kind tvshow; seasons are per-season tasks). */
export function mapTvDetails(zh: Record<string, unknown>, en?: Record<string, unknown>): MetadataPayload {
  const id = numberOr(zh.id) ?? 0;
  const base: Partial<MetadataPayload> = {
    kind: 'tvshow',
    title: stringOr(zh.name),
    originalTitle: stringOr(zh.original_name),
    premiered: stringOr(zh.first_air_date),
    plot: stringOr(zh.overview),
    genres: genresOf(zh),
    studios: companiesOf(zh),
    countries: countriesOf(zh),
    actors: actorsOf(zh),
    directors: directorsOf(zh),
    uniqueIds: uniqueIdsOf(zh, id),
    thumbs: thumbsOf(zh),
  };
  if (en) fillFromEn(base, mapTvDetails(en));
  const payload = base as MetadataPayload;
  payload.genres ??= [];
  payload.studios ??= [];
  payload.countries ??= [];
  payload.actors ??= [];
  payload.directors ??= [];
  payload.uniqueIds ??= [{ provider: 'tmdb', id: String(id) }];
  payload.thumbs ??= [];
  return payload;
}

/** Season details → payload (kind season). */
export function mapSeasonDetails(zh: Record<string, unknown>): MetadataPayload {
  const season = numberOr(zh.season_number) ?? 0;
  const base: Partial<MetadataPayload> = {
    kind: 'season',
    title: stringOr(zh.name),
    plot: stringOr(zh.overview),
    premiered: stringOr(zh.air_date),
    season,
  };
  const payload = base as MetadataPayload;
  payload.genres = [];
  payload.studios = [];
  payload.countries = [];
  payload.actors = [];
  payload.directors = [];
  payload.uniqueIds = [];
  payload.thumbs = [];
  return payload;
}

/** Episode details → payload (kind episode). */
export function mapEpisodeDetails(zh: Record<string, unknown>): MetadataPayload {
  const base: Partial<MetadataPayload> = {
    kind: 'episode',
    title: stringOr(zh.name),
    plot: stringOr(zh.overview),
    premiered: stringOr(zh.air_date),
    season: numberOr(zh.season_number),
    episode: numberOr(zh.episode_number),
    rating: numberOr(zh.vote_average),
  };
  const payload = base as MetadataPayload;
  payload.genres = [];
  payload.studios = [];
  payload.countries = [];
  payload.actors = [];
  payload.directors = [];
  payload.uniqueIds = [];
  payload.thumbs = [];
  return payload;
}
