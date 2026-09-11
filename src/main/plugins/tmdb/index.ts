import {
  PluginError,
  type MetadataCandidate,
  type MetadataLookupInput,
  type MetadataPayload,
  type MetadataProviderPlugin,
  type MetadataSearchInput,
  type PluginContext,
} from '../../../shared/types/plugins';
import { validateMetadataPayload } from '../../modules/metadata/metadata-merger';
import { TmdbClient, TMDB_API_HOST, TMDB_IMAGE_HOST } from './client';
import {
  mapEpisodeDetails,
  mapMovieDetails,
  mapSearchResults,
  mapSeasonDetails,
  mapTvDetails,
} from './mapper';

/**
 * TMDB built-in plugin (QYP2-029, plan §11.3).
 *
 * - Official API only; the user supplies their own v4 Read Access Token
 *   (stored in the SecretStore via QYP2-027's plugin settings UI). The
 *   token travels as a Bearer header — never in URLs/queries.
 * - Unconfigured → AUTH_REQUIRED on every call; the plugin stays
 *   installed but unusable.
 * - locale zh-CN primary with en-US field-wise fallback (§11.3).
 * - Every mapped payload passes runtime schema validation before leaving
 *   the plugin (§11.1: 输出需 runtime schema 验证).
 * - Movies/series/seasons/episodes all route through getDetails: the
 *   LookupInput's kind + season/episode pick the endpoint.
 */

const LOCALE_PRIMARY = 'zh-CN';
const LOCALE_FALLBACK = 'en-US';
const APPEND = 'credits,external_ids,images';
const IMAGE_LANG = 'zh-CN,en,null';

export function buildTmdbPlugin(): MetadataProviderPlugin {
  return {
    manifest: {
      id: 'tmdb',
      name: 'TMDB',
      version: '1.0.0',
      apiVersion: 1,
      capability: 'metadata-provider',
    },

    async search(input: MetadataSearchInput, context: PluginContext): Promise<MetadataCandidate[]> {
      const client = new TmdbClient(prepare(context));
      try {
        // zh-CN first; en-US only when zh returned nothing (§11.3 回退).
        const zh = await searchLocale(client, input, LOCALE_PRIMARY);
        if (zh.length > 0) return zh;
        return await searchLocale(client, input, LOCALE_FALLBACK);
      } catch (err) {
        if (err instanceof PluginError && err.code === 'NOT_FOUND') return [];
        throw err;
      }
    },

    async getDetails(id: string, input: MetadataLookupInput, context: PluginContext): Promise<MetadataPayload> {
      const client = new TmdbClient(prepare(context));
      const safeId = encodeURIComponent(id);
      const common = { language: LOCALE_PRIMARY, append_to_response: APPEND, include_image_language: IMAGE_LANG };

      // Route by LookupInput (§11.3: 电影、剧集、季、集都支持). Season/
      // episode routes come first, and ONLY for series lookups — a movie
      // query carrying season/episode numbers stays on the movie endpoint.
      const isSeries = input.kind === 'series' || input.kind === undefined;
      if (isSeries && input.season !== undefined && input.episode !== undefined) {
        const zh = await client.get(
          `/tv/${safeId}/season/${input.season}/episode/${input.episode}`,
          { language: LOCALE_PRIMARY }
        );
        const en = await client.get(
          `/tv/${safeId}/season/${input.season}/episode/${input.episode}`,
          { language: LOCALE_FALLBACK }
        );
        return finish(mapEpisodeDetails(zh, en));
      }
      if (isSeries && input.season !== undefined) {
        const zh = await client.get(`/tv/${safeId}/season/${input.season}`, { language: LOCALE_PRIMARY });
        const en = await client.get(`/tv/${safeId}/season/${input.season}`, { language: LOCALE_FALLBACK });
        return finish(mapSeasonDetails(zh, en));
      }
      if (input.kind === 'series') {
        const zh = await client.get(`/tv/${safeId}`, common);
        const en = await client.get(`/tv/${safeId}`, { ...common, language: LOCALE_FALLBACK });
        return finish(mapTvDetails(zh, en));
      }
      // kind === 'movie' or undefined: the default endpoint.
      const zh = await client.get(`/movie/${safeId}`, common);
      const en = await client.get(`/movie/${safeId}`, { ...common, language: LOCALE_FALLBACK });
      return finish(mapMovieDetails(zh, en));
    },
  };

  function prepare(context: PluginContext): PluginContext {
    context.http.allowHosts([TMDB_API_HOST, TMDB_IMAGE_HOST]);
    return context;
  }

  function finish(payload: MetadataPayload): MetadataPayload {
    const problems = validateMetadataPayload(payload);
    if (problems.length > 0) {
      throw new PluginError('INVALID_RESPONSE', `TMDB 输出不合法：${problems[0]}`);
    }
    return payload;
  }

  async function searchLocale(
    client: TmdbClient,
    input: MetadataSearchInput,
    locale: string
  ): Promise<MetadataCandidate[]> {
    const params: Record<string, string | number | undefined> = {
      query: input.query,
      language: locale,
      year: input.kind === 'series' ? undefined : input.year,
      first_air_date_year: input.kind === 'series' ? input.year : undefined,
    };
    const res =
      input.kind === 'series'
        ? await client.get('/search/tv', params)
        : await client.get('/search/movie', params);
    return mapSearchResults(res.results);
  }
}
