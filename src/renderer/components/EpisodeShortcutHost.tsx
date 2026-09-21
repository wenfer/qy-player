import { useEffect } from 'react';
import { useAutoNextStore } from '../stores/auto-next-store';
import { playAdjacentEpisode } from '../utils/play-episode';

/**
 * 全局快捷键切集（QYP3-068q）：主进程收键（Ctrl+Shift+←/→）后只把方向转过来，
 * 真正的"上一集/下一集是谁"要剧集页注册的 provider + 主进程的媒体快照。
 *
 * 没有 provider（不在剧集页）时静默——快捷键是全局的，在别的页面按下去不该
 * 弹错误提示。宿主常驻挂载，与页面无关。
 */
export default function EpisodeShortcutHost() {
  useEffect(() => {
    if (!window.electronAPI?.onAutoNextCommand) return;
    const unsubscribe = window.electronAPI.onAutoNextCommand((direction) => {
      if (!useAutoNextStore.getState().provider) return;
      void playAdjacentEpisode(direction);
    });
    return () => {
      unsubscribe();
    };
  }, []);
  return null;
}
