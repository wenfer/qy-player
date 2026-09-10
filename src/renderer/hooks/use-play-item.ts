import { useCallback } from 'react';
import { useToastStore } from '../stores/toast-store';
import type { MediaItem } from '../components/HorizontalRow';

interface ResolveResult {
  ok: boolean;
  data?: {
    url: string;
    streamSessionId?: string;
    startPosition: number;
    mediaContext: {
      mediaType: string;
      mediaId: string;
      title?: string;
      seriesName?: string;
      seasonNumber?: number;
      episodeNumber?: number;
      mediaSourceId?: string;
    };
  };
  error?: { code: string; message: string };
}

/**
 * Play-action hook (QYP2-015): the renderer builds only a MediaRef and
 * hands playback resolution to the main process. URLs are never spliced
 * here, credentials never appear, and online routing is strict per serverId.
 */
export function usePlayItem() {
  const addToast = useToastStore((s) => s.addToast);

  const playItem = useCallback(async (item: MediaItem, mode: 'direct' | 'transcode' = 'direct') => {
    try {
      let result: ResolveResult;
      if (item.catalogRef) {
        result = (await window.electronAPI.resolvePlayback(item.catalogRef, { mode })) as ResolveResult;
      } else if (item.serverType === 'jellyfin' || item.serverType === 'emby') {
        if (typeof item.serverId !== 'number') {
          addToast('无法确定媒体来源的服务器', 'error');
          return;
        }
        result = (await window.electronAPI.resolvePlayback(
          { provider: item.serverType, serverId: item.serverId, itemId: item.id },
          { mode }
        )) as ResolveResult;
      } else {
        addToast('未知媒体类型，无法播放', 'error');
        return;
      }
      if (!result.ok || !result.data) {
        addToast(result.error?.message ?? '无法获取播放地址，请稍后重试', 'error');
        return;
      }
      const resolved = result.data;
      await window.electronAPI.playerLoadFile(
        resolved.url,
        resolved.startPosition > 0 ? resolved.startPosition : undefined,
        undefined,
        resolved.mediaContext,
        resolved.streamSessionId
      );
      addToast(
        mode === 'transcode' ? `开始播放（转码）: ${item.name}` : `开始播放: ${item.name}`,
        'success'
      );
    } catch (err) {
      addToast(`播放失败: ${err instanceof Error ? err.message : '未知错误'}`, 'error');
    }
  }, [addToast]);

  return playItem;
}
