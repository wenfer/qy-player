import { useAutoNextStore, type EpisodeDirection, type NextEpisodeChoice } from '../stores/auto-next-store';
import { useToastStore } from '../stores/toast-store';

/**
 * 剧集切换（QYP3-068q）：自动连播、播放条的上一集/下一集按钮、全局快捷键
 * 三条路都走这里——解析地址 + loadfile 的逻辑只有一份，报错文案也一致。
 *
 * 「下一集是谁」由 Detail 页注册的 provider 回答（它手上有整部戏的剧集列表，
 * 排序交给主进程的纯函数）；provider 没注册（不在剧集页）就什么都不做——
 * 那时按钮本来就是禁用的，快捷键也应该是无操作而不是报错。
 */

/** 播一集：provider 给的选集结果 → resolvePlayback → loadFile（从 0 开始）。 */
export async function playEpisodeChoice(choice: NextEpisodeChoice): Promise<void> {
  const addToast = useToastStore.getState().addToast;
  try {
    if (!choice.provider || typeof choice.serverId !== 'number') {
      addToast('无法确定本集的媒体来源', 'error');
      return;
    }
    const result = (await window.electronAPI.resolvePlayback(
      { provider: choice.provider, serverId: choice.serverId, itemId: String(choice.itemId) },
      { mode: 'direct', ...(choice.mediaSourceId ? { mediaSourceId: choice.mediaSourceId } : {}) }
    )) as {
      ok: boolean;
      data?: { url: string; streamSessionId?: string; mediaContext: unknown };
      error?: { message: string };
    };
    if (!result.ok || !result.data) {
      addToast(result.error?.message ?? '无法获取本集播放地址', 'error');
      return;
    }
    // 换集从 0 开始（§12.2）：显式传 0，LOAD_FILE 靠它区分"从头播"与"未指定"
    await window.electronAPI.playerLoadFile(
      result.data.url,
      0,
      undefined,
      result.data.mediaContext as import('../../shared/types/catalog').ResolvedMediaContext,
      result.data.streamSessionId
    );
  } catch (err) {
    addToast(err instanceof Error ? err.message : '切换剧集失败', 'error');
  }
}

/**
 * 手动切集（direction 为 next 或 prev）：读当前媒体快照 → 问 provider →
 * 播下一集/上一集。返回是否真的切了（快捷键路径不需要，按钮路径也不需要，
 * 但测试用它断言"无 provider 时不动作"）。
 */
export async function playAdjacentEpisode(direction: EpisodeDirection): Promise<boolean> {
  const provider = useAutoNextStore.getState().provider;
  if (!provider) return false;
  const addToast = useToastStore.getState().addToast;

  let mediaId = '';
  let seasonNumber: number | null = null;
  let episodeNumber: number | null = null;
  try {
    const res = (await window.electronAPI.getMediaContext?.()) as
      | { ok?: boolean; data?: { mediaId?: string; seasonNumber?: number | null; episodeNumber?: number | null } | null }
      | undefined;
    const snapshot = res?.data;
    if (!snapshot?.mediaId) {
      addToast('当前没有正在播放的剧集', 'error');
      return false;
    }
    mediaId = snapshot.mediaId;
    seasonNumber = snapshot.seasonNumber ?? null;
    episodeNumber = snapshot.episodeNumber ?? null;
  } catch {
    addToast('无法获取当前播放信息', 'error');
    return false;
  }

  const choice = await provider(
    { mediaType: 'episode', mediaId, seasonNumber, episodeNumber },
    direction
  );
  if (!choice) {
    addToast(direction === 'next' ? '已经是最后一集' : '已经是第一集', 'info');
    return false;
  }
  await playEpisodeChoice(choice);
  return true;
}
