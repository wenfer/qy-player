import { useState, useCallback, useRef, useEffect } from 'react';
import { Search as SearchIcon, Loader2, Film } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import PosterCard from '../../components/PosterCard';
import PosterSkeleton from '../../components/Skeleton/PosterSkeleton';
import { useToastStore } from '../../stores/toast-store';
import { getServerMap, buildImageUrl } from '../../utils/server-images';
import { usePlayItem } from '../../hooks/use-play-item';
import type { MediaItem } from '../../components/HorizontalRow';
import type { UnifiedCard } from '../../../main/modules/catalog/unified-query';
import type { MediaRef } from '../../../shared/types/catalog';
import { mediaRefKey } from '../../../main/modules/catalog/unified-query';


/** QYP2-036: 统一搜索卡 → 展示/路由适配（catalog /browse，在线 /detail）。 */
function unifiedToMediaItem(card: UnifiedCard, serverMap: Awaited<ReturnType<typeof getServerMap>>): MediaItem {
  const isCatalog = card.ref.provider === 'catalog';
  const provider = card.ref.provider;
  const serverId = card.ref.provider === 'catalog' ? card.ref.sourceId : card.ref.serverId;
  const imageUrl =
    !isCatalog && card.poster?.tag
      ? buildImageUrl(serverMap, serverId, provider, card.ref.itemId, 'Primary', card.poster.tag)
      : undefined;
  return {
    id: String(card.ref.itemId),
    name: card.title,
    imageUrl,
    year: card.year,
    rating: card.rating,
    type: card.kind ?? 'Movie',
    serverId,
    serverType: isCatalog ? 'local' : provider,
    catalogRef: card.ref,
  };
}

function navigateForRef(navigate: (path: string) => void, ref: MediaRef): void {
  if (ref.provider === 'catalog') navigate(`/browse/${ref.sourceId}/item/${ref.itemId}`);
  else navigate(`/detail/${ref.provider}/${ref.serverId}/${ref.itemId}`);
}

export default function Search() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<MediaItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const queryTextRef = useRef('');
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const addToast = useToastStore((s) => s.addToast);
  const handleItemPlay = usePlayItem();

  const runSearch = useCallback(
    async (text: string, targetPage: number, replace: boolean): Promise<void> => {
      setLoading(true);
      setSearched(true);
      try {
        const [serverMap, res] = await Promise.all([
          getServerMap(),
          window.electronAPI.unifiedSearch(text, targetPage),
        ]);
        if (!res.ok) {
          addToast((res as { error?: { message?: string } }).error?.message ?? '搜索失败', 'error');
          return;
        }
        const data = res.data as { items?: UnifiedCard[]; page?: number; total?: number };
        const mapped = (data.items ?? []).map((card) => unifiedToMediaItem(card, serverMap));
        // 局部来源失败不阻塞：main 侧已按来源隔离，缺席来源只是没有卡。
        // load-more 跨页去重：append 前按完整 MediaRef 键过滤（页边界漂移防重）。
        if (replace) {
          setResults(mapped);
        } else {
          setResults((prev) => {
            const seen = new Set(prev.map((entry) => mediaRefKey(entry.catalogRef ?? { provider: 'jellyfin', serverId: entry.serverId ?? 0, itemId: entry.id })));
            return [...prev, ...mapped.filter((entry) => !seen.has(mediaRefKey(entry.catalogRef as MediaRef)))];
          });
        }
        setPage(data.page ?? targetPage);
        setTotal(data.total ?? 0);
      } catch (err) {
        addToast(`搜索失败: ${err instanceof Error ? err.message : '未知错误'}`, 'error');
      } finally {
        setLoading(false);
      }
    },
    [addToast]
  );

  const handleSearch = useCallback(async () => {
    const text = query.trim();
    if (!text) return;
    queryTextRef.current = text;
    setResults([]);
    setTotal(0);
    await runSearch(text, 1, true);
  }, [query, runSearch]);

  const loadMore = useCallback(async () => {
    if (!queryTextRef.current || loading) return;
    await runSearch(queryTextRef.current, page + 1, false);
  }, [loading, page, runSearch]);

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
                  key={`${item.serverType}-${item.serverId}-${item.id}`}
                  id={item.id}
                  name={item.name}
                  imageUrl={item.imageUrl}
                  year={item.year}
                  rating={item.rating}
                  type={item.type}
                  onClick={() =>
                    item.catalogRef
                      ? navigateForRef(navigate, item.catalogRef)
                      : navigate(`/detail/${item.serverType}/${item.serverId}/${item.id}`)
                  }
                  onPlay={() => handleItemPlay(item)}
                />
              ))}
            </div>
          ) : null}
          {/* 分页加载更多：≤200/页（main clamp），去重已按完整 MediaRef 完成 */}
          {results.length > 0 && results.length < total && !loading && (
            <div className="flex justify-center mt-6">
              <button
                type="button"
                onClick={() => void loadMore()}
                className="px-4 py-2 border border-border rounded-lg hover:bg-accent text-sm text-muted-foreground hover:text-foreground focus-ring"
              >
                加载更多（已显示 {results.length} / 共 {total}）
              </button>
            </div>
          )}
          {!loading && searched && results.length === 0 && (
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
