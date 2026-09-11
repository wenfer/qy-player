import { PluginError, type PluginContext, type PluginHttpRequest } from '../../../shared/types/plugins';

/**
 * TMDB API v3 client (QYP2-029, plan §11.3).
 *
 * - Only the official API host (api.themoviedb.org); images are restricted
 *   to image.tmdb.org by the plugin's allowlist registration.
 * - The configured secret is a v4 Read Access Token sent as a Bearer
 *   header — the key never appears in URLs, query params, logs or errors.
 * - Status mapping to the §11.1 unified codes: 401→AUTH_REQUIRED,
 *   429→RATE_LIMITED, 404→NOT_FOUND, other ≥400→UPSTREAM_CHANGED.
 */

export const TMDB_API_HOST = 'api.themoviedb.org';
export const TMDB_IMAGE_HOST = 'image.tmdb.org';

const BASE_URL = 'https://api.themoviedb.org/3';

export class TmdbClient {
  private readonly ctx: PluginContext;

  constructor(ctx: PluginContext) {
    this.ctx = ctx;
  }

  private token(): string {
    const token = this.ctx.secrets.get('api-token');
    if (!token) {
      // §11.3: installed but unconfigured must surface AUTH_REQUIRED.
      throw new PluginError('AUTH_REQUIRED', '未配置 TMDB API Token');
    }
    return token;
  }

  private statusToError(status: number): PluginError {
    if (status === 401) return new PluginError('AUTH_REQUIRED', 'TMDB 认证失败（401），请检查 Token');
    if (status === 429) return new PluginError('RATE_LIMITED', 'TMDB 限流（429），请稍后重试');
    if (status === 404) return new PluginError('NOT_FOUND', 'TMDB 资源不存在（404）');
    return new PluginError('UPSTREAM_CHANGED', `TMDB 请求失败（HTTP ${status}）`);
  }

  /** One authenticated GET; parsed JSON must be an object (schema gate). */
  async get(path: string, params: Record<string, string | number | undefined> = {}, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const token = this.token();
    const query: Record<string, string | number | undefined> = {};
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) query[key] = value;
    }
    const request: PluginHttpRequest = {
      url: `${BASE_URL}${path}`,
      headers: {
        Authorization: `Bearer ${token}`,
        accept: 'application/json',
      },
      query,
      signal,
    };
    const response = await this.ctx.http.request(request);
    if (response.status >= 400) {
      throw this.statusToError(response.status);
    }
    try {
      const parsed = JSON.parse(response.body.toString('utf8')) as unknown;
      if (typeof parsed !== 'object' || parsed === null) {
        throw new PluginError('INVALID_RESPONSE', 'TMDB 响应不是对象');
      }
      return parsed as Record<string, unknown>;
    } catch (err) {
      if (err instanceof PluginError) throw err;
      throw new PluginError('INVALID_RESPONSE', 'TMDB 响应 JSON 解析失败');
    }
  }
}
