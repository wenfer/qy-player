import { useState, useCallback, useEffect, useRef } from 'react';
import { useParams, useLocation, useNavigate } from 'react-router-dom';
import { ChevronLeft, Loader2, Film, AlertCircle, Play, Search, Tv, Clapperboard } from 'lucide-react';
import PosterCard from '../../components/PosterCard';
import PosterSkeleton from '../../components/Skeleton/PosterSkeleton';
import { getServerMap, buildImageUrl } from '../../utils/server-images';
import { useToastStore } from '../../stores/toast-store';
import { usePlayItem } from '../../hooks/use-play-item';
import type { MediaItem } from '../../components/HorizontalRow';
import type { CatalogItemSummary, CatalogItemDetail } from '../../../shared/types/catalog';

const PAGE_SIZE = 60;

interface RawItem {
  Id: string;
  Name?: string;
  Type: string;
  ProductionYear?: number;
  CommunityRating?: number;
  ImageTags?: { Primary?: string };
}

// Renderer consumes the shared resolution contract (QYP2-015/016).
import type { PlaybackResolution } from '../../../shared/types/catalog';
import SubtitleManager from '../Detail/SubtitleManager';
import MetadataEditor from '../Detail/MetadataEditor';

interface ResolvedPlayback {
  ok: boolean;
  data?: PlaybackResolution;
  error?: { message: string };
}

function formatTime(seconds: number): string {
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

function ProgressBadge({ progress }: { progress: NonNullable<CatalogItemSummary['progress']> }): React.ReactNode {
  const pct = progress.duration > 0 ? Math.min(100, Math.round((progress.position / progress.duration) * 100)) : 0;
  if (progress.isFinished) {
    return <div className="mt-1 text-[10px] text-muted-foreground">已看完</div>;
  }
  if (pct <= 0) return null;
  return (
    <div className="mt-1">
      <div className="h-1 w-full bg-muted rounded-full overflow-hidden" role="progressbar" aria-valuenow={pct}>
        <div className="h-full bg-primary rounded-full" style={{ width: `${pct}%` }} />
      </div>
      <div className="text-[10px] text-muted-foreground mt-0.5">
        {formatTime(progress.position)} / {formatTime(progress.duration || 0)}
      </div>
    </div>
  );
}

/** Kind badge shared by browse rows and the detail view. */
function KindBadge({ kind }: { kind: CatalogItemSummary['kind'] }): React.ReactNode {
  const map: Record<string, { icon: React.ReactNode; label: string }> = {
    movie: { icon: <Clapperboard size={12} />, label: '电影' },
    series: { icon: <Tv size={12} />, label: '剧集' },
    video: { icon: <Film size={12} />, label: '视频' },
    season: { icon: <Tv size={12} />, label: '季' },
    episode: { icon: <Tv size={12} />, label: '单集' },
  };
  const badge = map[kind];
  if (!badge) return null;
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-muted rounded text-[10px] text-muted-foreground">
      {badge.icon}
      {badge.label}
    </span>
  );
}

/** Catalog detail view: metadata + seasons/episodes + play/resume. */
function CatalogItemDetailView({
  sourceId,
  itemId,
  onBack,
}: {
  sourceId: number;
  itemId: number;
  onBack: () => void;
}): React.ReactNode {
  const addToast = useToastStore((s) => s.addToast);
  const [detail, setDetail] = useState<CatalogItemDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const editButtonRef = useRef<HTMLButtonElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = (await window.electronAPI.getCatalogItem(sourceId, itemId)) as {
        ok: boolean;
        data?: CatalogItemDetail;
        error?: { code: string; message: string };
      };
      if (!result.ok || !result.data) {
        setError(result.error?.message ?? '条目不存在');
        setDetail(null);
      } else {
        setDetail(result.data);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '未知错误');
    } finally {
      setLoading(false);
    }
  }, [sourceId, itemId]);

  useEffect(() => {
    load();
  }, [load]);

  // Unified resolver (QYP2-016): one call covers local files and WebDAV
  // streams. When the server ignores Range, seeking is unreliable but
  // play/resume keep working — the degradation is explicit, not silent.
  const playItem = useCallback(
    async (targetId: number, startPosition?: number) => {
      setPlaying(true);
      try {
        const result = (await window.electronAPI.resolvePlayback(
          { provider: 'catalog', sourceId, itemId: String(targetId) },
          {}
        )) as ResolvedPlayback;
        if (!result.ok || !result.data) {
          addToast(result.error?.message ?? '无法播放', 'error');
          return;
        }
        const resolved = result.data;
        if (!resolved.seekable) {
          addToast('该来源不支持进度拖动，播放与续播正常', 'warning');
        }
        const resume = startPosition ?? (resolved.startPosition > 30 ? resolved.startPosition : 0);
        await window.electronAPI.playerLoadFile(
          resolved.url,
          resume,
          undefined,
          resolved.mediaContext,
          resolved.streamSessionId
        );
        addToast('开始播放', 'success');
      } catch (err) {
        addToast(`播放失败: ${err instanceof Error ? err.message : '未知错误'}`, 'error');
      } finally {
        setPlaying(false);
      }
    },
    [sourceId, addToast]
  );

  const resolveFirstChild = useCallback(
    async (children: CatalogItemSummary[], fallbackId: number): Promise<void> => {
      const target = children[0];
      await playItem(target ? Number(target.ref.itemId) : fallbackId);
    },
    [playItem]
  );

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-20" role="status">
        <Loader2 size={28} className="animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground mt-3">加载详情中…</p>
      </div>
    );
  }
  if (error || !detail) {
    return (
      <div className="flex flex-col items-center justify-center py-20" role="alert">
        <AlertCircle size={36} className="text-muted-foreground mb-3" />
        <p className="text-sm text-muted-foreground mb-4">{error ?? '无法加载详情'}</p>
        <button onClick={load} className="px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm focus-ring">
          重试
        </button>
      </div>
    );
  }

  const { item, metadata, children, progress } = detail;
  const seasons = children.filter((c) => c.kind === 'season');
  const episodes = children.filter((c) => c.kind === 'episode');
  const seriesItem = seasons.length > 0 ? detail : null;

  return (
    <div className="p-8 max-w-4xl">
      <button
        onClick={onBack}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors focus-ring rounded-md py-1 mb-6"
      >
        <ChevronLeft size={16} />
        返回
      </button>

      <div className="flex gap-6">
        <div className="flex-shrink-0 w-32 aspect-[2/3] rounded-xl bg-card border border-border flex items-center justify-center">
          <Film size={36} className="text-muted-foreground/30" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-2">
            <KindBadge kind={item.kind} />
            {item.availability === 'missing' && (
              <span className="px-1.5 py-0.5 rounded text-[10px] bg-destructive/10 text-destructive">已缺失</span>
            )}
          </div>
          <h1 className="text-2xl font-bold tracking-tight break-words">{item.title}</h1>
          {metadata.originalTitle && metadata.originalTitle !== item.title && (
            <p className="text-sm text-muted-foreground mt-1">{metadata.originalTitle}</p>
          )}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-3 text-sm text-muted-foreground">
            {item.year && <span>{item.year}</span>}
            {item.rating !== undefined && <span className="text-yellow-500">★ {item.rating.toFixed(1)}</span>}
            {metadata.runtime && <span>{metadata.runtime} 分钟</span>}
            {metadata.contentRating && <span className="px-1.5 border border-border rounded text-xs">{metadata.contentRating}</span>}
          </div>
          {metadata.tagline && <p className="text-sm text-muted-foreground italic mt-3">{metadata.tagline}</p>}
          {metadata.plot && <p className="text-sm text-muted-foreground leading-relaxed mt-3">{metadata.plot}</p>}
          {metadata.genres && metadata.genres.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-3">
              {metadata.genres.map((g) => (
                <span key={g} className="px-2 py-0.5 bg-muted rounded text-xs text-muted-foreground">{g}</span>
              ))}
            </div>
          )}
          {metadata.actors && metadata.actors.length > 0 && (
            <p className="text-xs text-muted-foreground mt-3">主演：{metadata.actors.slice(0, 5).map((a) => a.name).join('、')}</p>
          )}
          {metadata.directors && metadata.directors.length > 0 && (
            <p className="text-xs text-muted-foreground mt-1">导演：{metadata.directors.join('、')}</p>
          )}
        </div>
      </div>

      <button
        onClick={() =>
          seasons.length > 0
            ? resolveFirstChild(seasons[0].kind === 'season' ? episodesOfFirstSeason(detail) : seasons, item.ref.itemId ? Number(item.ref.itemId) : 0)
            : playItem(Number(item.ref.itemId), progress && !progress.isFinished ? progress.position : undefined)
        }
        disabled={playing || item.availability === 'missing'}
        className="mt-6 flex items-center justify-center gap-2 px-6 py-2.5 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors focus-ring text-sm font-medium disabled:opacity-50"
      >
        {playing ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} fill="currentColor" />}
        {progress && !progress.isFinished && progress.position > 30 ? `续播 ${formatTime(progress.position)}` : '立即播放'}
      </button>
      <button
        ref={editButtonRef}
        type="button"
        onClick={() => setEditorOpen(true)}
        className="w-full mt-2 flex items-center justify-center px-3 py-2 border border-border rounded-lg hover:bg-accent transition-colors focus-ring text-xs text-muted-foreground hover:text-foreground"
      >
        编辑元数据
      </button>
      <MetadataEditor
        itemId={Number(item.ref.itemId)}
        open={editorOpen}
        onClose={() => {
          setEditorOpen(false);
          // Dialog close returns focus to the opener (a11y).
          editButtonRef.current?.focus();
          load();
        }}
      />

      {/* QYP2-021: sidecar + imported subtitles, one list; playback
          injection happens main-side after loadFile. Containers (series/
          season) carry no media file, so subtitles make no sense there. */}
      {(item.kind === 'movie' || item.kind === 'episode') && (
        <SubtitleManager itemId={Number(item.ref.itemId)} />
      )}

      {seriesItem && seasons.length > 0 && (
        <div className="mt-8">
          <h3 className="text-sm font-semibold mb-3">季与集</h3>
          {seasons.map((season) => (
            <div key={season.ref.itemId} className="mb-5">
              <div className="text-sm font-medium text-muted-foreground mb-2">
                {season.title}
                {season.progress && !season.progress.isFinished && season.progress.position > 30 && (
                  <span className="ml-2 text-xs">（看到 {formatTime(season.progress.position)}）</span>
                )}
              </div>
              <div className="grid grid-cols-4 sm:grid-cols-6 md:grid-cols-8 gap-2">
                {episodes
                  .filter((ep) => ep.seasonNumber === season.seasonNumber)
                  .map((ep) => (
                    <button
                      key={ep.ref.itemId}
                      onClick={() => playItem(Number(ep.ref.itemId), ep.progress && !ep.progress.isFinished ? ep.progress.position : undefined)}
                      className="relative aspect-[16/10] rounded-lg bg-card border border-border hover:border-primary/40 transition-colors p-2 text-left focus-ring"
                    >
                      <div className="text-lg font-bold text-muted-foreground/40">{ep.episodeNumber}</div>
                      <div className="text-[11px] line-clamp-2 leading-snug">{ep.title}</div>
                      {ep.progress && !ep.progress.isFinished && (
                        <div className="absolute bottom-0 left-0 right-0 h-1 bg-muted">
                          <div
                            className="h-full bg-primary"
                            style={{ width: `${ep.progress.duration > 0 ? Math.min(100, (ep.progress.position / ep.progress.duration) * 100) : 0}%` }}
                          />
                        </div>
                      )}
                    </button>
                  ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Episodes belonging to the first season of a detail payload. */
function episodesOfFirstSeason(detail: CatalogItemDetail): CatalogItemSummary[] {
  const firstSeason = detail.children.find((c) => c.kind === 'season');
  if (!firstSeason) return detail.children;
  return detail.children.filter((c) => c.kind === 'episode' && c.seasonNumber === firstSeason.seasonNumber);
}

export default function LibraryBrowse() {
  const { serverId, viewId, sourceId: sourceIdParam, itemId: itemParam } = useParams<{
    serverId: string;
    viewId: string;
    sourceId: string;
    itemId: string;
  }>();
  const location = useLocation();
  const navigate = useNavigate();
  const addToast = useToastStore((s) => s.addToast);
  const handleItemPlay = usePlayItem();

  const isCatalog = sourceIdParam !== undefined;
  const catalogSourceId = isCatalog ? Number(sourceIdParam) : 0;
  const catalogItemId = itemParam !== undefined ? Number(itemParam) : null;

  const libraryName = (location.state as { name?: string } | null)?.name || '媒体库';
  const sourceName = (location.state as { name?: string } | null)?.name;

  const [items, setItems] = useState<MediaItem[]>([]);
  const [initialLoading, setInitialLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchText, setSearchText] = useState('');
  const [searching, setSearching] = useState(false);
  const startIndexRef = useRef(0);
  const catalogPageRef = useRef(1);
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

  // Catalog browse: paged, parent-scoped listing with progress overlay.
  const loadCatalogPage = useCallback(
    async (replace: boolean, nextPage?: number) => {
      if (!isCatalog) return;
      const target = replace ? 1 : (nextPage ?? catalogPageRef.current + 1);
      if (replace) {
        setInitialLoading(true);
        catalogPageRef.current = 1;
      } else {
        setLoadingMore(true);
      }
      setError(null);
      try {
        const result = (await window.electronAPI.browseCatalog({
          sourceId: catalogSourceId,
          parentId: null,
          page: target,
          pageSize: PAGE_SIZE,
        })) as { ok: boolean; data?: { items: CatalogItemSummary[]; nextCursor?: string }; error?: { message: string } };
        if (!result.ok || !result.data) {
          throw new Error(result.error?.message ?? '加载失败');
        }
        const summaries = result.data.items;
        const mapped: MediaItem[] = summaries.map((s) => ({
          id: s.ref.itemId,
          name: s.title,
          imageUrl: undefined,
          year: s.year,
          rating: s.rating,
          type: s.kind === 'series' ? 'Series' : s.kind === 'movie' ? 'Movie' : 'Video',
          serverId: 0,
          serverType: 'local' as const,
          catalogRef: s.ref,
          catalogProgress: s.progress,
        }));
        setItems((prev) => (replace ? mapped : [...prev, ...mapped]));
        setHasMore(result.data.nextCursor !== undefined);
        if (replace || result.data.items.length > 0) catalogPageRef.current = target;
      } catch (err) {
        const msg = err instanceof Error ? err.message : '未知错误';
        setError(msg);
        if (!replace) addToast(`加载失败: ${msg}`, 'error');
      } finally {
        setInitialLoading(false);
        setLoadingMore(false);
      }
    },
    [isCatalog, catalogSourceId, addToast]
  );

  const runCatalogSearch = useCallback(
    async (text: string) => {
      if (!isCatalog || !text.trim()) return;
      setSearching(true);
      setError(null);
      setInitialLoading(true);
      try {
        const result = (await window.electronAPI.searchCatalog({
          sourceId: catalogSourceId,
          query: text.trim(),
          pageSize: PAGE_SIZE,
        })) as { ok: boolean; data?: { items: CatalogItemSummary[] }; error?: { message: string } };
        if (!result.ok || !result.data) throw new Error(result.error?.message ?? '搜索失败');
        const summaries = result.data.items;
        setItems(
          summaries.map((s) => ({
            id: s.ref.itemId,
            name: s.title,
            imageUrl: undefined,
            year: s.year,
            rating: s.rating,
            type: s.kind === 'series' ? 'Series' : s.kind === 'movie' ? 'Movie' : 'Video',
            serverId: 0,
            serverType: 'local' as const,
            catalogRef: s.ref,
          }))
        );
        setHasMore(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : '未知错误');
      } finally {
        setSearching(false);
        setInitialLoading(false);
      }
    },
    [isCatalog, catalogSourceId]
  );

  useEffect(() => {
    if (isCatalog) {
      if (catalogItemId === null) loadCatalogPage(true);
    } else {
      loadPage(true);
    }
  }, [isCatalog, catalogItemId, loadCatalogPage, loadPage]);

  const handleCatalogItemClick = useCallback(
    (item: MediaItem) => {
      if (!item.catalogRef) return;
      navigate(`/browse/${sourceIdParam}/item/${item.catalogRef.itemId}`, {
        state: { name: item.name },
      });
    },
    [navigate, sourceIdParam]
  );

  const handleCatalogPlay = useCallback(
    async (item: MediaItem) => {
      if (!item.catalogRef) return;
      try {
        const result = (await window.electronAPI.resolvePlayback(item.catalogRef, {})) as ResolvedPlayback;
        if (!result.ok || !result.data) {
          addToast(result.error?.message ?? '无法播放', 'error');
          return;
        }
        if (!result.data.seekable) {
          addToast('该来源不支持进度拖动，播放与续播正常', 'warning');
        }
        const resume = result.data.startPosition > 30 ? result.data.startPosition : 0;
        await window.electronAPI.playerLoadFile(
          result.data.url,
          resume,
          undefined,
          result.data.mediaContext,
          result.data.streamSessionId
        );
        addToast('开始播放', 'success');
      } catch (err) {
        addToast(`播放失败: ${err instanceof Error ? err.message : '未知错误'}`, 'error');
      }
    },
    [addToast]
  );

  const handleItemClick = useCallback(
    (item: MediaItem) => {
      if (item.serverType === 'local') {
        handleCatalogItemClick(item);
      } else {
        navigate(`/detail/${item.serverType}/${item.serverId}/${item.id}`);
      }
    },
    [handleCatalogItemClick, navigate]
  );

  const handlePlayClick = useCallback(
    (item: MediaItem) => {
      if (item.serverType === 'local') {
        void handleCatalogPlay(item);
      } else {
        void handleItemPlay(item);
      }
    },
    [handleCatalogPlay, handleItemPlay]
  );

  // Catalog detail view takes over the whole page.
  if (isCatalog && catalogItemId !== null) {
    return (
      <CatalogItemDetailView
        sourceId={catalogSourceId}
        itemId={catalogItemId}
        onBack={() => navigate(`/browse/${sourceIdParam}`)}
      />
    );
  }

  const heading = isCatalog ? (sourceName ?? '本地媒体库') : libraryName;

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
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight truncate">{heading}</h1>
          {items.length > 0 && (
            <p className="text-xs text-muted-foreground mt-0.5">已加载 {items.length} 项</p>
          )}
        </div>
        {isCatalog && (
          <form
            className="ml-auto flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (searchText.trim()) runCatalogSearch(searchText);
            }}
          >
            <input
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              placeholder="在媒体库中搜索…"
              aria-label="在媒体库中搜索"
              className="w-48 px-3 py-1.5 bg-card border border-border rounded-lg text-sm focus-ring placeholder:text-muted-foreground"
            />
            <button
              type="submit"
              disabled={searching || !searchText.trim()}
              className="flex items-center gap-1.5 px-3 py-1.5 border border-border rounded-lg hover:bg-accent transition-colors text-sm focus-ring disabled:opacity-50"
              aria-label="搜索"
            >
              {searching ? <Loader2 size={13} className="animate-spin" /> : <Search size={13} />}
              搜索
            </button>
          </form>
        )}
      </header>

      {error && (
        <div className="flex flex-col items-center justify-center py-20" role="alert">
          <AlertCircle size={40} className="text-muted-foreground mb-3" />
          <p className="text-sm text-muted-foreground mb-4">{error}</p>
          <button
            onClick={() => (isCatalog ? loadCatalogPage(true) : loadPage(true))}
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
          <p className="text-sm text-muted-foreground">
            {isCatalog ? '该来源尚未扫描或暂无内容' : '该媒体库暂无内容'}
          </p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-3 md:grid-cols-5 lg:grid-cols-6 gap-x-4 gap-y-6">
            {items.map((item) => (
              <div key={item.id} className="min-w-0">
                <PosterCard
                  id={item.id}
                  name={item.name}
                  imageUrl={item.imageUrl}
                  year={item.year}
                  rating={item.rating}
                  type={item.type}
                  onClick={() => handleItemClick(item)}
                  onPlay={() => handlePlayClick(item)}
                />
                {item.serverType === 'local' && item.catalogProgress && (
                  <ProgressBadge progress={item.catalogProgress} />
                )}
              </div>
            ))}
          </div>

          {hasMore && (
            <div className="flex justify-center mt-8">
              <button
                onClick={() => (isCatalog ? loadCatalogPage(false) : loadPage(false))}
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
