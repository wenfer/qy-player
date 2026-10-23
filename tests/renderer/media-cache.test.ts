/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getCachedHomeData,
  setCachedHomeData,
  getCachedLibraryItems,
  setCachedLibraryItems,
} from '../../src/renderer/utils/media-cache';

describe('media-cache utils', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it('reads and writes home cache data with timestamps', () => {
    expect(getCachedHomeData()).toBeNull();

    setCachedHomeData({
      continueWatching: [
        {
          id: '1',
          name: '流浪地球',
          type: 'Movie',
        },
      ],
    });

    const cached = getCachedHomeData();
    expect(cached).not.toBeNull();
    expect(cached?.continueWatching).toHaveLength(1);
    expect(cached?.continueWatching?.[0].name).toBe('流浪地球');
    expect(typeof cached?.timestamp).toBe('number');
  });

  it('incrementally merges home cache updates', () => {
    setCachedHomeData({
      continueWatching: [
        {
          id: '1',
          name: '流浪地球',
          type: 'Movie',
        },
      ],
    });

    setCachedHomeData({
      recentAdditions: [
        {
          id: '2',
          name: '星际穿越',
          type: 'Movie',
        },
      ],
    });

    const cached = getCachedHomeData();
    expect(cached?.continueWatching).toHaveLength(1);
    expect(cached?.recentAdditions).toHaveLength(1);
    expect(cached?.recentAdditions?.[0].name).toBe('星际穿越');
  });

  it('reads and writes library items up to 100 entries', () => {
    expect(getCachedLibraryItems(1, 'folder1')).toBeNull();

    const dummyItems = Array.from({ length: 120 }, (_, idx) => ({
      id: `item-${idx}`,
      name: `Movie ${idx}`,
      type: 'Movie',
    }));

    setCachedLibraryItems(1, 'folder1', dummyItems);

    const cached = getCachedLibraryItems(1, 'folder1');
    expect(cached).not.toBeNull();
    expect(cached).toHaveLength(100);
    expect(cached?.[0].name).toBe('Movie 0');
  });

  it('handles invalid json in localStorage gracefully', () => {
    window.localStorage.setItem('qy_cache_home_v1', 'invalid-json{{{');
    expect(getCachedHomeData()).toBeNull();

    window.localStorage.setItem('qy_cache_lib_v1_1_test', 'not-json');
    expect(getCachedLibraryItems(1, 'test')).toBeNull();
  });
});
