import { useCallback, useEffect, useState, useRef } from 'react';
import { Play, Pause, Volume2, VolumeX, Expand, PictureInPicture, Minimize2, Maximize } from 'lucide-react';
import { usePlayerStore } from '../../stores/player-store';

interface MpvTrack {
  id: number;
  type: string;
  title?: string;
  lang?: string;
  selected?: boolean;
}

function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '0:00';
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export default function PlayerControls() {
  const {
    isPlaying,
    currentTime,
    duration,
    volume,
    isMuted,
    isFullscreen,
  } = usePlayerStore();

  const [isDragging] = useState(false);
  const [dragValue] = useState(0);
  const [isPip, setIsPip] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);
  const [tracks, setTracks] = useState<MpvTrack[]>([]);
  const progressRef = useRef<HTMLDivElement>(null);

  const audioTracks = tracks.filter((t) => t.type === 'audio');
  const subTracks = tracks.filter((t) => t.type === 'sub');

  const progress = duration > 0 ? (isDragging ? dragValue : currentTime) / duration : 0;

  useEffect(() => {
    if (!window.electronAPI) return;
    const unsubscribe = window.electronAPI.onPlayerStateChange((state: unknown) => {
      const s = state as Record<string, unknown>;
      const store = usePlayerStore.getState();
      if (typeof s.currentTime === 'number') store.setCurrentTime(s.currentTime);
      if (typeof s.duration === 'number') store.setDuration(s.duration);
      if (typeof s.isPlaying === 'boolean') store.setPlaying(s.isPlaying);
      if (typeof s.volume === 'number') store.setVolume(s.volume);
      if (typeof s.isFullscreen === 'boolean') store.setFullscreen(s.isFullscreen);
      if (typeof s.eof === 'boolean' && s.eof) store.setPlaying(false);
    });
    return () => { unsubscribe(); };
  }, []);

  const handlePlayPause = useCallback(() => {
    window.electronAPI?.playerControl('toggle-pause');
  }, []);

  const handleSeek = useCallback((ratio: number) => {
    if (duration > 0) {
      window.electronAPI?.playerControl('seek', ratio * duration);
    }
  }, [duration]);

  const handleProgressClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const rect = progressRef.current?.getBoundingClientRect();
    if (!rect) return;
    const ratio = (e.clientX - rect.left) / rect.width;
    handleSeek(Math.max(0, Math.min(1, ratio)));
  }, [handleSeek]);

  const handleVolumeChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const vol = parseInt(e.target.value, 10);
    window.electronAPI?.playerControl('volume', vol);
  }, []);

  const handleToggleMute = useCallback(() => {
    window.electronAPI?.playerControl('volume', isMuted ? (volume || 50) : 0);
  }, [isMuted, volume]);

  const handleFullscreen = useCallback(() => {
    window.electronAPI?.playerControl('fullscreen', !isFullscreen);
  }, [isFullscreen]);

  // Load track lists when playback starts (and re-check on track changes)
  const refreshTracks = useCallback(async () => {
    try {
      const list = (await window.electronAPI?.playerGetTracks()) as MpvTrack[];
      setTracks(Array.isArray(list) ? list : []);
    } catch {
      setTracks([]);
    }
  }, []);

  useEffect(() => {
    if (isPlaying) refreshTracks();
  }, [isPlaying, refreshTracks]);

  const handleSetAudio = useCallback((id: string) => {
    window.electronAPI?.playerControl('set-audio', parseInt(id, 10));
  }, []);

  const handleSetSub = useCallback((id: string) => {
    // 0 means subtitle off
    window.electronAPI?.playerControl('set-sub', parseInt(id, 10) || 0);
  }, []);

  const handleTogglePip = useCallback(() => {
    const next = !isPip;
    window.electronAPI?.playerControl('set-ontop', next);
    window.electronAPI?.playerControl('set-window-scale', next ? 0.3 : 1);
    setIsPip(next);
  }, [isPip]);

  const handleToggleMaximized = useCallback(() => {
    const next = !isMaximized;
    window.electronAPI?.playerControl('set-maximized', next);
    setIsMaximized(next);
  }, [isMaximized]);

  if (!usePlayerStore.getState().isVisible || !window.electronAPI) return null;

  return (
    <div className="fixed bottom-0 left-60 right-0 bg-background/95 backdrop-blur-md border-t border-border px-5 py-3 z-50">
      {/* Progress bar */}
      <div
        ref={progressRef}
        className="relative h-1.5 bg-muted rounded-full cursor-pointer group mb-3"
        onClick={handleProgressClick}
        role="slider"
        aria-valuemin={0}
        aria-valuemax={duration}
        aria-valuenow={currentTime}
        aria-label="播放进度"
      >
        <div
          className="absolute inset-y-0 left-0 bg-primary rounded-full transition-all duration-75"
          style={{ width: `${progress * 100}%` }}
        />
        <div
          className="absolute top-1/2 -translate-y-1/2 w-3 h-3 bg-primary rounded-full opacity-0 group-hover:opacity-100 transition-opacity shadow-sm"
          style={{ left: `calc(${progress * 100}% - 6px)` }}
        />
      </div>

      <div className="flex items-center justify-between">
        {/* Time */}
        <div className="text-xs text-muted-foreground tabular-nums w-24">
          {formatTime(isDragging ? dragValue : currentTime)}
          <span className="mx-1 text-border">/</span>
          {formatTime(duration)}
        </div>

        {/* Center controls */}
        <div className="flex items-center gap-1">
          <button
            onClick={handlePlayPause}
            className="p-2.5 rounded-full hover:bg-accent transition-colors focus-ring"
            aria-label={isPlaying ? '暂停' : '播放'}
          >
            {isPlaying ? <Pause size={20} /> : <Play size={20} fill="currentColor" />}
          </button>

          <select
            onChange={(e) => handleSetAudio(e.target.value)}
            className="text-xs bg-card border border-border rounded-md px-1.5 py-1 text-muted-foreground hover:text-foreground cursor-pointer focus-ring max-w-[110px]"
            aria-label="音轨"
            title="音轨"
            value={String(audioTracks.find((t) => t.selected)?.id ?? '')}
          >
            <option value="" disabled>音轨</option>
            {audioTracks.map((t) => (
              <option key={t.id} value={String(t.id)}>
                {t.title || t.lang || `音轨 ${t.id}`}{t.lang ? ` (${t.lang})` : ''}
              </option>
            ))}
          </select>

          <select
            onChange={(e) => handleSetSub(e.target.value)}
            className="text-xs bg-card border border-border rounded-md px-1.5 py-1 text-muted-foreground hover:text-foreground cursor-pointer focus-ring max-w-[110px]"
            aria-label="字幕"
            title="字幕"
            value={String(subTracks.find((t) => t.selected)?.id ?? '0')}
          >
            <option value="0">关闭字幕</option>
            {subTracks.map((t) => (
              <option key={t.id} value={String(t.id)}>
                {t.title || t.lang || `字幕 ${t.id}`}{t.lang ? ` (${t.lang})` : ''}
              </option>
            ))}
          </select>

          <select
            onChange={(e) => {
              window.electronAPI?.playerControl('aspect-ratio', e.target.value);
            }}
            className="text-xs bg-card border border-border rounded-md px-1.5 py-1 text-muted-foreground hover:text-foreground cursor-pointer focus-ring"
            aria-label="画面比例"
            title="画面比例"
            defaultValue=""
          >
            <option value="" disabled>比例</option>
            <option value="auto">自动</option>
            <option value="16:9">16:9</option>
            <option value="4:3">4:3</option>
            <option value="2.35:1">2.35:1</option>
            <option value="1:1">1:1</option>
          </select>

          <button
            onClick={handleTogglePip}
            className={`p-2 rounded-full hover:bg-accent transition-colors focus-ring ${isPip ? 'text-primary' : ''}`}
            aria-label={isPip ? '退出小窗' : '小窗播放'}
            title={isPip ? '退出小窗' : '小窗播放'}
          >
            <PictureInPicture size={18} />
          </button>

          <button
            onClick={handleToggleMaximized}
            className="p-2 rounded-full hover:bg-accent transition-colors focus-ring"
            aria-label={isMaximized ? '还原窗口' : '最大化窗口'}
            title={isMaximized ? '还原窗口' : '最大化窗口'}
          >
            {isMaximized ? <Minimize2 size={18} /> : <Maximize size={18} />}
          </button>

          <button
            onClick={handleFullscreen}
            className="p-2 rounded-full hover:bg-accent transition-colors focus-ring"
            aria-label={isFullscreen ? '退出全屏' : '全屏'}
            title="全屏"
          >
            <Expand size={18} />
          </button>
        </div>

        {/* Volume */}
        <div className="flex items-center gap-2 w-28 justify-end">
          <button
            onClick={handleToggleMute}
            className="p-1.5 rounded-full hover:bg-accent transition-colors focus-ring"
            aria-label={isMuted || volume === 0 ? '取消静音' : '静音'}
          >
            {isMuted || volume === 0 ? <VolumeX size={16} /> : <Volume2 size={16} />}
          </button>
          <input
            type="range"
            min={0}
            max={100}
            value={isMuted ? 0 : volume}
            onChange={handleVolumeChange}
            className="w-16 h-1 accent-primary cursor-pointer"
            aria-label="音量"
          />
        </div>
      </div>
    </div>
  );
}
