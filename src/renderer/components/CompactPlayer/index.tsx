import { useState } from 'react';
import { Gauge, Mic2, Pause, Play, SkipBack, SkipForward, Volume2 } from 'lucide-react';
import { useMusicPlaybackStore } from '../../stores/music-playback-store';
import { useResourceStore } from '../../stores/resource-store';
import { pressureLabel } from '../../../shared/resource-pressure';
import SpectrumGraph from '../SpectrumGraph';
import PlayModeButton from '../PlayModeButton';
import LyricsPanel from '../LyricsPanel';

/**
 * 精简模式浮窗界面（QYP3-035）：主窗口缩成右上角小浮窗时渲染。
 *
 * 与主界面**同一个 renderer**，所以播放状态与频谱直接读 `useMusicPlaybackStore`
 * （`getSpectrum` 就是同一个 WebAudioEngine），零跨进程同步。
 * 控件：频谱图 / 进度 / 上一曲 / 暂停 / 下一曲 / 播放模式 / 歌词 / 音量。
 *
 * QYP3-068t：①浮窗里**只留标题栏那一个**「还原窗口」——频谱卡片头部原来还有个
 * 同功能按钮（就在歌名右边），两个入口纯属重复；②循环与随机合并成**一个**
 * 播放模式按钮（顺序 → 列表循环 → 单曲循环 → 随机），控制行少一个键。
 */

function fmt(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

const BTN =
  'p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent focus-ring flex-shrink-0';

export default function CompactPlayer() {
  const playback = useMusicPlaybackStore();
  const pressure = useResourceStore((s) => s.pressure);
  const powerSave = useResourceStore((s) => s.powerSave);
  // 拖动进度时先本地跟手，松手才真正 seek（避免 mpv 引擎被连续 seek 刷屏）
  const [dragPos, setDragPos] = useState<number | null>(null);
  // 歌词浮层（QYP3-058）：浮窗里也看歌词，整幅盖在播放器上
  const [showLyrics, setShowLyrics] = useState(false);

  const duration = playback.duration;
  const displayPos = dragPos ?? playback.position;

  const commitSeek = (): void => {
    if (dragPos !== null) {
      playback.seek(dragPos);
      setDragPos(null);
    }
  };

  return (
    <div className="h-full w-full flex flex-col gap-2 p-3 bg-background text-foreground overflow-hidden">
      {showLyrics && playback.current && playback.currentSource && (
        <LyricsPanel
          placement="overlay"
          source={playback.currentSource}
          title={playback.current.title}
          position={playback.position}
          onSeek={playback.seek}
          onClose={() => setShowLyrics(false)}
        />
      )}
      <SpectrumGraph
        engine={playback.engine}
        getSpectrum={playback.getSpectrum}
        isPlaying={playback.isPlaying}
        title={playback.current?.title ?? '未在播放'}
        artist={playback.current?.artist ?? null}
      />

      {/* 进度 */}
      <div className="flex items-center gap-2">
        <span className="text-[10px] text-muted-foreground tabular-nums w-9 text-right">
          {fmt(displayPos)}
        </span>
        <input
          type="range"
          min={0}
          max={Math.max(1, Math.floor(duration))}
          value={Math.floor(displayPos)}
          onChange={(e) => setDragPos(Number(e.target.value))}
          onMouseUp={commitSeek}
          onTouchEnd={commitSeek}
          onKeyUp={commitSeek}
          aria-label="播放进度"
          className="flex-1 accent-primary"
        />
        <span className="text-[10px] text-muted-foreground tabular-nums w-9">{fmt(duration)}</span>
      </div>

      {/* 传输控制 */}
      <div className="flex items-center gap-1.5">
        <button type="button" onClick={() => void playback.prev()} aria-label="上一曲" className={BTN}>
          <SkipBack size={16} />
        </button>
        <button
          type="button"
          // 恢复态（QYP3-053，浮窗跨重启恢复）：engine 还是 null，没有引擎可
          // resume，点播放要从上次位置真正起播，否则浮窗里点了没反应
          onClick={() => {
            if (playback.isPlaying) playback.pause();
            else if (playback.engine) playback.resume();
            else void playback.resumeRestored();
          }}
          aria-label={playback.isPlaying ? '暂停' : '播放'}
          className="p-2 rounded-full bg-primary text-primary-foreground hover:bg-primary/90 focus-ring flex-shrink-0"
        >
          {playback.isPlaying ? <Pause size={16} /> : <Play size={16} />}
        </button>
        <button type="button" onClick={() => void playback.next()} aria-label="下一曲" className={BTN}>
          <SkipForward size={16} />
        </button>
        <PlayModeButton className={BTN} size={15} />
        <button
          type="button"
          onClick={() => setShowLyrics((v) => !v)}
          aria-label="歌词"
          aria-pressed={showLyrics}
          className={`${BTN} ${showLyrics ? 'text-primary' : ''}`}
        >
          <Mic2 size={15} />
        </button>
        <button
          type="button"
          onClick={() => void useResourceStore.getState().setPowerSave(!powerSave)}
          aria-label="性能保护"
          aria-pressed={powerSave}
          title={
            powerSave
              ? `性能保护：开·${pressureLabel(pressure)}`
              : '性能保护：关（CPU 紧张时不会自动降低频谱刷新）'
          }
          className={`${BTN} ml-auto ${powerSave ? 'text-primary' : ''}`}
        >
          <Gauge size={15} />
        </button>
        <Volume2 size={14} className="text-muted-foreground flex-shrink-0" />
        <input
          type="range"
          min={0}
          max={100}
          value={playback.volume}
          onChange={(e) => playback.setVolume(Number(e.target.value))}
          aria-label="音量"
          className="w-20 flex-shrink-0 accent-primary"
        />
      </div>
    </div>
  );
}
