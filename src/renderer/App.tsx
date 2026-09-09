import { HashRouter, Routes, Route } from 'react-router-dom';
import Home from './pages/Home';
import Detail from './pages/Detail';
import Settings from './pages/Settings';
import Search from './pages/Search';
import Local from './pages/Local';
import LibraryBrowse from './pages/LibraryBrowse';
import History from './pages/History';
import Shortcuts from './pages/Shortcuts';
import Navigation from './components/Navigation';
import PlayerControls from './components/PlayerControls';
import ToastContainer from './components/Toast';

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
            <Route path="/detail/:type/:id" element={<Detail />} />
            <Route path="/library/:serverId/:viewId" element={<LibraryBrowse />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/search" element={<Search />} />
            <Route path="/local" element={<Local />} />
            <Route path="/history" element={<History />} />
            <Route path="/shortcuts" element={<Shortcuts />} />
          </Routes>
        </main>
        <PlayerControls />
        <ToastContainer />
      </div>
    </HashRouter>
  );
}

export default App;
