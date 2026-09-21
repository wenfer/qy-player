import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import {
  PlaybackStateManager,
  type CatalogProgressSink,
  type ProgressSyncPayload,
} from '../../../src/main/modules/playback-state';
import type { PlayerCore } from '../../../src/main/modules/player-core';
import type { Storage } from '../../../src/main/modules/storage/db';

/**
 * mpv 引擎音乐不再写播放历史（QYP3-053）。
 *
 * 用户诉求：播放音频不需要记录进度，也不要进播放历史——但 **服务器回传
 * 必须保留**（Emby/Jellyfin 的「继续收听」照旧）。所以两个写入被音乐门禁
 * 挡住，`onProgressSaved` 与本地写解耦后照常触发。
 */

interface FakeStorage {
  addWatchHistory: ReturnType<typeof vi.fn>;
  saveProgress: ReturnType<typeof vi.fn>;
  getProgress: ReturnType<typeof vi.fn>;
}

function makeManager(opts: {
  isMusic: boolean;
  mediaType: string;
  position?: number;
  duration?: number;
  mediaSourceId?: string;
}): {
  manager: PlaybackStateManager;
  storage: FakeStorage;
  catalog: { save: ReturnType<typeof vi.fn>; getResumePosition: () => number };
  saved: ProgressSyncPayload[];
} {
  const emitter = new EventEmitter() as PlayerCore;
  const position = opts.position ?? 42;
  const duration = opts.duration ?? 200;
  (emitter as unknown as { getState: () => { currentTime: number; duration: number } }).getState =
    () => ({ currentTime: position, duration });

  const storage: FakeStorage = {
    addWatchHistory: vi.fn(),
    saveProgress: vi.fn(),
    getProgress: vi.fn(() => undefined),
  };
  const catalog = { save: vi.fn(), getResumePosition: () => 0 };
  const saved: ProgressSyncPayload[] = [];

  const manager = new PlaybackStateManager(
    emitter,
    storage as unknown as Storage,
    catalog as unknown as CatalogProgressSink,
    () => opts.isMusic
  );
  manager.setOnProgressSaved((payload) => {
    saved.push(payload);
  });
  manager.init();
  manager.setCurrentMedia(
    opts.mediaType,
    opts.mediaType === 'local' ? '/music/a.mp3' : 'item-1',
    '云上歌',
    undefined,
    undefined,
    undefined,
    undefined,
    opts.mediaSourceId,
    'ps-1'
  );
  return { manager, storage, catalog, saved };
}

describe('PlaybackStateManager: mpv music skips the local history tables (QYP3-053)', () => {
  it('music writes neither watch_history nor playback_progress', () => {
    const { manager, storage } = makeManager({ isMusic: true, mediaType: 'jellyfin' });
    manager.destroy();

    expect(storage.addWatchHistory).not.toHaveBeenCalled();
    expect(storage.saveProgress).not.toHaveBeenCalled();
  });

  it('music still syncs progress back to the server', () => {
    const { manager, saved } = makeManager({ isMusic: true, mediaType: 'emby' });
    manager.destroy();

    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      mediaType: 'emby',
      mediaId: 'item-1',
      position: 42,
      duration: 200,
      isFinished: false,
      playSessionId: 'ps-1',
      final: true,
    });
  });

  it('webdav music does not touch the catalog user-state sink either', () => {
    const { manager, storage, catalog } = makeManager({ isMusic: true, mediaType: 'webdav' });
    manager.destroy();

    expect(storage.addWatchHistory).not.toHaveBeenCalled();
    expect(catalog.save).not.toHaveBeenCalled();
  });

  it('video is unchanged: history + progress + server sync all still happen', () => {
    const { manager, storage, saved } = makeManager({ isMusic: false, mediaType: 'jellyfin' });
    manager.destroy();

    expect(storage.addWatchHistory).toHaveBeenCalledTimes(1);
    expect(storage.saveProgress).toHaveBeenCalledWith(
      expect.objectContaining({ mediaType: 'jellyfin', mediaId: 'item-1', position: 42, duration: 200 })
    );
    expect(saved).toHaveLength(1);
    expect(saved[0].mediaType).toBe('jellyfin');
  });

  it('video webdav still goes to the catalog sink and never to the legacy tables', () => {
    const { manager, storage, catalog } = makeManager({ isMusic: false, mediaType: 'webdav' });
    manager.destroy();

    expect(catalog.save).toHaveBeenCalledWith('webdav', 'item-1', 42, 200, false);
    expect(storage.saveProgress).not.toHaveBeenCalled();
  });
});

describe('PlaybackStateManager: saveProgressNow for mpv stop (QYP3-067)', () => {
  it('saves once with final=true (server falls back to Stopped semantics)', () => {
    const { manager, saved } = makeManager({ isMusic: true, mediaType: 'jellyfin' });

    manager.saveProgressNow();

    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      mediaType: 'jellyfin',
      mediaId: 'item-1',
      position: 42,
      final: true,
    });
  });

  it('clearCurrentMedia stops further saves (mpv has nothing loaded anymore)', () => {
    const { manager, saved } = makeManager({ isMusic: true, mediaType: 'jellyfin' });

    manager.saveProgressNow();
    manager.clearCurrentMedia();
    manager.saveProgressNow(); // 引擎切换后 mpv 已无播放：不再对着旧媒体保存

    expect(saved).toHaveLength(1);
  });
});
