import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabaseAtPath } from '../../../src/main/modules/storage/db';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import { createCatalogRepository, type CatalogRepository } from '../../../src/main/modules/catalog/repository';
import { cardFromCatalogContinue, createUnifiedQueryService } from '../../../src/main/modules/catalog/unified-query';
import type { OnlineContinueInput } from '../../../src/main/modules/catalog/unified-query';

/**
 * 「继续观看」里的剧集卡必须带上剧名与季集编号——没有这些字段，界面既不知道
 * 它是一集电视剧（角标落回"电影"），也无从显示 SxxExx。
 *
 * 本地目录这条路的季/集编号在 catalog_items 上（episode.parent_id → season
 * → series），SQL 得沿着父链把剧名捞出来。
 */

let dbDir: string;
let db: SqliteDatabase;
let repo: CatalogRepository;
let sourceId: number;

/** 造一部剧：series → season → episode（title 留空：NFO 常只有季集编号） */
function seedEpisode(options?: { title?: string; hasSeries?: boolean }) {
  const seriesId = repo.upsertItem({
    sourceId,
    sourceKey: 'series:绝命毒师',
    kind: 'series',
    title: '绝命毒师',
  });
  const seasonId = repo.upsertItem({
    sourceId,
    sourceKey: 'series:绝命毒师:s2',
    parentId: seriesId,
    kind: 'season',
    seasonNumber: 2,
    title: '第 2 季',
  });
  const episodeId = repo.upsertItem({
    sourceId,
    sourceKey: 'series:绝命毒师:s2e5',
    parentId: seasonId,
    kind: 'episode',
    seasonNumber: 2,
    episodeNumber: 5,
    ...(options?.title ? { title: options.title } : {}),
  });
  return { seriesId, seasonId, episodeId };
}

beforeEach(() => {
  dbDir = mkdtempSync(join(tmpdir(), 'qy-cw-ep-'));
  db = openDatabaseAtPath(join(dbDir, 'catalog.db'));
  repo = createCatalogRepository(db);
  sourceId = repo.createSource({ kind: 'local', name: '影视库', root: '/video', purpose: 'video' });
});

afterEach(() => {
  rmSync(dbDir, { recursive: true, force: true });
});

function serviceWith(online: OnlineContinueInput[]) {
  return createUnifiedQueryService({
    db,
    onlineContinueWatching: async () => online,
    onlineSearch: async () => [],
    onlineRecent: async () => [],
  });
}

describe('continue watching: episode cards', () => {
  it('local episode carries series name and S/E numbers', async () => {
    const { episodeId } = seedEpisode({ title: '绝命毒师 S02E05' });
    repo.upsertUserState({ itemId: episodeId, position: 600, duration: 3000, isFinished: false });

    const cards = await serviceWith([]).continueWatching(20);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      kind: 'episode',
      seriesName: '绝命毒师',
      seasonNumber: 2,
      episodeNumber: 5,
      position: 600,
    });
  });

  it('episode without its own title falls back to the series name (not 未知)', async () => {
    const { episodeId } = seedEpisode();
    repo.upsertUserState({ itemId: episodeId, position: 600, duration: 3000, isFinished: false });

    const [card] = await serviceWith([]).continueWatching(20);
    expect(card.title).toBe('绝命毒师');
  });

  it('online episode card keeps the server-side series info', async () => {
    const cards = await serviceWith([
      {
        provider: 'emby',
        serverId: 7,
        itemId: 'ep-1',
        title: '第五集',
        kind: 'Episode',
        positionTicks: 600_0000000,
        runtimeTicks: 3000_0000000,
        seriesName: '绝命毒师',
        seasonNumber: 2,
        episodeNumber: 5,
      },
    ]).continueWatching(20);

    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      kind: 'Episode',
      seriesName: '绝命毒师',
      seasonNumber: 2,
      episodeNumber: 5,
    });
  });

  it('movie rows stay untouched (no stray episode fields)', async () => {
    const movieId = repo.upsertItem({ sourceId, sourceKey: 'movie:1', kind: 'movie', title: '某电影', year: 2019 });
    repo.upsertUserState({ itemId: movieId, position: 600, duration: 3000, isFinished: false });

    const [card] = await serviceWith([]).continueWatching(20);
    expect(card.kind).toBe('movie');
    expect(card.seriesName).toBeUndefined();
    expect(card.seasonNumber).toBeUndefined();
    expect(card.episodeNumber).toBeUndefined();
  });

  it('cardFromCatalogContinue maps the flat row without touching SQL', () => {
    const card = cardFromCatalogContinue({
      item_id: 1,
      source_id: 2,
      source_kind: 'local',
      title: null,
      kind: 'episode',
      year: null,
      rating_json: 'null',
      position: 10,
      duration: 100,
      updated_at: 1000,
      season_number: 1,
      episode_number: 12,
      series_title: '某剧',
    });
    expect(card.title).toBe('某剧');
    expect(card.seriesName).toBe('某剧');
    expect(card.seasonNumber).toBe(1);
    expect(card.episodeNumber).toBe(12);
  });
});
