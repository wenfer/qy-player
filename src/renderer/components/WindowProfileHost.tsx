import { useEffect } from 'react';
import { useAppModeStore } from '../stores/app-mode-store';
import { useCompactModeStore } from '../stores/compact-mode-store';

/**
 * 窗口 profile 回填（QYP3-044 修复）：renderer reload（dev 热重载）时主进程的
 * 窗口几何不会重置——窗口还是浮窗/竖屏尺寸，但渲染层的 store 全归零，于是小
 * 窗口里画出完整影视界面。几何的主进程才是权威，启动时回来问一次。
 *
 * QYP3-051：主进程启动时已经按 `window.memory` 把窗口开成记忆里的形态，这里
 * 回填的 `compact` / `music` 就是那个形态（冷启动恢复浮窗也走这条路）。
 * 两种模式都不再需要额外抑制：主进程 `setMusicMode`/`setCompactMode` 对
 * "形态没变"是幂等的，重复下发不会挪窗。
 */
export default function WindowProfileHost() {
  useEffect(() => {
    let cancelled = false;
    void Promise.resolve(window.electronAPI?.getWindowProfile?.())
      .then((res) => {
        const data = (res as { data?: { compact?: boolean; music?: boolean } } | undefined)?.data;
        if (cancelled || !data) return;
        if (data.music) useAppModeStore.getState().setMode('music');
        if (data.compact) useCompactModeStore.getState().setCompact(true);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  return null;
}
