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
 *
 * QYP3-056：恢复**只由挂载驱动**。react-router v6 的 `useNavigate` 在
 * location 变化后返回新函数——若把它放进依赖，恢复导航本身就会触发 effect
 * 重跑 → 又 navigate 回 `/music` → 无限循环，用户表现为"菜单点不动"（任何
 * 路由跳转都在几毫秒内被弹回音乐页）。navigate 经 ref 在挂载时捕获一次，
 * effect 用空依赖。**不要**加"只跑一次"哨兵：StrictMode（dev）会挂载两次
 * ——第一次被 cleanup 取消、第二次被哨兵挡住，恢复就整个失效了；这里的
 * 两个动作（setMode / navigate replace）天然幂等，重复执行无害。
 */
export default function WindowProfileHost() {
  // 首次渲染时的路由：只在冷启动（`/`）上补跳，之后的变化不参与判断
  const initialPathRef = useRef(useLocation().pathname);
  const navigateRef = useRef(useNavigate());

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve(window.electronAPI?.getWindowProfile?.())
      .then((res) => {
        const data = (res as { data?: { compact?: boolean; music?: boolean } } | undefined)?.data;
        if (cancelled || !data) return;
        if (data.music) {
          useAppModeStore.getState().setMode('music');
          if (initialPathRef.current === MODE_HOME.video) {
            navigateRef.current(MODE_HOME.music, { replace: true });
          }
        }
        if (data.compact) useCompactModeStore.getState().setCompact(true);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // 挂载时恢复一次；navigate 经 ref 捕获，见上方 QYP3-056 说明
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}
