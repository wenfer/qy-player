import { useLocation, useNavigate } from 'react-router-dom';
import { Home, FolderOpen, Library, Search, Settings, History, Keyboard, Wand2 } from 'lucide-react';

const navItems = [
  { path: '/', label: '首页', icon: Home },
  { path: '/local', label: '本地', icon: FolderOpen },
  { path: '/media-sources', label: '媒体库', icon: Library },
  { path: '/scrape-jobs', label: '刮削任务', icon: Wand2 },
  { path: '/history', label: '历史', icon: History },
  { path: '/shortcuts', label: '快捷键', icon: Keyboard },
  { path: '/search', label: '搜索', icon: Search },
  { path: '/settings', label: '设置', icon: Settings },
];

export default function Navigation() {
  const location = useLocation();
  const navigate = useNavigate();

  return (
    <nav
      className="fixed left-0 top-0 bottom-0 w-60 bg-card border-r border-border flex flex-col z-40"
      aria-label="主导航"
    >
      {/* Logo */}
      <div className="px-5 py-3.5 border-b border-border">
        <button
          onClick={() => navigate('/')}
          className="flex items-center gap-3 focus-ring rounded-lg"
          aria-label="返回首页"
        >
          <div className="w-8 h-8 rounded-md bg-primary flex items-center justify-center flex-shrink-0">
            <span className="text-primary-foreground font-bold text-sm">Q</span>
          </div>
          <span className="font-semibold text-lg tracking-tight">QY Player</span>
        </button>
      </div>

      {/* Nav Items */}
      <div className="flex-1 px-3 py-4 space-y-1">
        {navItems.map((item) => {
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
        <p className="text-[11px] text-muted-foreground">v1.0.0</p>
      </div>
    </nav>
  );
}
