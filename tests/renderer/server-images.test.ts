import { describe, expect, it } from 'vitest';
import {
  buildImageUrl,
  buildItemImageUrl,
  resolveItemPrimaryImage,
  resolveItemThumbImage,
  type ServerEntry,
  type ServerMediaItemLike,
} from '../../src/renderer/utils/server-images';

describe('server-images utils', () => {
  const embyServer: ServerEntry = {
    id: 2,
    name: 'Emby Server',
    type: 'emby',
    base_url: 'https://emby.example.com',
    is_active: 1,
  };

  const jellyfinServer: ServerEntry = {
    id: 1,
    name: 'Jellyfin Server',
    type: 'jellyfin',
    base_url: 'http://localhost:8096',
    is_active: 1,
  };

  const serverMap = new Map<number, ServerEntry>([
    [1, jellyfinServer],
    [2, embyServer],
  ]);

  describe('resolveItemPrimaryImage', () => {
    it('resolves item with direct ImageTags.Primary', () => {
      const item: ServerMediaItemLike = {
        Id: '1001',
        ImageTags: { Primary: 'tag-1001' },
      };
      expect(resolveItemPrimaryImage(item)).toEqual({
        itemId: '1001',
        tag: 'tag-1001',
      });
    });

    it('resolves Emby inherited artwork when ImageTags is empty but PrimaryImageItemId is provided', () => {
      const embyFolder: ServerMediaItemLike = {
        Id: '838285',
        ImageTags: {},
        PrimaryImageItemId: '845167',
        PrimaryImageTag: 'e63f72cf2f45ffec08b0e091965f231f',
      };
      expect(resolveItemPrimaryImage(embyFolder)).toEqual({
        itemId: '845167',
        tag: 'e63f72cf2f45ffec08b0e091965f231f',
      });
    });

    it('resolves item with PrimaryImageTag when PrimaryImageItemId is omitted', () => {
      const item: ServerMediaItemLike = {
        Id: '2002',
        PrimaryImageTag: 'tag-2002',
      };
      expect(resolveItemPrimaryImage(item)).toEqual({
        itemId: '2002',
        tag: 'tag-2002',
      });
    });

    it('returns undefined when item has no primary image (avoids 404s)', () => {
      const item: ServerMediaItemLike = {
        Id: '3003',
        ImageTags: {},
      };
      expect(resolveItemPrimaryImage(item)).toBeUndefined();
    });

    it('handles undefined or null gracefully', () => {
      expect(resolveItemPrimaryImage(undefined)).toBeUndefined();
      expect(resolveItemPrimaryImage(null)).toBeUndefined();
    });
  });

  describe('resolveItemThumbImage', () => {
    it('resolves item with ImageTags.Thumb', () => {
      const item: ServerMediaItemLike = {
        Id: '4001',
        ImageTags: { Thumb: 'thumb-4001' },
      };
      expect(resolveItemThumbImage(item)).toEqual({
        itemId: '4001',
        tag: 'thumb-4001',
      });
    });

    it('resolves item with ParentThumbItemId and ParentThumbImageTag', () => {
      const item: ServerMediaItemLike = {
        Id: '4002',
        ParentThumbItemId: 'parent-4000',
        ParentThumbImageTag: 'parent-tag',
      };
      expect(resolveItemThumbImage(item)).toEqual({
        itemId: 'parent-4000',
        tag: 'parent-tag',
      });
    });

    it('returns undefined when no thumb is present', () => {
      const item: ServerMediaItemLike = {
        Id: '4003',
      };
      expect(resolveItemThumbImage(item)).toBeUndefined();
    });
  });

  describe('buildImageUrl', () => {
    it('builds raw Jellyfin image URL when useCache is false', () => {
      const url = buildImageUrl(serverMap, 1, 'jellyfin', '1001', 'Primary', 'tag1', 500, false);
      expect(url).toBe('http://localhost:8096/Items/1001/Images/Primary?maxHeight=500&quality=90&tag=tag1');
    });

    it('builds raw Emby image URL with /emby prefix when useCache is false', () => {
      const url = buildImageUrl(serverMap, 2, 'emby', '845167', 'Primary', 'etag1', 500, false);
      expect(url).toBe('https://emby.example.com/emby/Items/845167/Images/Primary?maxHeight=500&quality=90&tag=etag1');
    });

    it('routes through qy-file://image-cache by default with remoteUrl encoded in query', () => {
      const url = buildImageUrl(serverMap, 2, 'emby', '845167', 'Primary', 'etag1', 500);
      expect(url).toBe(
        'qy-file://image-cache/s2-845167-Primary-etag1-500.jpg?src=https%3A%2F%2Femby.example.com%2Femby%2FItems%2F845167%2FImages%2FPrimary%3FmaxHeight%3D500%26quality%3D90%26tag%3Detag1'
      );
    });

    it('omits &tag parameter when tag is undefined', () => {
      const url = buildImageUrl(serverMap, 2, 'emby', '845167', 'Primary', undefined, 200, false);
      expect(url).toBe('https://emby.example.com/emby/Items/845167/Images/Primary?maxHeight=200&quality=90');
    });

    it('returns undefined if server is not in serverMap', () => {
      const url = buildImageUrl(serverMap, 999, 'jellyfin', '1001');
      expect(url).toBeUndefined();
    });
  });

  describe('buildItemImageUrl', () => {
    it('builds correct URL for Emby item with inherited artwork from child item', () => {
      const embyFolder: ServerMediaItemLike = {
        Id: '838285',
        PrimaryImageItemId: '845167',
        PrimaryImageTag: 'e63f72cf',
      };
      const url = buildItemImageUrl(serverMap, 2, 'emby', embyFolder, 'Primary', 500, false);
      expect(url).toBe('https://emby.example.com/emby/Items/845167/Images/Primary?maxHeight=500&quality=90&tag=e63f72cf');
    });

    it('returns undefined when item has no image tags or inherited image (preventing 404 network errors)', () => {
      const emptyItem: ServerMediaItemLike = {
        Id: '9999',
        ImageTags: {},
      };
      const url = buildItemImageUrl(serverMap, 2, 'emby', emptyItem, 'Primary', 500);
      expect(url).toBeUndefined();
    });
  });
});
