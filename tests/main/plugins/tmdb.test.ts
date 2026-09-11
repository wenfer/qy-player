import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildTmdbPlugin } from '../../../src/main/plugins/tmdb';
import type { MetadataCandidate, PluginContext } from '../../../src/shared/types/plugins';
import { validateMetadataPayload } from '../../../src/main/modules/metadata/metadata-merger';

/**
 * Fixtures mirror official TMDB v3 shapes (trimmed to used fields).
 */

const MOVIE_ZH = {
  id: 123,
  title: '流浪地球',
  original_title: 'The Wandering Earth',
  overview: '太阳即将毁灭。',
  release_date: '2019-02-05',
  vote_average: 7.9,
  runtime: 125,
  tagline: '带地球去流浪',
  genres: [{ id: 878, name: '科幻' }],
  production_companies: [{ id: 1, name: '中影' }],
  production_countries: [{ iso_3166_1: 'CN', name: '中国' }],
  credits: {
    cast: [{ name: '吴京', character: '刘培强', profile_path: '/wu.jpg' }],
    crew: [{ name: '郭帆', job: 'Director' }],
  },
  external_ids: { imdb_id: 'tt7605074' },
  images: { posters: [{ file_path: '/poster.jpg' }], backdrops: [{ file_path: '/back.jpg' }] },
};

const MOVIE_EN = {
  id: 123,
  title: 'The Wandering Earth',
  original_title: 'The Wandering Earth',
  overview: 'The sun is dying.',
  release_date: '2019-02-05',
  vote_average: 7.9,
  runtime: 125,
  genres: [{ id: 878, name: 'Science Fiction' }],
  production_companies: [{ id: 1, name: 'China Film' }],
  production_countries: [{ iso_3166_1: 'CN', name: 'China' }],
  credits: { cast: [], crew: [] },
  external_ids: { imdb_id: 'tt7605074' },
  images: {},
};

const TV_ZH = {
  id: 456,
  name: '绝命毒师',
  original_name: 'Breaking Bad',
  overview: '化学老师的转身。',
  first_air_date: '2008-01-20',
  vote_average: 8.9,
  genres: [{ id: 18, name: '剧情' }],
  production_companies: [],
  production_countries: [],
  credits: { cast: [{ name: '布莱恩', character: 'Walter' }], crew: [] },
  external_ids: { imdb_id: 'tt0903747', tvdb_id: '79614' },
  images: { posters: [{ file_path: '/tv.jpg' }] },
};

const TV_EN = {
  id: 456,
  name: 'Breaking Bad',
  original_name: 'Breaking Bad',
  overview: 'A chemistry teacher turns.',
  first_air_date: '2008-01-20',
  vote_average: 8.9,
  genres: [{ id: 18, name: 'Drama' }],
  production_companies: [],
  production_countries: [],
  credits: { cast: [], crew: [] },
  external_ids: {},
  images: {},
};

const SEASON_ZH = {
  season_number: 1,
  name: '第 1 季',
  overview: '第一季剧情。',
  air_date: '2008-01-20',
};

const EPISODE_ZH = {
  season_number: 1,
  episode_number: 3,
  name: '初见',
  overview: '第三集剧情。',
  air_date: '2008-02-10',
  vote_average: 8.1,
};

function makeContext(secret: string | null) {
  const requests: Array<{ url: string; headers: Record<string, string>; query: Record<string, unknown> }> = [];
  const responses = new Map<string, unknown>();
  const context: PluginContext = {
    pluginId: 'tmdb',
    locale: 'zh-CN',
    appVersion: 'test',
    http: {
      allowHosts: vi.fn(),
      request: async (req) => {
        // Apply the client's structured query params to the URL (the real
        // context client does this before dispatching).
        const url = new URL(req.url);
        for (const [key, value] of Object.entries(req.query ?? {})) {
          if (value !== undefined) url.searchParams.set(key, String(value));
        }
        const finalUrl = url.toString();
        requests.push({ url: finalUrl, headers: req.headers ?? {}, query: req.query ?? {} });
        const key = `${url.pathname.replace(/^\/3/, '')}?${url.searchParams.get('language') ?? ''}`;
        if (responses.has(key)) {
          const value = responses.get(key);
          if (typeof value === 'number') {
            // Simulated HTTP status (codes ≥400 only).
            return { status: value, headers: {}, body: Buffer.from('{}') };
          }
          if (typeof value === 'string') {
            // Raw body: corrupt JSON fixtures.
            return { status: 200, headers: {}, body: Buffer.from(value) };
          }
          return { status: 200, headers: {}, body: Buffer.from(JSON.stringify(value)) };
        }
        return { status: 404, headers: {}, body: Buffer.from('{}') };
      },
    },
    cache: {
      get: () => undefined,
      set: () => undefined,
      delete: () => undefined,
      clear: () => undefined,
    },
    secrets: {
      get: () => secret,
      has: () => secret !== null,
    },
  };
  return {
    context,
    requests,
    /** Queue a status or payload per path+language. */
    respond(path: string, language: string | null, value: unknown): void {
      responses.set(`${path}?${language ?? ''}`, value);
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('TMDB plugin (QYP2-029)', () => {
  it('throws AUTH_REQUIRED when no token is configured (§11.3)', async () => {
    const plugin = buildTmdbPlugin();
    const ctx = makeContext(null);
    await expect(plugin.search({ query: '流浪地球' }, ctx.context)).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
    });
    await expect(plugin.getDetails('123', { kind: 'movie' }, ctx.context)).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
    });
    // No request may leave without credentials.
    expect(ctx.requests).toHaveLength(0);
  });

  it('sends the token as a Bearer header — never in the URL or query', async () => {
    const plugin = buildTmdbPlugin();
    const ctx = makeContext('secret-token-abc');
    ctx.respond('/search/movie', 'zh-CN', { results: [] });
    ctx.respond('/search/movie', 'en-US', { results: [] });
    await plugin.search({ query: '流浪地球' }, ctx.context);
    expect(ctx.requests.length).toBeGreaterThan(0);
    for (const request of ctx.requests) {
      expect(request.url).not.toContain('secret-token-abc');
      expect(request.headers.Authorization).toBe('Bearer secret-token-abc');
      expect(JSON.stringify(request.query)).not.toContain('secret-token-abc');
    }
  });

  it('maps movie search results to candidates (host scores them)', async () => {
    const plugin = buildTmdbPlugin();
    const ctx = makeContext('tok');
    ctx.respond('/search/movie', 'zh-CN', {
      results: [
        { id: 123, title: '流浪地球', original_title: 'The Wandering Earth', release_date: '2019-02-05' },
        { id: 999 }, // no title: dropped
        'garbage',
      ],
    });
    const candidates = await plugin.search({ query: '流浪地球', kind: 'movie' }, ctx.context);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ id: '123', title: '流浪地球', year: 2019 });
  });

  it('falls back to en-US when zh-CN returns no results', async () => {
    const plugin = buildTmdbPlugin();
    const ctx = makeContext('tok');
    ctx.respond('/search/movie', 'zh-CN', { results: [] });
    ctx.respond('/search/movie', 'en-US', { results: [{ id: 555, title: 'Fallback' }] });
    const candidates = await plugin.search({ query: 'whatever', kind: 'movie' }, ctx.context);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].title).toBe('Fallback');
  });

  it('maps 401 → AUTH_REQUIRED and 429 → RATE_LIMITED', async () => {
    const plugin = buildTmdbPlugin();
    const ctx = makeContext('tok');
    ctx.respond('/search/movie', 'zh-CN', 401);
    await expect(plugin.search({ query: 'x' }, ctx.context)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });

    const ctx2 = makeContext('tok');
    ctx2.respond('/search/movie', 'zh-CN', 429);
    await expect(plugin.search({ query: 'x' }, ctx2.context)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('maps movie details with full closure and schema validity', async () => {
    const plugin = buildTmdbPlugin();
    const ctx = makeContext('tok');
    ctx.respond('/movie/123', 'zh-CN', MOVIE_ZH);
    ctx.respond('/movie/123', 'en-US', MOVIE_EN);
    const payload = await plugin.getDetails('123', { kind: 'movie' }, ctx.context);
    expect(validateMetadataPayload(payload)).toEqual([]);
    expect(payload.kind).toBe('movie');
    expect(payload.title).toBe('流浪地球');
    expect(payload.originalTitle).toBe('The Wandering Earth');
    expect(payload.plot).toBe('太阳即将毁灭。');
    expect(payload.genres).toEqual(['科幻']);
    expect(payload.studios).toEqual(['中影']);
    expect(payload.countries).toEqual(['中国']);
    expect(payload.actors[0]).toMatchObject({ name: '吴京', role: '刘培强' });
    expect(payload.actors[0].thumb).toContain('image.tmdb.org');
    expect(payload.directors).toEqual(['郭帆']);
    expect(payload.uniqueIds).toEqual([
      { provider: 'tmdb', id: '123' },
      { provider: 'imdb', id: 'tt7605074' },
    ]);
    expect(payload.thumbs).toHaveLength(2);
    expect(payload.thumbs[0]).toContain('image.tmdb.org/t/p/original');
  });

  it('fills zh gaps from en (language fallback, §11.3)', async () => {
    const plugin = buildTmdbPlugin();
    const ctx = makeContext('tok');
    // zh has an EMPTY overview — en must fill it.
    ctx.respond('/movie/123', 'zh-CN', { ...MOVIE_ZH, overview: '' });
    ctx.respond('/movie/123', 'en-US', MOVIE_EN);
    const payload = await plugin.getDetails('123', { kind: 'movie' }, ctx.context);
    expect(payload.plot).toBe('The sun is dying.');
    expect(payload.tagline).toBe('带地球去流浪'); // zh value kept
    // zh-localized genre names win; en fills nothing here.
    expect(payload.genres).toEqual(['科幻']);
  });

  it('maps series, season and episode lookups', async () => {
    const plugin = buildTmdbPlugin();
    const ctx = makeContext('tok');
    ctx.respond('/tv/456', 'zh-CN', TV_ZH);
    ctx.respond('/tv/456', 'en-US', TV_EN);
    const series = await plugin.getDetails('456', { kind: 'series' }, ctx.context);
    expect(validateMetadataPayload(series)).toEqual([]);
    expect(series.kind).toBe('tvshow');
    expect(series.title).toBe('绝命毒师');
    expect(series.uniqueIds).toEqual([
      { provider: 'tmdb', id: '456' },
      { provider: 'imdb', id: 'tt0903747' },
      { provider: 'tvdb', id: '79614' },
    ]);

    ctx.respond('/tv/456/season/1', 'zh-CN', SEASON_ZH);
    const season = await plugin.getDetails('456', { kind: 'series', season: 1 }, ctx.context);
    expect(validateMetadataPayload(season)).toEqual([]);
    expect(season).toMatchObject({ kind: 'season', season: 1, title: '第 1 季' });

    ctx.respond('/tv/456/season/1/episode/3', 'zh-CN', EPISODE_ZH);
    const episode = await plugin.getDetails('456', { kind: 'series', season: 1, episode: 3 }, ctx.context);
    expect(validateMetadataPayload(episode)).toEqual([]);
    expect(episode).toMatchObject({ kind: 'episode', season: 1, episode: 3, title: '初见' });
  });

  it('allows only the official TMDB hosts', () => {
    const plugin = buildTmdbPlugin();
    const ctx = makeContext('tok');
    plugin.search({ query: 'x' }, ctx.context).catch(() => undefined);
    const calls = (ctx.context.http.allowHosts as ReturnType<typeof vi.fn>).mock.calls as string[][];
    const hosts = calls.flat(2);
    expect(hosts).toContain('api.themoviedb.org');
    expect(hosts).toContain('image.tmdb.org');
    expect(hosts).toHaveLength(2);
  });

  it('candidate ids stay opaque strings usable for getDetails', async () => {
    const plugin = buildTmdbPlugin();
    const ctx = makeContext('tok');
    ctx.respond('/search/movie', 'zh-CN', { results: [{ id: 123, title: '流浪地球' }] });
    const candidates: MetadataCandidate[] = await plugin.search({ query: '流浪地球' }, ctx.context);
    ctx.respond('/movie/123', 'zh-CN', MOVIE_ZH);
    ctx.respond('/movie/123', 'en-US', MOVIE_EN);
    const payload = await plugin.getDetails(candidates[0].id, { kind: 'movie' }, ctx.context);
    expect(payload.title).toBe('流浪地球');
  });

  it('invalid-shaped upstream payloads surface INVALID_RESPONSE (never stored)', async () => {
    const plugin = buildTmdbPlugin();
    const ctx = makeContext('tok');
    // Corrupt JSON body: the client's schema gate must surface INVALID_RESPONSE.
    ctx.respond('/movie/123', 'zh-CN', 'this is { not json');
    ctx.respond('/movie/123', 'en-US', MOVIE_EN);
    ctx.respond('/movie/123', 'en-US', MOVIE_EN);
    await expect(plugin.getDetails('123', { kind: 'movie' }, ctx.context)).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
  });
});
