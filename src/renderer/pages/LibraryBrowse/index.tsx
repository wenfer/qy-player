import { useState, useCallback, useEffect, useRef } from 'react';
import { useParams, useLocation, useNavigate } from 'react-router-dom';
import { ChevronLeft, Loader2, Film, AlertCircle } from 'lucide-react';
import PosterCard from '../../components/PosterCard';
import PosterSkeleton from '../../components/Skeleton/PosterSkeleton';
import { getServerMap, buildImageUrl } from '../../utils/server-images';
import { useToastStore } from '../../stores/toast-store';
import { usePlayItem } from '../../hooks/use-play-item';
import type { MediaItem } from '../../components/HorizontalRow';

const PAGE_SIZE = 40;

interface RawItem {
  Id: string;
  Name?: string;
  Type: string;
  ProductionYear?: number;
  CommunityRating?: number;
  ImageTags?: { Primary?: string };
}

export default function LibraryBrowse() {
  const { serverId, viewId } = useParams<{ serverId: string; viewId: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const addToast = useToastStore((s) => s.addToast);
  const handleItemPlay = usePlayItem();

  const libraryName =
    (location.state as { name?: string } | null)?.name || '媒体库';

  const [items, setItems] = useState<MediaItem[]>([]);
  const [initialLoading, setInitialLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const startIndexRef = useRef(0);
  const serverMapRef = useRef<Map<number, import('../../utils/server-images').ServerEntry>>(new Map());

  const mapItem = useCallback(
    (item: RawItem): MediaItem => {
      const server = serverMapRef.current.get(Number(serverId));
      const serverType = server?.type || 'jellyfin';
      return {
        id: item.Id,
        name: item.Name || '未知',
        imageUrl: buildImageUrl(
          serverMapRef.current,
          Number(serverId),
          serverType,
          item.Id,
          'Primary',
          item.ImageTags?.Primary
        ),
        year: item.ProductionYear,
        rating: item.CommunityRating,
        type: item.Type,
        serverId: Number(serverId),
        serverType,
      };
    },
    [serverId]
  );

  const loadPage = useCallback(
    async (replace: boolean) => {
      if (!serverId || !viewId) return;
      if (replace) {
        setInitialLoading(true);
        startIndexRef.current = 0;
      } else {
        setLoadingMore(true);
      }
      setError(null);
      try {
        serverMapRef.current = await getServerMap();
        const data = await window.electronAPI.getItems(viewId, {
          sortBy: 'SortName',
          sortOrder: 'Ascending',
          limit: PAGE_SIZE,
          startIndex: startIndexRef.current,
        });
        const page = (data as RawItem[]).map(mapItem);
        setItems((prev) => (replace ? page : [...prev, ...page]));
        setHasMore(page.length === PAGE_SIZE);
        startIndexRef.current += page.length;
      } catch (err) {
        const msg = err instanceof Error ? err.message : '未知错误';
        setError(msg);
        if (!replace) addToast(`加载失败: ${msg}`, 'error');
      } finally {
        setInitialLoading(false);
        setLoadingMore(false);
      }
    },
    [serverId, viewId, mapItem, addToast]
  );

  useEffect(() => {
    loadPage(true);
  }, [loadPage]);

  const handleItemClick = useCallback(
    (item: MediaItem) => {
      navigate(`/detail/${item.serverType}/${item.id}`);
    },
    [navigate]
  );

  return (
    <div className="p-8">
      <header className="flex items-center gap-4 mb-8">
        <button
          onClick={() => navigate(-1)}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors focus-ring rounded-md py-1"
        >
          <ChevronLeft size={16} />
          返回
        </button>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{libraryName}</h1>
          {items.length > 0 && (
            <p className="text-xs text-muted-foreground mt-0.5">已加载 {items.length} 项</p>
          )}
        </div>
      </header>

      {error && (
        <div className="flex flex-col items-center justify-center py-20" role="alert">
          <AlertCircle size={40} className="text-muted-foreground mb-3" />
          <p className="text-sm text-muted-foreground mb-4">{error}</p>
          <button
            onClick={() => loadPage(true)}
            className="px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors text-sm focus-ring"
          >
            重试
          </button>
        </div>
      )}

      {initialLoading ? (
        <PosterSkeleton count={12} />
      ) : !error && items.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20">
          <Film size={40} className="text-muted-foreground/40 mb-3" />
          <p className="text-sm text-muted-foreground">该媒体库暂无内容</p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-3 md:grid-cols-5 lg:grid-cols-6 gap-x-4 gap-y-6">
            {items.map((item) => (
              <PosterCard
                key={item.id}
                id={item.id}
                name={item.name}
                imageUrl={item.imageUrl}
                year={item.year}
                rating={item.rating}
                type={item.type}
                onClick={() => handleItemClick(item)}
                onPlay={() => handleItemPlay(item)}
              />
            ))}
          </div>

          {hasMore && (
            <div className="flex justify-center mt-8">
              <button
                onClick={() => loadPage(false)}
                disabled={loadingMore}
                className="flex items-center gap-2 px-5 py-2.5 border border-border rounded-lg hover:bg-accent transition-colors text-sm focus-ring disabled:opacity-50"
              >
                {loadingMore && <Loader2 size={14} className="animate-spin" />}
                {loadingMore ? '加载中…' : '加载更多'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
