import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { MODE_HOME, useAppModeStore } from '../stores/app-mode-store';
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
 *
 * QYP3-054：**模式恢复要连默认页一起恢复**。只回填 store 的话，竖屏窗口停在
 * 影视首页上（侧栏已是音乐那套、内容却是影视），看起来就像"只记住了一半"。
 * 冷启动的路由必然是 `/`，所以只在初始路由是该模式的"另一个模式首页"时才跳；
 * 热重载保留了深链（如 `#/settings`）时不抢用户的页面。
 */
export default function WindowProfileHost() {
  const navigate = useNavigate();
  // 首次渲染时的路由：只在冷启动（`/`）上补跳，之后的变化不参与判断
  const initialPathRef = useRef(useLocation().pathname);

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve(window.electronAPI?.getWindowProfile?.())
      .then((res) => {
        const data = (res as { data?: { compact?: boolean; music?: boolean } } | undefined)?.data;
        if (cancelled || !data) return;
        if (data.music) {
          useAppModeStore.getState().setMode('music');
          if (initialPathRef.current === MODE_HOME.video) {
            navigate(MODE_HOME.music, { replace: true });
          }
        }
        if (data.compact) useCompactModeStore.getState().setCompact(true);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [navigate]);
  return null;
}
