import { useState, useCallback, useRef, useEffect } from 'react';
import { Search as SearchIcon, Loader2, Film } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import PosterCard from '../../components/PosterCard';
import PosterSkeleton from '../../components/Skeleton/PosterSkeleton';
import { useToastStore } from '../../stores/toast-store';
import { getServerMap, buildImageUrl } from '../../utils/server-images';
import { usePlayItem } from '../../hooks/use-play-item';
import type { MediaItem } from '../../components/HorizontalRow';

export default function Search() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<MediaItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const addToast = useToastStore((s) => s.addToast);
  const handleItemPlay = usePlayItem();

  const handleSearch = useCallback(async () => {
    if (!query.trim()) return;
    setLoading(true);
    setSearched(true);
    try {
      const [items, serverMap] = await Promise.all([
        window.electronAPI.searchOnline(query.trim()),
        getServerMap(),
      ]);
      const mapped = (items as Array<Record<string, unknown>>).map((item) => {
        const imageTags = item.ImageTags as Record<string, string> | undefined;
        const serverType = (item.serverType as string) || 'jellyfin';
        return {
          id: item.Id as string,
          name: (item.Name as string) || '未知',
          imageUrl: buildImageUrl(
            serverMap,
            item.serverId as number,
            serverType,
            item.Id as string,
            'Primary',
            imageTags?.Primary
          ),
          year: item.ProductionYear as number,
          rating: item.CommunityRating as number,
          type: item.Type as string,
          serverType,
          serverId: item.serverId as number,
        };
      });
      setResults(mapped);
    } catch (err) {
      addToast(`搜索失败: ${err instanceof Error ? err.message : '未知错误'}`, 'error');
    } finally {
      setLoading(false);
    }
  }, [query, addToast]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSearch();
  };

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div className="p-8 max-w-6xl">
      <h1 className="text-2xl font-bold tracking-tight mb-8">搜索</h1>

      {/* Search input */}
      <div className="flex gap-3 mb-8 max-w-xl">
        <div className="flex-1 relative">
          <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" size={16} />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="搜索电影、电视剧..."
            className="w-full pl-9 pr-4 py-2.5 bg-card border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent transition-colors"
            aria-label="搜索媒体"
          />
        </div>
        <button
          onClick={handleSearch}
          disabled={loading || !query.trim()}
          className="px-5 py-2.5 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50 flex items-center gap-2 text-sm font-medium focus-ring"
        >
          {loading ? <Loader2 size={16} className="animate-spin" /> : <SearchIcon size={16} />}
          搜索
        </button>
      </div>

      {/* Loading skeleton */}
      {loading && (
        <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 gap-4">
          {Array.from({ length: 12 }).map((_, i) => (
            <PosterSkeleton key={i} />
          ))}
        </div>
      )}

      {/* Results */}
      {!loading && searched && (
        <div>
          {results.length > 0 ? (
            <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 gap-4">
              {results.map((item) => (
                <PosterCard
                  key={`${item.serverId}-${item.id}`}
                  id={item.id}
                  name={item.name}
                  imageUrl={item.imageUrl}
                  year={item.year}
                  rating={item.rating}
                  type={item.type}
                  onClick={() => navigate(`/detail/${item.serverType}/${item.id}`)}
                  onPlay={() => handleItemPlay(item)}
                />
              ))}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-20" role="status">
              <Film size={40} className="text-muted-foreground mb-3" />
              <p className="text-muted-foreground">未找到与「{query}」相关的结果</p>
            </div>
          )}
        </div>
      )}

      {/* Initial state */}
      {!searched && !loading && (
        <div className="flex flex-col items-center justify-center py-20" role="status">
          <SearchIcon size={40} className="text-muted-foreground mb-3" />
          <p className="text-muted-foreground">输入关键词开始搜索</p>
        </div>
      )}
    </div>
  );
}
