import { useEffect, useState } from 'react';
import { Mic2, Music2, SkipBack, SkipForward, X } from 'lucide-react';
import { useMusicPlaybackStore } from '../../stores/music-playback-store';
import LyricsPanel from '../LyricsPanel';
import Visualizer, { type VisualizerMode } from '../Visualizer';

/**
 * 音乐迷你控制条（QYP3-013）：webaudio 引擎激活时全局常驻（可折叠）。
 * mpv 引擎的音视频控制由全局 PlayerControls 驱动，不在此重复。
 * 歌词面板（QYP3-021）由本条的「词」按钮开合；拾音器（QYP3-023）
 * 按设置模式显示迷你条。
 */

/** 拾音器模式：off=关闭；auto 在 renderer 引擎下按频谱、否则波形。 */
function resolveMode(setting: string, engine: string | null): VisualizerMode | null {
  if (setting === 'off') return null;
  if (setting === 'waveform') return 'waveform';
  if (setting === 'spectrum') return 'spectrum';
  return engine === 'webaudio' ? 'spectrum' : 'waveform';
}

export default function MusicMiniBar() {
  const playback = useMusicPlaybackStore();
  const [collapsed, setCollapsed] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [showLyrics, setShowLyrics] = useState(false);
  const [visualizer, setVisualizer] = useState<string>('auto');

  useEffect(() => {
    // 拾音器设置（QYP3-023）：默认 auto（renderer 引擎→频谱，否则波形）
    void window.electronAPI
      .getSettings('playback.visualizer')
      .then((res) => {
        const value = (res as { data?: unknown })?.data;
        if (typeof value === 'string') setVisualizer(value);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    // 全局媒体键（QYP3-013）：main 侧在音乐激活时转发
    const off = window.electronAPI.onMusicCommand?.((command: string) => {
      if (command === 'toggle') {
        playback.isPlaying ? playback.pause() : playback.resume();
      } else if (command === 'next') {
        void playback.next();
      } else if (command === 'prev') {
        void playback.prev();
      }
    });
    return () => {
      if (typeof off === 'function') off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!mounted || playback.engine !== 'webaudio' || !playback.current) return null;

  const fmt = (sec: number): string => {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  };

  if (collapsed) {
    return (
      <div className="fixed bottom-4 right-4 z-40">
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          className="p-3 rounded-full bg-primary text-primary-foreground shadow-lg hover:bg-primary/90 focus-ring"
          aria-label="展开音乐控制条"
        >
          <Music2 size={18} />
        </button>
      </div>
    );
  }

  return (
    <>
      {showLyrics && playback.current && (
        <LyricsPanel
          trackId={playback.current.id}
          title={playback.current.title}
          position={playback.position}
          onSeek={playback.seek}
          onClose={() => setShowLyrics(false)}
        />
      )}
      <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 w-[min(560px,calc(100vw-2rem))] bg-card/95 backdrop-blur border border-border rounded-xl px-4 py-3 flex flex-col gap-2 shadow-lg">
        {(() => {
          const mode = resolveMode(visualizer, playback.engine);
          return mode ? (
            <Visualizer
              mode={mode}
              getSpectrum={playback.getSpectrum}
              isPlaying={playback.isPlaying}
              position={playback.position}
              duration={playback.duration}
              height={24}
            />
          ) : null;
        })()}
        <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={() => void playback.prev()}
        aria-label="上一曲"
        className="p-1.5 rounded-lg hover:bg-accent text-muted-foreground hover:text-foreground focus-ring"
      >
        <SkipBack size={16} />
      </button>
      {playback.isPlaying ? (
        <button
          type="button"
          onClick={() => playback.pause()}
          aria-label="暂停音乐"
          className="p-2 rounded-full bg-primary text-primary-foreground hover:bg-primary/90 focus-ring"
        >
          <Music2 size={16} className="hidden" />
          <span aria-hidden>⏸</span>
        </button>
      ) : (
        <button
          type="button"
          onClick={() => playback.resume()}
          aria-label="继续播放音乐"
          className="p-2 rounded-full bg-primary text-primary-foreground hover:bg-primary/90 focus-ring"
        >
          <span aria-hidden>▶</span>
        </button>
      )}
      <button
        type="button"
        onClick={() => void playback.next()}
        aria-label="下一曲"
        className="p-1.5 rounded-lg hover:bg-accent text-muted-foreground hover:text-foreground focus-ring"
      >
        <SkipForward size={16} />
      </button>
      <div className="flex-1 min-w-0">
        <p className="text-xs truncate">{playback.current.title}</p>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-muted-foreground">{fmt(playback.position)}</span>
          <div className="flex-1 h-1 bg-muted rounded-full overflow-hidden">
            <div
              className="h-full bg-primary rounded-full transition-all"
              style={{ width: `${Math.min(100, playback.duration > 0 ? (playback.position / playback.duration) * 100 : 0)}%` }}
            />
          </div>
          <span className="text-[10px] text-muted-foreground">{fmt(playback.duration)}</span>
        </div>
      </div>
      <button
        type="button"
        onClick={() => setShowLyrics((v) => !v)}
        aria-label="歌词"
        aria-pressed={showLyrics}
        className={`p-1.5 rounded-lg hover:bg-accent focus-ring ${
          showLyrics ? 'text-primary' : 'text-muted-foreground hover:text-foreground'
        }`}
      >
        <Mic2 size={16} />
      </button>
      <button
        type="button"
        onClick={() => {
          playback.pause();
          setCollapsed(true);
        }}
        aria-label="收起音乐控制条"
        className="p-1.5 rounded-lg hover:bg-accent text-muted-foreground hover:text-foreground focus-ring"
      >
        <X size={14} />
      </button>
        </div>
    </div>
    </>
  );
}
