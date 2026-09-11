import { HashRouter, Routes, Route } from 'react-router-dom';
import Home from './pages/Home';
import Detail from './pages/Detail';
import Settings from './pages/Settings';
import Libraries from './pages/Libraries';
import MediaSources from './pages/MediaSources';
import Search from './pages/Search';
import Local from './pages/Local';
import LibraryBrowse from './pages/LibraryBrowse';
import History from './pages/History';
import Shortcuts from './pages/Shortcuts';
import Navigation from './components/Navigation';
import PlayerControls from './components/PlayerControls';
import ToastContainer from './components/Toast';
import NextEpisodeCountdown from './components/NextEpisodeCountdown';
import { useToastStore } from './stores/toast-store';

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

function App() {
  return (
    <HashRouter
      future={{ v7_startTransition: true, v7_relativeSplatPath: true } as object}
    >
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
            <Route path="/scrape-jobs" element={<Libraries />} />
            <Route path="/search" element={<Search />} />
            <Route path="/local" element={<Local />} />
            <Route path="/history" element={<History />} />
            <Route path="/shortcuts" element={<Shortcuts />} />
          </Routes>
        </main>
        <PlayerControls />
        <ToastContainer />
        <AutoNextHost />
      </div>
    </HashRouter>
  );
}

export default App;
