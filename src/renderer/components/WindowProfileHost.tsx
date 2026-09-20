import { useEffect } from 'react';
import { useAppModeStore } from '../stores/app-mode-store';
import { useCompactModeStore } from '../stores/compact-mode-store';

/**
 * 窗口 profile 回填（QYP3-044 修复）：renderer reload（dev 热重载）时主进程的
 * 窗口几何不会重置——窗口还是浮窗/竖屏尺寸，但渲染层的 store 全归零，于是小
 * 窗口里画出完整影视界面。几何的主进程才是权威，启动时回来问一次。
 *
 * 注意：模式本身仍不持久化（退出应用再开还是影视模式），只有"当前这个窗口
 * 正在用哪种几何"被回填。
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
