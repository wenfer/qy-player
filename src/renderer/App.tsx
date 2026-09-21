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
import TitleBar, { WindowResizeHandles } from './components/TitleBar';
import PlayerControls from './components/PlayerControls';
import MusicMiniBar from './components/MusicMiniBar';
import CompactPlayer from './components/CompactPlayer';
import MusicToolbar from './components/MusicToolbar';
import ToastContainer from './components/Toast';
import WindowProfileHost from './components/WindowProfileHost';
import { useAppModeStore } from './stores/app-mode-store';
import NextEpisodeCountdown from './components/NextEpisodeCountdown';
import { useToastStore } from './stores/toast-store';
import { useSleepTimerStore } from './stores/sleep-timer-store';
import { useCompactModeStore } from './stores/compact-mode-store';
import { attachMusicMpvBridge, useMusicPlaybackStore } from './stores/music-playback-store';
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
 *
 * QYP3-051：精简态可以跨重启恢复（主进程按记忆把窗口开成浮窗，回填后
 * `compact` 直接是 true 而 `engine` 还是 null）。所以还原条件必须是
 * **会话真正结束**（engine 由非 null → null），不能写成 `compact && engine === null`
 * ——那会在冷启动的第一帧就把恢复出来的浮窗撤销掉。两个副作用因此合并成一个
 * effect：分开写的话"进入"那个会先把 `prevEngine` 写成新值，退出判断就失效了。
 */
export function CompactModeHost() {
  const engine = useMusicPlaybackStore((s) => s.engine);
  const prevEngine = useRef<string | null>(null);

  useEffect(() => {
    const was = prevEngine.current;
    prevEngine.current = engine;

    // 会话刚开始（null → 有引擎）：按设置自动进入精简模式
    if (engine && !was) {
      if (useCompactModeStore.getState().compact) return;
      void Promise.resolve(window.electronAPI.getSettings?.('playback.autoCompact'))
        .then((res) => {
          const v = (res as { data?: unknown } | undefined)?.data;
          if (v === true || v === 'true') useCompactModeStore.getState().enter();
        })
        .catch(() => undefined);
      return;
    }

    // 会话结束（或视频接管 mpv）：自动还原，别把用户困在空的小窗里
    if (!engine && was && useCompactModeStore.getState().compact) {
      useCompactModeStore.getState().exit();
    }
  }, [engine]);

  return null;
}

/**
 * 当前播放的音乐宿主（QYP3-053）：启动时读回上次的曲目与进度，把播放条
 * 恢复出来（不自动出声，点播放才继续）。
 *
 * 挂在 `Shell` **之外**：精简浮窗里渲染的是 `CompactPlayer`，音乐条的宿主
 * 若放在 `MusicMiniBar` 里就永远不跑。恢复态**不算音乐会话**（engine 仍为
 * null），所以不会误触自动精简，也不会抢走全局媒体键。
 *
 * 顺带把 mpv 桥也挂上（幂等，与 `MusicMiniBar` 里那次重复调用无害）：浮窗
 * 分支不渲染音乐条，而 QYP3-051 起冷启动就可能直接是浮窗——那种情况下没有
 * 这个桥，mpv 引擎的曲目进度就永远不更新（内置引擎不受影响）。
 */
function NowPlayingHost() {
  const init = useMusicPlaybackStore((s) => s.initNowPlaying);
  useEffect(() => {
    attachMusicMpvBridge();
    void init();
  }, [init]);
  return null;
}

/**
 * 音乐会话按模式收尾（QYP3-068p）：回到影视模式就**结束**音乐会话——停引擎、
 * 清恢复态、作废落盘的待播记录，播放条随之消失（此前是跨模式保留，影视界面
 * 上会一直挂着一条音乐条）。
 *
 * 依赖里带上 `hasSession` 而不是只看 mode：冷启动时 mode 已经是 video，恢复
 * 出来的待播条目是异步到达的（主进程在 GET_NOW_PLAYING 里已按记忆的模式挡过
 * 一道，这里再兜一次）。
 */
function MusicSessionModeHost() {
  const mode = useAppModeStore((s) => s.mode);
  const hasSession = useMusicPlaybackStore((s) => s.engine !== null || s.restored);
  useEffect(() => {
    if (mode === 'video' && hasSession) useMusicPlaybackStore.getState().endSession();
  }, [mode, hasSession]);
  return null;
}

/**
 * 桌面歌词窗口（ADR-0008）复用同一个 renderer 打包产物，但独立成一个
 * BrowserWindow：不带导航栏/播放器外壳，只渲染歌词。
 */
function Shell() {
  const compact = useCompactModeStore((s) => s.compact);
  // 音乐模式侧栏收成图标轨（QYP3-044），内容区的左边距跟着变
  const mode = useAppModeStore((s) => s.mode);
  // 音乐模式下播放条停靠窗口底部（QYP3-045），内容区留出它的高度。
  // QYP3-053：恢复态（上次的音乐，未起播）同样要占位，否则重启后内容区
  // 会盖住恢复出来的播放条。
  const musicSession = useMusicPlaybackStore((s) => s.engine !== null || s.restored);
  const isDeskLyrics = window.location.hash.includes('/desk-lyrics');
  if (isDeskLyrics) return <DeskLyrics />;

  // 精简模式（QYP3-035）：整个窗口只渲染浮窗界面（无边框后仍需一条自绘
  // 标题栏来拖动/还原，QYP3-042）
  if (compact) {
    return (
      <div className="h-screen flex flex-col bg-background text-foreground">
        <TitleBar compact />
        <div className="flex-1 min-h-0">
          <CompactPlayer />
        </div>
        <ToastContainer />
      </div>
    );
  }

  return (
    <div className="h-screen bg-background text-foreground flex flex-col">
      <TitleBar />
      {/* 音乐模式没有侧栏（QYP3-068i）：竖窄屏的宽度全部让给内容，必要的
          导航/入口收进这条 32px 的顶部工具条 */}
      {mode === 'music' && <MusicToolbar />}
      <div className="flex-1 min-h-0 flex">
        {mode === 'video' && <Navigation />}
        <main
          className={`flex-1 min-h-0 overflow-y-auto ${
            mode === 'video' ? 'ml-60' : ''
          } ${mode === 'music' && musicSession ? 'pb-40' : ''}`}
        >
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/detail/:type/:serverId/:id" element={<Detail />} />
            <Route path="/library/:serverId/:viewId" element={<LibraryBrowse />} />
            <Route path="/browse/:sourceId" element={<LibraryBrowse />} />
            <Route path="/browse/:sourceId/item/:itemId" element={<LibraryBrowse />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/media-sources" element={<MediaSources />} />
            {/* 音乐模式媒体库（QYP3-040/041）：只显示音乐来源 */}
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
      </div>
      <PlayerControls />
      <MusicMiniBar />
      <ToastContainer />
      <AutoNextHost />
      <SleepTimerHost />
      {/* 无边框窗口的缩放热区（QYP3-042） */}
      <WindowResizeHandles />
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
      <WindowProfileHost />
      <ResourceHost />
      <NowPlayingHost />
      <MusicSessionModeHost />
      <Shell />
    </HashRouter>
  );
}

export default App;
