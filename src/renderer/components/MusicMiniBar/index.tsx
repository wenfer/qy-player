import { useCallback, useEffect, useRef, useState } from 'react';
import { Heart, Mic2, Music2, SkipBack, SkipForward, X } from 'lucide-react';
import { useMusicPlaybackStore } from '../../stores/music-playback-store';
import { useToastStore } from '../../stores/toast-store';
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
  // 收藏集合（QYP3-013a）：全局收藏快捷键与迷你条共用同一份状态
  const [favoriteIds, setFavoriteIds] = useState<Set<number>>(new Set());
  const addToast = useToastStore((s) => s.addToast);

  const loadFavorites = useCallback(async (): Promise<void> => {
    try {
      const res = (await window.electronAPI.getMusicFavorites(200)) as {
        ok?: boolean;
        data?: { tracks?: Array<{ id: number }> };
      };
      setFavoriteIds(new Set((res?.data?.tracks ?? []).map((t) => t.id)));
    } catch {
      // 收藏状态读不到不影响播放
    }
  }, []);

  /** 切换当前曲目收藏（快捷键 / 迷你条按钮共用）。 */
  const toggleFavorite = useCallback(
    async (trackId: number): Promise<void> => {
      const next = !favoriteIds.has(trackId);
      setFavoriteIds((prev) => {
        const copy = new Set(prev);
        if (next) copy.add(trackId);
        else copy.delete(trackId);
        return copy;
      });
      try {
        const res = (await window.electronAPI.setMusicFavorite(trackId, next)) as { ok?: boolean };
        if (res?.ok === false) throw new Error('failed');
        addToast(next ? '已收藏' : '已取消收藏', 'success');
      } catch {
        setFavoriteIds((prev) => {
          const copy = new Set(prev);
          if (next) copy.delete(trackId);
          else copy.add(trackId);
          return copy;
        });
        addToast('收藏失败，请重试', 'error');
      }
    },
    [favoriteIds, addToast]
  );

  // 快捷键回调在挂载时注册一次，用 ref 拿最新的切换实现（避免闭包过期）
  const toggleFavoriteRef = useRef(toggleFavorite);
  useEffect(() => {
    toggleFavoriteRef.current = toggleFavorite;
  }, [toggleFavorite]);

  useEffect(() => {
    void loadFavorites();
  }, [loadFavorites]);

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
      } else if (command === 'favorite') {
        const current = useMusicPlaybackStore.getState().current;
        if (current) void toggleFavoriteRef.current(current.id);
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
        onClick={() => playback.current && void toggleFavorite(playback.current.id)}
        aria-label={playback.current && favoriteIds.has(playback.current.id) ? '取消收藏' : '收藏此曲'}
        aria-pressed={Boolean(playback.current && favoriteIds.has(playback.current.id))}
        className={`p-1.5 rounded-lg hover:bg-accent focus-ring ${
          playback.current && favoriteIds.has(playback.current.id)
            ? 'text-primary'
            : 'text-muted-foreground hover:text-foreground'
        }`}
      >
        <Heart size={16} />
      </button>
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
