import { useCallback } from 'react';
import { useToastStore } from '../stores/toast-store';
import type { MediaItem } from '../components/HorizontalRow';

export function usePlayItem() {
  const addToast = useToastStore((s) => s.addToast);

  const playItem = useCallback(async (item: MediaItem) => {
    try {
      const details = await window.electronAPI.getItemDetails(item.id);
      const detailsRecord = details as Record<string, unknown> | null;
      if (!detailsRecord) {
        addToast('获取媒体详情失败，请稍后重试', 'error');
        return;
      }
      let mediaSource = (
        detailsRecord.MediaSources as Array<Record<string, unknown>> | undefined
      )?.[0];
      let playId = item.id;

      // Container items (Series/Season/Folder) have no direct MediaSources -
      // resolve a playable child (first episode, or first playable file).
      if (!mediaSource && (item.type === 'Series' || item.type === 'Season')) {
        const eps = (await window.electronAPI.getItems(item.id, {
          includeItemTypes: 'Episode',
          recursive: true,
          sortBy: 'ParentIndexNumber,IndexNumber',
          sortOrder: 'Ascending',
          limit: 1,
        })) as Array<Record<string, unknown>>;
        const first = eps[0];
        const epMs = first?.MediaSources as Array<Record<string, unknown>> | undefined;
        if (first && epMs?.[0]) {
          playId = first.Id as string;
          mediaSource = epMs[0];
        }
      }
      if (!mediaSource) {
        // Generic container fallback (e.g. Folder wrapping one movie)
        const children = (await window.electronAPI.getItems(item.id, {
          recursive: true,
          sortBy: 'SortName',
          limit: 20,
        })) as Array<Record<string, unknown>>;
        const playable = children.find(
          (it) => ((it.MediaSources as Array<Record<string, unknown>> | undefined)?.length ?? 0) > 0
        );
        const playMs = playable?.MediaSources as Array<Record<string, unknown>> | undefined;
        if (playable && playMs?.[0]) {
          playId = playable.Id as string;
          mediaSource = playMs[0];
        }
      }

      if (!mediaSource) {
        addToast('无可用的媒体源', 'error');
        return;
      }

      const stream = (await window.electronAPI.getStreamUrl(
        playId,
        mediaSource.Id as string,
        'direct'
      )) as { url: string; headers?: string } | null;
      if (stream?.url) {
        await window.electronAPI.playerLoadFile(stream.url, undefined, stream.headers, {
          mediaType: item.serverType || 'jellyfin',
          mediaId: playId,
          title: (detailsRecord?.Name as string) || item.name,
          seriesName: detailsRecord?.SeriesName as string | undefined,
          seasonNumber: detailsRecord?.ParentIndexNumber as number | undefined,
          episodeNumber: detailsRecord?.IndexNumber as number | undefined,
          mediaSourceId: mediaSource.Id as string,
        });
        addToast(`开始播放: ${item.name}`, 'success');
      } else {
        addToast('无法获取播放地址（服务器未响应），请稍后重试', 'error');
      }
    } catch (err) {
      addToast(`播放失败: ${err instanceof Error ? err.message : '未知错误'}`, 'error');
    }
  }, [addToast]);

  return playItem;
}
