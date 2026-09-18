import { useEffect, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { Minus, Maximize2, Minimize2, X } from 'lucide-react';
import { useCompactModeStore } from '../../stores/compact-mode-store';

/**
 * 自绘标题栏（QYP3-042）：窗口改成无边框后，拖动/最小化/最大化/关闭都得自己来。
 *
 * - 整条用 `-webkit-app-region: drag` 交给 Chromium 处理拖动；按钮区标
 *   `no-drag`，否则点击会被拖动手势吃掉。Electron 不会自动处理"双击标题栏
 *   最大化"（那是系统标题栏的行为），这里显式接一个 dblclick。
 * - 最大化状态由主进程推送（`WINDOW.ON_MAXIMIZE_CHANGE`）——WM 快捷键也能
 *   触发最大化，渲染层自己记状态会不同步。
 * - 关闭按钮即退出应用（关闭主窗口 = 退出，见 AGENTS.md 硬性约束 5）。
 */

const DRAG = { WebkitAppRegion: 'drag' } as CSSProperties;
const NO_DRAG = { WebkitAppRegion: 'no-drag' } as CSSProperties;

export const TITLE_BAR_HEIGHT = 36;
export const COMPACT_TITLE_BAR_HEIGHT = 28;

// 右上角按钮：40×36 的点击区（比图标本身大得多，老机触摸板也好点）
const BTN =
  'h-full w-10 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent transition-colors focus-ring';
const BTN_SMALL =
  'h-full w-8 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent transition-colors focus-ring';
const CLOSE_BTN =
  'h-full w-10 flex items-center justify-center text-muted-foreground hover:text-white hover:bg-red-500 transition-colors focus-ring';
const CLOSE_BTN_SMALL =
  'h-full w-8 flex items-center justify-center text-muted-foreground hover:text-white hover:bg-red-500 transition-colors focus-ring';

export default function TitleBar({ compact = false }: { compact?: boolean }) {
  const [maximized, setMaximized] = useState(false);
  const exitCompact = useCompactModeStore((s) => s.exit);

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve(window.electronAPI.isWindowMaximized())
      .then((res) => {
        const value = (res as { data?: unknown } | undefined)?.data;
        if (!cancelled) setMaximized(value === true);
      })
      .catch(() => undefined);
    const unsubscribe = window.electronAPI.onWindowMaximizeChange(setMaximized);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const height = compact ? COMPACT_TITLE_BAR_HEIGHT : TITLE_BAR_HEIGHT;

  return (
    <div
      className="flex-none flex items-stretch justify-between bg-card border-b border-border select-none"
      style={{ ...DRAG, height }}
      data-testid="title-bar"
    >
      <div
        className="flex items-center gap-2 px-3 min-w-0 flex-1"
        onDoubleClick={() => {
          if (!compact) void window.electronAPI.toggleMaximizeWindow();
        }}
      >
        <div className="w-4 h-4 rounded bg-primary flex items-center justify-center flex-shrink-0">
          <span className="text-primary-foreground font-bold text-[9px] leading-none">Q</span>
        </div>
        <span className={`font-medium truncate ${compact ? 'text-[11px]' : 'text-xs'} text-muted-foreground`}>
          QY Player
        </span>
      </div>
      <div className="flex items-stretch" style={NO_DRAG}>
        {compact ? (
          <button type="button" className={BTN_SMALL} onClick={exitCompact} aria-label="还原窗口" title="还原窗口">
            <Maximize2 size={13} />
          </button>
        ) : (
          <button
            type="button"
            className={BTN}
            onClick={() => void window.electronAPI.toggleMaximizeWindow()}
            aria-label={maximized ? '还原' : '最大化'}
            title={maximized ? '还原' : '最大化'}
          >
            {maximized ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          </button>
        )}
        <button
          type="button"
          className={compact ? BTN_SMALL : BTN}
          onClick={() => void window.electronAPI.minimizeWindow()}
          aria-label="最小化"
          title="最小化"
        >
          <Minus size={compact ? 13 : 16} />
        </button>
        <button
          type="button"
          className={compact ? CLOSE_BTN_SMALL : CLOSE_BTN}
          onClick={() => void window.electronAPI.closeWindow()}
          aria-label="关闭"
          title="关闭"
        >
          <X size={compact ? 13 : 16} />
        </button>
      </div>
    </div>
  );
}

/** 自绘缩放热区的边/角（QYP3-042）；与 main/ipc 的 RESIZE_EDGES 白名单一致。 */
export type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

const EDGE_CLASS: Record<ResizeEdge, string> = {
  n: 'top-0 left-2 right-2 h-1.5 cursor-ns-resize',
  s: 'bottom-0 left-2 right-2 h-1.5 cursor-ns-resize',
  w: 'left-0 top-2 bottom-2 w-1.5 cursor-ew-resize',
  e: 'right-0 top-2 bottom-2 w-1.5 cursor-ew-resize',
  ne: 'top-0 right-0 w-3 h-3 cursor-nesw-resize',
  nw: 'top-0 left-0 w-3 h-3 cursor-nwse-resize',
  se: 'bottom-0 right-0 w-3 h-3 cursor-nwse-resize',
  sw: 'bottom-0 left-0 w-3 h-3 cursor-nesw-resize',
};

const EDGES = Object.keys(EDGE_CLASS) as ResizeEdge[];

/**
 * 无边框窗口的缩放热区（QYP3-042）：Linux 的无边框窗口没有系统边框可拖，
 * 这里贴 8 个透明热区，按住后把**鼠标位移增量**发给主进程改 bounds
 * （渲染层拿不到窗口在屏幕上的位置，只报增量才不会漂）。
 */
export function WindowResizeHandles() {
  const start = (edge: ResizeEdge) => (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    // jsdom 没有 setPointerCapture；真机上捕获后鼠标移出热区也继续收到 move
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const move = (e: PointerEvent): void => {
      void window.electronAPI.resizeWindowBy(edge, e.movementX, e.movementY);
    };
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // 容器从标题栏下沿开始：右上角热区不能压住关闭按钮
  return (
    <div
      className="pointer-events-none fixed bottom-0 left-0 right-0 z-50"
      style={{ top: TITLE_BAR_HEIGHT }}
      aria-hidden="true"
    >
      {EDGES.map((edge) => (
        <div
          key={edge}
          className={`pointer-events-auto absolute ${EDGE_CLASS[edge]}`}
          data-testid={`resize-${edge}`}
          onPointerDown={start(edge)}
        />
      ))}
    </div>
  );
}
