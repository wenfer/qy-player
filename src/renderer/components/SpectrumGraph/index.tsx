import { useEffect, useRef, type ReactNode } from 'react';
import { Activity } from 'lucide-react';
import { useVisualizerFps } from '../../stores/resource-store';
import { createBarsPainter, type BarsPainter } from '../Visualizer/bars-painter';

/**
 * 播放频谱图（QYP3-034 / QYP3-047）：经典风格的弹跳柱状频谱（分段 LED + 峰值帽）。
 *
 * 真实频谱只有 renderer 内置引擎（Web Audio）解码的音轨才有；mpv 引擎
 * （服务器 / WebDAV / CUE / 冷门格式，以及兜底到 mpv 的本地 FLAC）在 mpv 0.32
 * 下没有暴露实时频谱的 IPC 接口（`audio-fft` 是 0.34+ 才有，升级会破坏老系统
 * 兼容）→ 面板如实提示"无法显示真实频谱"，**绝不画假跳动**。
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
  height?: number;
  /** 头部右侧额外内容（如精简模式的还原按钮）。 */
  headerExtra?: ReactNode;
}

export default function SpectrumGraph({
  engine,
  getSpectrum,
  isPlaying,
  title,
  artist,
  height = 168,
  headerExtra,
}: SpectrumGraphProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // 性能保护（QYP3-036）：CPU 紧张时降帧，优先保证播放不卡
  const frameMs = 1000 / Math.max(1, useVisualizerFps(30));

  useEffect(() => {
    // mpv 无真实频谱：不画（面板显示提示）；暂停时冻结上一帧
    if (engine !== 'webaudio' || !isPlaying) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return; // jsdom / 无 2D 上下文：静默跳过

    const dpr = Math.min(2, typeof devicePixelRatio === 'number' ? devicePixelRatio : 1);
    const resize = (): void => {
      canvas.width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
      canvas.height = Math.max(1, Math.floor(height * dpr));
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
      painter ??= createBarsPainter(ctx, { bars: BARS, segments: SEGMENTS });
      painter.paint(canvas.width, canvas.height, getSpectrum(), now - last);
      last = now;
    };

    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      ro?.disconnect();
    };
  }, [engine, isPlaying, getSpectrum, height, frameMs]);

  return (
    <div className="mb-6 rounded-xl border border-border bg-card/60 overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border">
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

      {engine === 'webaudio' ? (
        <canvas ref={canvasRef} aria-hidden className="w-full block" style={{ height }} />
      ) : (
        <div className="flex items-center justify-center px-4 text-center" style={{ height }}>
          <p className="text-[11px] text-muted-foreground max-w-md">
            此音源经 mpv 解码，mpv 0.32 没有实时频谱接口，无法显示真实频谱。
          </p>
        </div>
      )}
    </div>
  );
}
