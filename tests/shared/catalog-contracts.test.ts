import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  normalizePageQuery,
  isMediaRef,
} from '@shared/types/catalog';
import type { MediaRef, CatalogItemSummary } from '@shared/types/catalog';
import { ERROR_CODES, ok, err } from '@shared/types/actions';
import type { ActionResult, StructuredError } from '@shared/types/actions';
import { IPC_CHANNELS } from '@shared/ipc-channels';

describe('MediaRef contract', () => {
  it('accepts catalog refs with positive sourceId', () => {
    const ref: MediaRef = { provider: 'catalog', sourceId: 1, itemId: 'opaque-42' };
    expect(isMediaRef(ref)).toBe(true);
  });

  it('accepts online refs with positive serverId', () => {
    expect(isMediaRef({ provider: 'jellyfin', serverId: 3, itemId: 'abc' })).toBe(true);
    expect(isMediaRef({ provider: 'emby', serverId: 3, itemId: 'abc' })).toBe(true);
  });

  it('rejects owner-less or malformed refs', () => {
    expect(isMediaRef(null)).toBe(false);
    expect(isMediaRef('x')).toBe(false);
    expect(isMediaRef({ provider: 'catalog', itemId: 'x' })).toBe(false); // no sourceId
    expect(isMediaRef({ provider: 'catalog', sourceId: 0, itemId: 'x' })).toBe(false);
    expect(isMediaRef({ provider: 'catalog', sourceId: 1.5, itemId: 'x' })).toBe(false);
    expect(isMediaRef({ provider: 'jellyfin', serverId: 3 })).toBe(false); // no itemId
    expect(isMediaRef({ provider: 'webdav', sourceId: 1, itemId: 'x' })).toBe(false); // unknown provider
    expect(isMediaRef({ provider: 'catalog', sourceId: -1, itemId: '' })).toBe(false);
  });

  it('rejects inherited (prototype) properties so polluted prototypes cannot forge a ref', () => {
    const forged = Object.create({
      provider: 'catalog',
      sourceId: 1,
      itemId: 'injected',
    });
    expect(isMediaRef(forged)).toBe(false);
  });
});

describe('pagination contract', () => {
  it('matches declared bounds', () => {
    expect(DEFAULT_PAGE_SIZE).toBe(60);
    expect(MAX_PAGE_SIZE).toBe(200);
  });

  it('applies defaults for missing or invalid queries', () => {
    expect(normalizePageQuery(undefined)).toEqual({ page: 1, pageSize: 60 });
    expect(normalizePageQuery({})).toEqual({ page: 1, pageSize: 60 });
    expect(normalizePageQuery({ page: 0, pageSize: -5 })).toEqual({ page: 1, pageSize: 60 });
    expect(normalizePageQuery({ page: 1.5, pageSize: 10.5 })).toEqual({ page: 1, pageSize: 60 });
  });

  it('clamps pageSize to the contract maximum', () => {
    expect(normalizePageQuery({ page: 2, pageSize: 500 }).pageSize).toBe(200);
    expect(normalizePageQuery({ page: 7, pageSize: 60 })).toEqual({ page: 7, pageSize: 60 });
  });

  it('rejects non-finite and overflowing page numbers', () => {
    expect(normalizePageQuery({ page: Number.POSITIVE_INFINITY, pageSize: 60 }).page).toBe(1);
    expect(normalizePageQuery({ page: Number.NaN, pageSize: 60 }).page).toBe(1);
    expect(normalizePageQuery({ page: Number.MAX_SAFE_INTEGER + 1, pageSize: 60 }).page).toBe(1);
    expect(normalizePageQuery({ page: 2_000_000, pageSize: 60 }).page).toBe(1);
  });
});

describe('ActionResult contract', () => {
  it('success branch carries data only', () => {
    const result: ActionResult<number> = ok(42);
    expect(result).toEqual({ ok: true, data: 42 });
    if (result.ok) expect(result.data).toBe(42);
  });

  it('failure branch carries structured, sanitized errors', () => {
    const failure: ActionResult<never> = err('NETWORK_ERROR', '来源暂时不可用', {
      retryable: true,
      details: { sourceId: 1 },
    });
    expect(failure.ok).toBe(false);
    if (!failure.ok) {
      const error: StructuredError = failure.error;
      expect(error.code).toBe('NETWORK_ERROR');
      expect(error.retryable).toBe(true);
      expect(error.details).toEqual({ sourceId: 1 });
      expect(JSON.stringify(error)).not.toMatch(/password|token|authorization/i);
    }
  });

  it('error defaults to non-retryable and omits empty details', () => {
    const failure = err('NOT_FOUND', '条目不存在');
    if (!failure.ok) {
      expect(failure.error.retryable).toBe(false);
      expect('details' in failure.error).toBe(false);
    }
  });

  it('declares the full error code vocabulary', () => {
    expect([...ERROR_CODES]).toHaveLength(12);
    for (const code of [
      'AUTH_REQUIRED',
      'RATE_LIMITED',
      'NOT_FOUND',
      'UPSTREAM_CHANGED',
      'NETWORK_ERROR',
      'INVALID_RESPONSE',
      'CANCELLED',
      'TIMEOUT',
      'VALIDATION_FAILED',
      'CONFLICT',
      'UNAVAILABLE',
      'INTERNAL',
    ] as const) {
      expect(ERROR_CODES).toContain(code);
    }
  });
});

describe('catalog item summary shape (type-level)', () => {
  it('represents a paged episode row with owner-scoped refs', () => {
    const seriesRef: MediaRef = { provider: 'catalog', sourceId: 2, itemId: 'series-1' };
    const item: CatalogItemSummary = {
      ref: { provider: 'catalog', sourceId: 2, itemId: 'episode-9' },
      kind: 'episode',
      title: '第 5 集',
      availability: 'online',
      seasonNumber: 1,
      episodeNumber: 5,
      seriesRef,
      progress: { position: 600, duration: 2400, isFinished: false },
    };
    expect(item.ref).toBeDefined();
    expect(item.progress?.isFinished).toBe(false);
  });
});

describe('catalog IPC channels', () => {
  it('are globally unique and follow the domain:action format', () => {
    const all: string[] = [];
    const walk = (value: unknown) => {
      if (typeof value === 'string') all.push(value);
      else if (typeof value === 'object' && value !== null) Object.values(value).forEach(walk);
    };
    walk(IPC_CHANNELS);
    expect(new Set(all).size).toBe(all.length);
    for (const channel of all) {
      expect(channel).toMatch(/^[a-z-]+:[a-z-]+$/);
    }
  });

  it('declares the catalog domain channels from plan §4.3', () => {
    expect(IPC_CHANNELS.CATALOG).toMatchObject({
      SOURCE_LIST: 'catalog:source-list',
      SOURCE_TEST: 'catalog:source-test',
      SOURCE_SAVE: 'catalog:source-save',
      SOURCE_REMOVE: 'catalog:source-remove',
      SOURCE_HEALTH: 'catalog:source-health',
      SCAN_START: 'catalog:scan-start',
      SCAN_CANCEL: 'catalog:scan-cancel',
      SCAN_EVENTS: 'catalog:scan-events',
      LIST: 'catalog:list',
      GET: 'catalog:get',
      SEARCH: 'catalog:search',
    });
  });
});
