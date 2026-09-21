import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { Activity, Heart, Mic2, Minimize2, Moon, Music2, Repeat, Repeat1, Shuffle, SkipBack, SkipForward, X } from 'lucide-react';
import { nextRepeat, repeatLabel } from '../../stores/music-playback-store';
import {
  attachMusicMpvBridge,
  useMusicPlaybackStore,
} from '../../stores/music-playback-store';
import { useCompactModeStore } from '../../stores/compact-mode-store';
import { useAppModeStore } from '../../stores/app-mode-store';
import { useSleepTimerStore, formatRemaining } from '../../stores/sleep-timer-store';
import { useToastStore } from '../../stores/toast-store';
import LyricsPanel from '../LyricsPanel';
import Visualizer, { type VisualizerMode } from '../Visualizer';

/**
 * 音乐迷你控制条（QYP3-013 / QYP3-026）：音乐会话（任一引擎）期间全局
 * 常驻（可折叠）。mpv 引擎的位置由主进程状态事件经
 * `attachMusicMpvBridge` 写回（视频不会驱动本条）；歌词面板（QYP3-021）
 * 由本条的「词」按钮开合；拾音器（QYP3-023）按设置模式显示。
 *
 * 布局（QYP3-049，四行）：频谱 / 曲名+时间 / 进度条 / 按钮。
 * 频谱与进度条**同时**显示、互不替代——此前暂停时频谱会让位给一根没有
 * 用的进度条；进度条也从"夹在播放按钮右边的窄条"改成独占一行、可点可键盘。
 * 所有按钮固定 32×32 且不许压缩（`flex-shrink-0`）：竖窄屏里一排按钮会把
 * 彼此挤成椭圆，宁可换行也不压。
 */

/** 拾音器高度（QYP3-048：从 24 抬到 32，LED 分段更看得清）。 */
const VISUALIZER_HEIGHT = 32;

/**
 * 按钮统一 32×32 且 `flex-shrink-0`（QYP3-049）：竖窄屏里一排按钮会把彼此
 * 挤扁成椭圆，所以宁可换行也不许压缩。
 */
const ICON_BTN =
  'flex-shrink-0 flex items-center justify-center h-8 w-8 rounded-lg hover:bg-accent text-muted-foreground hover:text-foreground focus-ring';
const PLAY_BTN =
  'flex-shrink-0 flex items-center justify-center h-9 w-9 rounded-full bg-primary text-primary-foreground hover:bg-primary/90 focus-ring';

/**
 * 拾音器模式：off=关闭；waveform=真实波形（只有 renderer 引擎有）；
 * spectrum/auto=频谱——renderer 引擎是实时频谱，mpv 引擎是离线预算频谱
 * （QYP3-050），拿不到时可视化自己画静音底线。
 */
export function resolveMode(setting: string): VisualizerMode | null {
  if (setting === 'off') return null;
  if (setting === 'waveform') return 'waveform';
  return 'spectrum';
}

export default function MusicMiniBar() {
  const playback = useMusicPlaybackStore();
  const sleep = useSleepTimerStore();
  // 音乐模式（竖窄屏）里停靠在窗口底部，成为音乐界面的常驻播放条（QYP3-045）；
  // 其他模式仍是居中浮卡，不喧宾夺主
  const docked = useAppModeStore((s) => s.mode === 'music');
  const [collapsed, setCollapsed] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [showLyrics, setShowLyrics] = useState(false);
  const [visualizer, setVisualizer] = useState<string>('auto');
  // 频谱显隐（QYP3-048）：控制条上随时可关，默认开，选择持久化
  const [showSpectrum, setShowSpectrum] = useState(true);
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
    // 频谱显隐（QYP3-048）：JSON 对称——SET 字符串化、GET 由 decodeConfigValue 还原
    void window.electronAPI
      .getSettings('playback.showSpectrum')
      .then((res) => {
        const value = (res as { data?: unknown })?.data;
        if (typeof value === 'boolean') setShowSpectrum(value);
      })
      .catch(() => undefined);
  }, []);

  const toggleSpectrum = useCallback((): void => {
    setShowSpectrum((prev) => {
      const next = !prev;
      void window.electronAPI.setSettings('playback.showSpectrum', next).catch(() => undefined);
      return next;
    });
  }, []);

  /**
   * 进度条单独占一行（QYP3-049）：此前它被夹在播放按钮右边，既窄又无法操作。
   * 自绘的进度条要自己接键盘：←/→ ±5s（Shift ×30），Home/End 到头尾。
   */
  const progressRef = useRef<HTMLDivElement>(null);

  const seekToRatio = useCallback((ratio: number): void => {
    const s = useMusicPlaybackStore.getState();
    if (s.duration <= 0) return;
    s.seek(Math.max(0, Math.min(1, ratio)) * s.duration);
  }, []);

  const handleProgressClick = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>): void => {
      const rect = progressRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return;
      seekToRatio((e.clientX - rect.left) / rect.width);
    },
    [seekToRatio]
  );

  const handleProgressKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>): void => {
      const { position, duration } = useMusicPlaybackStore.getState();
      if (duration <= 0) return;
      const step = e.shiftKey ? 30 : 5;
      const clamp = (v: number): number => Math.max(0, Math.min(duration, v));
      if (e.key === 'ArrowLeft') seekToRatio(clamp(position - step) / duration);
      else if (e.key === 'ArrowRight') seekToRatio(clamp(position + step) / duration);
      else if (e.key === 'Home') seekToRatio(0);
      else if (e.key === 'End') seekToRatio(1);
      else return;
      e.preventDefault();
    },
    [seekToRatio]
  );

  useEffect(() => {
    setMounted(true);
    // mpv 引擎位置源 + 视频接管时的会话收尾（QYP3-026）
    attachMusicMpvBridge();
  }, []);

  useEffect(() => {
    // 全局媒体键（QYP3-013）：main 侧在音乐会话期间转发
    const off = window.electronAPI.onMusicCommand?.((command: string) => {
      if (command === 'toggle') {
        playback.isPlaying ? playback.pause() : playback.resume();
      } else if (command === 'next') {
        void playback.next();
      } else if (command === 'prev') {
        void playback.prev();
      } else if (command === 'favorite') {
        const current = useMusicPlaybackStore.getState().current;
        // 服务器曲目不在本地库（id=0），没有可收藏的行
        if (current && current.id > 0) void toggleFavoriteRef.current(current.id);
      }
    });
    return () => {
      if (typeof off === 'function') off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // QYP3-053：恢复态（engine 为 null 但已有上次的曲目与进度）也要显示——
  // 这就是"下次打开保持上次的音乐"的可见形态；点播放才真正起播。
  if (!mounted || (!playback.engine && !playback.restored) || !playback.current) return null;
  // 服务器曲目以服务器为准（不落本地库），收藏只对扫描入库的音轨开放
  const canFavorite = playback.current.id > 0;
  // 进度百分比（进度条自己的一行，与频谱互不替代——QYP3-049）
  const pct =
    playback.duration > 0
      ? Math.min(100, Math.max(0, (playback.position / playback.duration) * 100))
      : 0;

  const fmt = (sec: number): string => {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  };

  if (collapsed) {
    return (
      <div className={`fixed z-40 ${docked ? 'bottom-3 left-3 right-3 flex justify-end' : 'bottom-4 right-4'}`}>
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
      {showLyrics && playback.current && playback.currentSource && (
        <LyricsPanel
          source={playback.currentSource}
          title={playback.current.title}
          position={playback.position}
          onSeek={playback.seek}
          onClose={() => setShowLyrics(false)}
        />
      )}
      <div
        className={`fixed z-40 bg-card/95 backdrop-blur border-border px-4 py-3 flex flex-col gap-2 ${
          docked
            ? 'bottom-0 left-0 right-0 border-t'
            : 'bottom-4 left-1/2 -translate-x-1/2 w-[min(560px,calc(100vw-2rem))] border rounded-xl shadow-lg'
        }`}
      >
        {/* 频谱：常驻一行（暂停时冻结最后一帧，不再退化成进度条——进度有自己的一行） */}
        {(() => {
          const mode = resolveMode(visualizer);
          return showSpectrum && mode ? (
            <Visualizer
              mode={mode}
              getSpectrum={playback.getSpectrum}
              getWaveform={playback.getWaveform}
              isPlaying={playback.isPlaying}
              height={VISUALIZER_HEIGHT}
            />
          ) : null;
        })()}

        {/* 曲名 + 时间 */}
        <div className="flex items-baseline gap-2 min-w-0">
          <p className="text-sm font-medium truncate min-w-0 flex-1">
            {playback.current.title}
            {playback.current.artist ? (
              <span className="ml-1 text-xs text-muted-foreground">{playback.current.artist}</span>
            ) : null}
          </p>
          <span className="text-[11px] text-muted-foreground tabular-nums flex-shrink-0">
            {fmt(playback.position)} / {fmt(playback.duration)}
          </span>
        </div>

        {/* 进度条：独占一行，可点可键盘（外框 16px 高是为了好点，内轨仍是细条） */}
        <div
          role="slider"
          tabIndex={0}
          aria-label="播放进度（左右方向键快退快进，Home/End 到头尾）"
          aria-valuemin={0}
          aria-valuemax={Math.max(1, Math.round(playback.duration))}
          aria-valuenow={Math.round(playback.position)}
          aria-valuetext={`${fmt(playback.position)} / ${fmt(playback.duration)}`}
          onClick={handleProgressClick}
          onKeyDown={handleProgressKeyDown}
          className="h-4 flex items-center cursor-pointer group focus-ring"
        >
          <div ref={progressRef} className="relative h-1.5 w-full rounded-full bg-muted">
            <div
              className="absolute inset-y-0 left-0 bg-primary rounded-full"
              style={{ width: `${pct}%` }}
            />
            <span
              className="absolute top-1/2 -translate-y-1/2 h-3 w-3 -ml-1.5 rounded-full bg-primary opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition-opacity"
              style={{ left: `${pct}%` }}
            />
          </div>
        </div>

        <div className="flex items-center gap-1 flex-wrap">
          <div className="flex items-center gap-1 flex-shrink-0">
            <button
              type="button"
              onClick={() => void playback.prev()}
              aria-label="上一曲"
              className={ICON_BTN}
            >
              <SkipBack size={16} />
            </button>
            {playback.isPlaying ? (
              <button
                type="button"
                onClick={() => playback.pause()}
                aria-label="暂停音乐"
                className={PLAY_BTN}
              >
                <span aria-hidden className="text-sm leading-none">⏸</span>
              </button>
            ) : (
              <button
                type="button"
                // 恢复态（engine 为 null）没引擎可 resume：从上次位置真正起播
                onClick={() => {
                  if (playback.engine) playback.resume();
                  else void playback.resumeRestored();
                }}
                aria-label="继续播放音乐"
                className={PLAY_BTN}
              >
                <span aria-hidden className="text-sm leading-none ml-0.5">▶</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => void playback.next()}
              aria-label="下一曲"
              className={ICON_BTN}
            >
              <SkipForward size={16} />
            </button>
          </div>

          <div className="flex items-center gap-1 flex-shrink-0 ml-auto">
            <button
              type="button"
              onClick={() => canFavorite && playback.current && void toggleFavorite(playback.current.id)}
              aria-label={canFavorite && favoriteIds.has(playback.current.id) ? '取消收藏' : '收藏此曲'}
              aria-pressed={Boolean(canFavorite && favoriteIds.has(playback.current.id))}
              disabled={!canFavorite}
              title={canFavorite ? undefined : '服务器曲目不支持收藏'}
              className={`${ICON_BTN} disabled:opacity-40 disabled:cursor-default ${
                canFavorite && favoriteIds.has(playback.current.id)
                  ? 'text-primary'
                  : ''
              }`}
            >
              <Heart size={16} />
            </button>
            <button
              type="button"
              onClick={() => playback.setRepeat(nextRepeat(playback.repeat))}
              aria-label="循环模式"
              aria-pressed={playback.repeat !== 'off'}
              title={repeatLabel(playback.repeat)}
              className={`${ICON_BTN} ${playback.repeat !== 'off' ? 'text-primary' : ''}`}
            >
              {playback.repeat === 'one' ? <Repeat1 size={16} /> : <Repeat size={16} />}
            </button>
            <button
              type="button"
              onClick={playback.toggleShuffle}
              aria-label="随机播放"
              aria-pressed={playback.shuffle}
              title={playback.shuffle ? '随机播放：开' : '随机播放：关'}
              className={`${ICON_BTN} ${playback.shuffle ? 'text-primary' : ''}`}
            >
              <Shuffle size={16} />
            </button>
            <button
              type="button"
              onClick={toggleSpectrum}
              aria-label={showSpectrum ? '隐藏频谱' : '显示频谱'}
              aria-pressed={showSpectrum}
              title={showSpectrum ? '隐藏频谱' : '显示频谱'}
              className={`${ICON_BTN} ${showSpectrum ? 'text-primary' : ''}`}
            >
              <Activity size={16} />
            </button>
            <button
              type="button"
              onClick={() => setShowLyrics((v) => !v)}
              aria-label="歌词"
              aria-pressed={showLyrics}
              className={`${ICON_BTN} ${showLyrics ? 'text-primary' : ''}`}
            >
              <Mic2 size={16} />
            </button>
            <button
              type="button"
              onClick={() => useCompactModeStore.getState().enter()}
              aria-label="精简模式"
              title="精简模式（缩小为右上角浮窗）"
              className={ICON_BTN}
            >
              <Minimize2 size={16} />
            </button>
            {sleep.active && (
              <button
                type="button"
                onClick={() => void sleep.setMinutes(0)}
                aria-label="取消睡眠定时"
                title="点击取消睡眠定时"
                className="flex-shrink-0 flex items-center gap-1 px-2 h-8 rounded-lg text-[10px] text-primary border border-border hover:bg-accent focus-ring"
              >
                <Moon size={12} />
                {formatRemaining(sleep.remainingMs)}
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                playback.pause();
                setCollapsed(true);
              }}
              aria-label="收起音乐控制条"
              className={ICON_BTN}
            >
              <X size={14} />
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
