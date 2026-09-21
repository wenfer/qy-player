import { useEffect, useRef, type ReactNode } from 'react';
import { Activity } from 'lucide-react';
import { useVisualizerFps } from '../../stores/resource-store';
import {
  createBarsPainter,
  createSpectrumDecay,
  type BarsPainter,
  type SpectrumDecay,
} from '../Visualizer/bars-painter';

/**
 * 播放频谱图（QYP3-034 / QYP3-047）：经典风格的弹跳柱状频谱（分段 LED + 峰值帽）。
 *
 * 真实频谱只有 renderer 内置引擎（Web Audio）解码的音轨才有**实时**数据；mpv 引擎
 * （服务器 / WebDAV / CUE / 冷门格式，以及兜底到 mpv 的本地 FLAC）在 mpv 0.32 下
 * 没有暴露实时频谱的 IPC 接口（`audio-fft` 是 0.34+ 才有，升级会破坏老系统兼容）。
 * QYP3-050 起这类音源由主进程用 ffmpeg 离线预算频带矩阵，`getSpectrum()` 按播放
 * 位置返回对应帧——所以门禁改成"有没有数据"，而不是"是不是 webaudio 引擎"。
 * 一点数据都没有时才如实提示，**绝不画假跳动**。
 *
 * QYP3-047 起只有柱状一种（瀑布声谱图已移除），帧率 ≤30fps（老机预算）。
 */

const BARS = 56;
/** 频谱图高得多，16 段 LED 才好看。 */
const SEGMENTS = 16;

interface SpectrumGraphProps {
  engine: 'webaudio' | 'mpv' | null;
  getSpectrum: () => Uint8Array | null;
  isPlaying: boolean;
  title: string;
  artist?: string | null;
  /** 头部右侧额外内容（如精简模式的还原按钮）。 */
  headerExtra?: ReactNode;
}

export default function SpectrumGraph({
  engine,
  getSpectrum,
  isPlaying,
  title,
  artist,
  headerExtra,
}: SpectrumGraphProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // 暂停回落缓存（QYP3-059）：跨 effect 重跑存活（isPlaying 在依赖里）
  const decayRef = useRef<SpectrumDecay | null>(null);
  // 性能保护（QYP3-036）：CPU 紧张时降帧，优先保证播放不卡
  const frameMs = 1000 / Math.max(1, useVisualizerFps(30));
  /**
   * 有真实数据才画（QYP3-050）：webaudio 引擎是实时频谱；mpv 引擎没有实时数据，
   * 但主进程可能已经预算好离线频谱（`getSpectrum()` 会按播放位置返回对应帧）。
   * 都没有时如实显示提示，绝不画假跳动。
   */
  const hasData = engine === 'webaudio' || getSpectrum() !== null;

  useEffect(() => {
    // 有数据就起循环：播放中画实时帧；暂停（QYP3-059）不冻结最后一帧——
    // 喂指数衰减的快照让柱体平滑回落、峰值帽落底，落定后停掉循环不空转
    if (!hasData) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return; // jsdom / 无 2D 上下文：静默跳过

    const decay = (decayRef.current ??= createSpectrumDecay());
    const dpr = Math.min(2, typeof devicePixelRatio === 'number' ? devicePixelRatio : 1);
    const resize = (): void => {
      // 画布填满父容器（flex-1 区域），尺寸跟着窗口走——精简浮窗里剩余
      // 高度全部让给频谱，不再留一条底部空白
      canvas.width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
      canvas.height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
    };
    resize();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
    ro?.observe(canvas);

    let painter: BarsPainter | null = null;
    let raf = 0;
    let last = 0;
    const draw = (now: number): void => {
      raf = requestAnimationFrame(draw);
      if (now - last < frameMs) return; // ≤30fps（性能保护下更低）
      // 先算 dt 再推进 last，否则峰值帽永远不落。钳到 100ms：effect 重跑
      // （暂停/恢复）后 last 从 0 起算，首帧 dt 会是页面运行时长——不钳的话
      // 暂停回落快照会被一帧清空（QYP3-059）
      const dt = Math.min(now - last, 100);
      last = now;
      painter ??= createBarsPainter(ctx, { bars: BARS, segments: SEGMENTS });
      // painter 只画"点亮的 LED 格 + 峰值帽"，不负责清底——不 clearRect 的
      // 话上一帧的柱子残留并与新帧叠加（QYP3-058，精简浮窗里尤其明显）
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const feed = decay.feed(isPlaying ? getSpectrum() : null, isPlaying, dt);
      painter.paint(canvas.width, canvas.height, feed, dt);
      if (!isPlaying && painter.settled()) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
    };

    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      ro?.disconnect();
    };
  }, [hasData, isPlaying, getSpectrum, frameMs]);

  return (
    <div className="flex-1 min-h-0 flex flex-col rounded-xl border border-border bg-card/60 overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border flex-shrink-0">
        <Activity size={14} className="text-muted-foreground flex-shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-xs truncate">
            {title}
            {artist ? <span className="text-muted-foreground"> · {artist}</span> : null}
          </p>
          <p className="text-[10px] text-muted-foreground">频谱图</p>
        </div>
        {headerExtra ? <div className="flex items-center gap-1 flex-shrink-0">{headerExtra}</div> : null}
      </div>

      {hasData ? (
        <div className="flex-1 min-h-0 relative">
          <canvas ref={canvasRef} aria-hidden className="absolute inset-0 w-full h-full block" />
        </div>
      ) : (
        <div className="flex-1 min-h-0 flex items-center justify-center px-4 text-center">
          <p className="text-[11px] text-muted-foreground max-w-md">
            此音源经 mpv 解码，mpv 0.32 没有实时频谱接口，无法显示真实频谱。
            （机器上装了 ffmpeg 的话，系统会在后台为它预算一份，算好前显示这条提示）
          </p>
        </div>
      )}
    </div>
  );
}
