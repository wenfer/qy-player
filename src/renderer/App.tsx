import { HashRouter, Routes, Route } from 'react-router-dom';
import { useEffect, useRef } from 'react';
import Home from './pages/Home';
import Detail from './pages/Detail';
import Settings from './pages/Settings';
import Libraries from './pages/Libraries';
import MediaSources from './pages/MediaSources';
import MediaSourcesPage from './pages/MediaSources/MediaSourcesPage';
import Search from './pages/Search';
import Local from './pages/Local';
import MusicPage from './pages/Music';
import PlaylistsPage from './pages/Playlists';
import LibraryBrowse from './pages/LibraryBrowse';
import History from './pages/History';
import Shortcuts from './pages/Shortcuts';
import DeskLyrics from './pages/DeskLyrics';
import Navigation from './components/Navigation';
import PlayerControls from './components/PlayerControls';
import MusicMiniBar from './components/MusicMiniBar';
import CompactPlayer from './components/CompactPlayer';
import ToastContainer from './components/Toast';
import NextEpisodeCountdown from './components/NextEpisodeCountdown';
import { useToastStore } from './stores/toast-store';
import { useSleepTimerStore } from './stores/sleep-timer-store';
import { useCompactModeStore } from './stores/compact-mode-store';
import { useMusicPlaybackStore } from './stores/music-playback-store';
import { useResourceStore } from './stores/resource-store';

/**
 * Auto-next host (QYP2-035): the countdown overlay lives app-wide; firing
 * goes through the same resolvePlayback + loadFile path as manual play,
 * with explicit 0 (下一集从 0 开始, §12.2/§12.3).
 */
function AutoNextHost() {
  const addToast = useToastStore((s) => s.addToast);
  const handlePlayNext = async (choice: {
    itemId: number | string;
    mediaSourceId?: string | null;
    provider?: string;
    serverId?: number;
  }) => {
    try {
      if (!choice.provider || typeof choice.serverId !== 'number') {
        addToast('无法确定下一集的媒体来源', 'error');
        return;
      }
      const result = (await window.electronAPI.resolvePlayback(
        { provider: choice.provider, serverId: choice.serverId, itemId: String(choice.itemId) },
        { mode: 'direct', ...(choice.mediaSourceId ? { mediaSourceId: choice.mediaSourceId } : {}) }
      )) as {
        ok: boolean;
        data?: { url: string; streamSessionId?: string; mediaContext: unknown };
        error?: { message: string };
      };
      if (!result.ok || !result.data) {
        addToast(result.error?.message ?? '无法获取下一集播放地址', 'error');
        return;
      }
      await window.electronAPI.playerLoadFile(
        result.data.url,
        0,
        undefined,
        result.data.mediaContext as import('../shared/types/catalog').ResolvedMediaContext,
        result.data.streamSessionId
      );
    } catch (err) {
      addToast(err instanceof Error ? err.message : '自动连播失败', 'error');
    }
  };
  return <NextEpisodeCountdown onPlayNext={handlePlayNext} />;
}

/**
 * 睡眠定时宿主（P2）：权威状态在主进程，这里只负责在应用启动时同步一次
 * 并挂上「到点」事件桥（音乐/视频通用，不依赖任何页面是否打开）。
 */
function SleepTimerHost() {
  const init = useSleepTimerStore((s) => s.init);
  useEffect(() => {
    void init();
  }, [init]);
  return null;
}

/**
 * 精简模式宿主（QYP3-035）：手动进入由按钮触发；这里负责「播放音频时自动进入」
 * （设置项 `playback.autoCompact`）与「音乐会话结束后自动还原」。
 */
function CompactModeHost() {
  const engine = useMusicPlaybackStore((s) => s.engine);
  const compact = useCompactModeStore((s) => s.compact);
  const prevEngine = useRef<string | null>(null);

  useEffect(() => {
    const was = prevEngine.current;
    prevEngine.current = engine;
    // 会话刚开始（null → 有引擎）且未处于精简模式：按设置自动进入
    if (engine && !was && !useCompactModeStore.getState().compact) {
      void Promise.resolve(window.electronAPI.getSettings?.('playback.autoCompact'))
        .then((res) => {
          const v = (res as { data?: unknown } | undefined)?.data;
          if (v === true || v === 'true') useCompactModeStore.getState().enter();
        })
        .catch(() => undefined);
    }
  }, [engine]);

  // 会话结束（或视频接管 mpv）：自动还原，别把用户困在空的小窗里
  useEffect(() => {
    if (compact && engine === null) useCompactModeStore.getState().exit();
  }, [compact, engine]);

  return null;
}

/**
 * 桌面歌词窗口（ADR-0008）复用同一个 renderer 打包产物，但独立成一个
 * BrowserWindow：不带导航栏/播放器外壳，只渲染歌词。
 */
function Shell() {
  const compact = useCompactModeStore((s) => s.compact);
  const isDeskLyrics = window.location.hash.includes('/desk-lyrics');
  if (isDeskLyrics) return <DeskLyrics />;

  // 精简模式（QYP3-035）：整个窗口只渲染浮窗界面
  if (compact) {
    return (
      <>
        <CompactPlayer />
        <ToastContainer />
      </>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground flex">
      <Navigation />
      <main className="flex-1 ml-60 min-h-screen">
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/detail/:type/:serverId/:id" element={<Detail />} />
            <Route path="/library/:serverId/:viewId" element={<LibraryBrowse />} />
            <Route path="/browse/:sourceId" element={<LibraryBrowse />} />
            <Route path="/browse/:sourceId/item/:itemId" element={<LibraryBrowse />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/media-sources" element={<MediaSources />} />
            {/* 音乐模式媒体库（QYP3-040）：只显示非「仅视频」来源 */}
            <Route path="/music-sources" element={<MediaSourcesPage mode="music" />} />
            <Route path="/scrape-jobs" element={<Libraries />} />
            <Route path="/search" element={<Search />} />
            <Route path="/local" element={<Local />} />
            <Route path="/music" element={<MusicPage />} />
            <Route path="/playlists" element={<PlaylistsPage />} />
            <Route path="/history" element={<History />} />
            <Route path="/shortcuts" element={<Shortcuts />} />
            <Route path="/desk-lyrics" element={<DeskLyrics />} />
          </Routes>
        </main>
        <PlayerControls />
        <MusicMiniBar />
        <ToastContainer />
        <AutoNextHost />
        <SleepTimerHost />
      </div>
  );
}

/**
 * 资源保护宿主（QYP3-036）：订阅主进程的系统压力采样并读回「性能保护」开关，
 * 供可视化按压力降帧。与页面无关，始终挂载。
 */
function ResourceHost() {
  useEffect(() => {
    useResourceStore.getState().init();
  }, []);
  return null;
}

function App() {
  return (
    <HashRouter
      future={{ v7_startTransition: true, v7_relativeSplatPath: true } as object}
    >
      <CompactModeHost />
      <ResourceHost />
      <Shell />
    </HashRouter>
  );
}

export default App;
