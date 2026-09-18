import { useLocation, useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import {
  Home, FolderOpen, Library, Search, Settings, History, Wand2,
  Music, ListMusic, Clapperboard,
} from 'lucide-react';
import { useAppModeStore, MODE_HOME, type AppMode } from '../../stores/app-mode-store';

interface NavItem {
  path: string;
  label: string;
  icon: typeof Home;
}

/** 视频模式导航（QYP3-040）：影视域页面 + 视频侧媒体库/设置。 */
const VIDEO_NAV: NavItem[] = [
  { path: '/', label: '首页', icon: Home },
  { path: '/local', label: '本地', icon: FolderOpen },
  { path: '/search', label: '搜索', icon: Search },
  { path: '/history', label: '历史', icon: History },
  { path: '/scrape-jobs', label: '刮削任务', icon: Wand2 },
  { path: '/media-sources', label: '媒体库', icon: Library },
  { path: '/settings', label: '设置', icon: Settings },
];

/** 音乐模式导航（QYP3-040）：音乐域页面 + 音乐侧媒体库/设置。 */
const MUSIC_NAV: NavItem[] = [
  { path: '/music', label: '音乐', icon: Music },
  { path: '/playlists', label: '歌单', icon: ListMusic },
  { path: '/music-sources', label: '媒体库', icon: Library },
  { path: '/settings', label: '设置', icon: Settings },
];

const NAV_BY_MODE: Record<AppMode, NavItem[]> = { video: VIDEO_NAV, music: MUSIC_NAV };

const MODE_TABS: Array<{ value: AppMode; label: string; icon: typeof Music }> = [
  { value: 'video', label: '影视', icon: Clapperboard },
  { value: 'music', label: '音乐', icon: Music },
];

/** 窗口标题随页面内容变化（GNOME 任务栏可辨识当前所在页面）。 */
function pageTitleFor(pathname: string): string {
  if (pathname.startsWith('/detail/')) return '详情';
  if (pathname.startsWith('/library/') || pathname.startsWith('/browse/')) return '媒体库';
  // 精确匹配优先，其次最长前缀（/music-sources 不能被 /music 前缀抢走）
  const all = [...VIDEO_NAV, ...MUSIC_NAV];
  const exact = all.find((item) => item.path === pathname);
  if (exact) return exact.label;
  const hit = all
    .filter((item) => item.path !== '/' && pathname.startsWith(item.path))
    .sort((a, b) => b.path.length - a.path.length)[0];
  return hit?.label ?? '首页';
}

export default function Navigation() {
  const location = useLocation();
  const navigate = useNavigate();
  const mode = useAppModeStore((s) => s.mode);
  const setMode = useAppModeStore((s) => s.setMode);

  useEffect(() => {
    const page = pageTitleFor(location.pathname);
    document.title = page === '首页' ? 'QY Player' : `${page} · QY Player`;
  }, [location.pathname]);

  const [appVersion, setAppVersion] = useState('');
  useEffect(() => {
    (async () => {
      try {
        const res = (await window.electronAPI.getAppVersion()) as { ok: boolean; data?: { version: string } };
        setAppVersion(res.ok ? res.data?.version ?? '' : '');
      } catch {
        // 版本号仅展示用
      }
    })();
  }, []);

  const handleModeChange = (next: AppMode): void => {
    if (next === mode) return;
    setMode(next);
    // 总是跳到该模式的默认页（QYP3-040）：离开另一模式的页面是切换语义
    // 的一部分，无需额外的路由守卫
    navigate(MODE_HOME[next]);
  };

  return (
    <nav
      className="fixed left-0 top-0 bottom-0 w-60 bg-card border-r border-border flex flex-col z-40"
      aria-label="主导航"
    >
      {/* Logo */}
      <div className="px-5 py-3.5 border-b border-border">
        <button
          onClick={() => navigate(MODE_HOME[mode])}
          className="flex items-center gap-3 focus-ring rounded-lg"
          aria-label="返回首页"
        >
          <div className="w-8 h-8 rounded-md bg-primary flex items-center justify-center flex-shrink-0">
            <span className="text-primary-foreground font-bold text-sm">Q</span>
          </div>
          <span className="font-semibold text-lg tracking-tight">QY Player</span>
        </button>
        {/* 模式切换（QYP3-040）：视频模式与音乐模式完全隔离 */}
        <div
          className="mt-3 flex items-center gap-1 p-1 bg-secondary rounded-lg"
          role="radiogroup"
          aria-label="模式切换"
        >
          {MODE_TABS.map((tab) => {
            const TabIcon = tab.icon;
            const active = mode === tab.value;
            return (
              <button
                key={tab.value}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => handleModeChange(tab.value)}
                className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 text-sm rounded-md transition-all focus-ring ${
                  active ? 'bg-background text-foreground' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                <TabIcon size={14} />
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Nav Items（按当前模式切换，QYP3-040） */}
      <div className="flex-1 px-3 py-4 space-y-1">
        {NAV_BY_MODE[mode].map((item) => {
          const isActive = location.pathname === item.path;
          const Icon = item.icon;
          return (
            <button
              key={item.path}
              onClick={() => navigate(item.path)}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors focus-ring ${
                isActive
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:text-foreground hover:bg-accent'
              }`}
              aria-current={isActive ? 'page' : undefined}
            >
              <Icon size={18} strokeWidth={isActive ? 2.5 : 2} />
              <span>{item.label}</span>
            </button>
          );
        })}
      </div>

      {/* Footer */}
      <div className="px-5 py-3 border-t border-border">
        <p className="text-[11px] text-muted-foreground">{appVersion ? `v${appVersion}` : ""}</p>
      </div>
    </nav>
  );
}
