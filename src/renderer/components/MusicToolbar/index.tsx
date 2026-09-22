import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { AudioLines, Clapperboard, Library, ListMusic, Music2, Settings } from 'lucide-react';
import { useAppModeStore } from '../../stores/app-mode-store';
import { pageTitleFor } from '../Navigation';
import AudioFxPanel from '../AudioFxPanel';

/**
 * 音乐模式顶部工具条（QYP3-068i）。
 *
 * 竖窄屏里左侧图标轨太占宽度：音乐模式现在**没有侧栏**，必要的导航与入口
 * 收进这条 32px 的横条——左边是音乐域的两个页面（音乐 / 歌单），右边是
 * 音乐媒体库、设置与"返回影视"。窗口标题的维护也从侧栏接过来（侧栏在音乐
 * 模式下不再挂载）。
 */

const TABS: Array<{ path: string; label: string; icon: typeof Music2 }> = [
  { path: '/music', label: '音乐', icon: Music2 },
  { path: '/playlists', label: '歌单', icon: ListMusic },
];

const ICON_BTN =
  'p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent focus-ring flex-shrink-0';

export default function MusicToolbar() {
  const location = useLocation();
  const navigate = useNavigate();
  const setMode = useAppModeStore((s) => s.setMode);
  // 音效面板（QYP3-068v）：音乐模式唯一的音效入口
  const [showFx, setShowFx] = useState(false);

  useEffect(() => {
    const page = pageTitleFor(location.pathname);
    document.title = page === '首页' ? 'QY Player' : `${page} · QY Player`;
  }, [location.pathname]);

  return (
    <div className="flex items-center gap-1 px-2 h-8 border-b border-border bg-card/60 flex-shrink-0">
      {TABS.map((tab) => {
        const isActive = location.pathname.startsWith(tab.path);
        const Icon = tab.icon;
        return (
          <button
            key={tab.path}
            type="button"
            onClick={() => navigate(tab.path)}
            aria-current={isActive ? 'page' : undefined}
            className={`flex items-center gap-1 px-2 py-1 rounded-lg text-xs focus-ring ${
              isActive
                ? 'bg-primary/10 text-primary'
                : 'text-muted-foreground hover:text-foreground hover:bg-accent'
            }`}
          >
            <Icon size={14} strokeWidth={isActive ? 2.5 : 2} />
            {tab.label}
          </button>
        );
      })}

      <div className="flex items-center gap-0.5 ml-auto">
        <button
          type="button"
          onClick={() => setShowFx(true)}
          aria-label="音效调节"
          aria-pressed={showFx}
          title="音效调节"
          className={ICON_BTN}
        >
          <AudioLines size={15} />
        </button>
        <button
          type="button"
          onClick={() => navigate('/music-sources')}
          aria-label="音乐媒体库"
          title="音乐媒体库"
          className={ICON_BTN}
        >
          <Library size={15} />
        </button>
        <button
          type="button"
          onClick={() => navigate('/settings')}
          aria-label="设置"
          title="设置"
          className={ICON_BTN}
        >
          <Settings size={15} />
        </button>
        <button
          type="button"
          onClick={() => {
            setMode('video');
            navigate('/');
          }}
          aria-label="返回影视"
          title="返回影视"
          className={`${ICON_BTN} ml-1`}
        >
          <Clapperboard size={15} />
        </button>
      </div>

      {showFx ? <AudioFxPanel onClose={() => setShowFx(false)} /> : null}
    </div>
  );
}
