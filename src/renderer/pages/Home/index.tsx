import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ServerOff,
  RefreshCw,
  Film,
  AlertCircle,
  Tv,
  Music,
  FolderOpen,
  Clapperboard,
  LayoutGrid,
  Server,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import HorizontalRow from '../../components/HorizontalRow';
import RowSkeleton from '../../components/Skeleton/RowSkeleton';
import { useToastStore } from '../../stores/toast-store';
import { getServerMap, buildImageUrl, buildItemImageUrl, type ServerMediaItemLike } from '../../utils/server-images';
import { mediaTypeFromKind } from '../../utils/media-card';
import { usePlayItem } from '../../hooks/use-play-item';
import type { MediaItem } from '../../components/HorizontalRow';
import type { UnifiedCard } from '../../../main/modules/catalog/unified-query';
import type { MediaRef } from '../../../shared/types/catalog';
import {
  getCachedHomeData,
  setCachedHomeData,
  type CachedLibraryRow,
} from '../../utils/media-cache';

/**
 * QYP2-036: 统一卡片 → MediaItem 适配。catalog 卡走 /browse 路由 +
 * catalogRef 播放（use-play-item 已支持）；在线卡保持原 /detail 路由。
 * 海报只按来源拼 URL；目录卡暂无 tag → 占位（不臆造 URL）。
 */
function unifiedToMediaItem(card: UnifiedCard, serverMap: ReturnType<typeof getServerMap> extends Promise<infer M> ? M : never): MediaItem {
  const isCatalog = card.ref.provider === 'catalog';
  const provider = card.ref.provider;
  const serverId =
    card.ref.provider === 'catalog' || card.ref.provider === 'music'
      ? card.ref.sourceId
      : card.ref.serverId;
  const imageUrl =
    !isCatalog && card.poster?.tag
      ? buildImageUrl(serverMap, serverId, provider, card.poster?.itemId || card.ref.itemId, 'Primary', card.poster.tag)
      : undefined;
  return {
    id: String(card.ref.itemId),
    name: card.title,
    imageUrl,
    year: card.year,
    rating: card.rating,
    // 在线来源的 kind 是 Jellyfin 的大小写混合（Episode/Series），本地是小写
    // ——必须走归一，否则单集会被兜底成 Movie（剧集卡挂"电影"角标）
    type: mediaTypeFromKind(card.kind),
    serverId,
    serverType: isCatalog ? 'local' : provider,
    catalogRef: card.ref,
    ...(card.seriesName ? { seriesName: card.seriesName } : {}),
    ...(card.seasonNumber != null ? { seasonNumber: card.seasonNumber } : {}),
    ...(card.episodeNumber != null ? { episodeNumber: card.episodeNumber } : {}),
    ...(card.position != null && card.duration
      ? {
          catalogProgress: { position: card.position, duration: card.duration, isFinished: card.isFinished ?? false },
          // PosterCard 渲染 0–1 比例（统一后两来源都恢复进度条）
          progress: Math.min(1, Math.max(0, card.position / card.duration)),
        }
      : {}),
    dateCreated: card.updatedAt ? new Date(card.updatedAt).toISOString() : undefined,
  };
}

function navigateForRef(navigate: (path: string) => void, ref: MediaRef): void {
  if (ref.provider === 'catalog' || ref.provider === 'music') {
    navigate(`/browse/${ref.sourceId}/item/${ref.itemId}`);
  } else {
    navigate(`/detail/${ref.provider}/${ref.serverId}/${ref.itemId}`);
  }
}

interface ServerInfo {
  id: number;
  name: string;
  type: string;
  base_url: string;
  is_active: number;
}

interface LibraryResult {
  serverId: number;
  serverName: string;
  serverType: string;
  baseUrl: string;
  views: Array<Record<string, unknown>>;
  error?: string;
}

type LibraryRow = CachedLibraryRow;

const HOME_SELECTED_SERVER_KEY = 'qy_home_selected_server';

const COLLECTION_ICONS: Record<string, LucideIcon> = {
  movies: Clapperboard,
  tvshows: Tv,
  music: Music,
};

function LibraryCard({
  title,
  count,
  collectionType,
  imageUrl,
  thumbUrl,
  onClick,
}: {
  title: string;
  count?: number;
  collectionType: string;
  imageUrl?: string;
  thumbUrl?: string;
  onClick: () => void;
}) {
  const Icon = COLLECTION_ICONS[collectionType] || FolderOpen;
  // Landscape thumb composes far better on a 16:9 card than a cropped poster
  const bg = thumbUrl || imageUrl;
  return (
    <button
      onClick={onClick}
      className="group relative aspect-[16/9] rounded-xl overflow-hidden bg-card border border-border transition-colors duration-150 hover:border-primary/40 card-lift focus-ring text-left"
      aria-label={`打开媒体库 ${title}${count ? `，共 ${count} 部影片` : ''}`}
    >
      {bg ? (
        <img
          src={bg}
          alt=""
          className="absolute inset-0 w-full h-full object-cover opacity-60 group-hover:opacity-85 transition-opacity duration-200"
        />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center bg-secondary">
          <Icon size={32} className="text-muted-foreground/40" />
        </div>
      )}
      <div className="absolute inset-0 bg-gradient-to-t from-background via-background/60 to-transparent" />
      <div className="absolute bottom-0 left-0 right-0 p-3">
        <div className="font-semibold text-sm truncate drop-shadow">{title}</div>
        <div className="text-xs text-muted-foreground">
          {count != null && count > 0 ? `${count} 部影片` : '媒体库'}
        </div>
      </div>
    </button>
  );
}

export default function Home() {
  const cached = useRef(getCachedHomeData()).current;
  const [continueWatching, setContinueWatching] = useState<MediaItem[]>(
    () => cached?.continueWatching || []
  );
  const [libraryRows, setLibraryRows] = useState<LibraryRow[]>(
    () => cached?.libraryRows || []
  );
  const [recentlyAdded, setRecentlyAdded] = useState<MediaItem[]>(
    () => cached?.recentAdditions || []
  );
  const hasCache = !!(cached?.libraryRows?.length || cached?.continueWatching?.length);
  const [loading, setLoading] = useState(!hasCache);
  const [error, setError] = useState<string | null>(null);
  const [servers, setServers] = useState<ServerInfo[]>([]);
  const [libraryErrors, setLibraryErrors] = useState<string[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  // 服务端切换状态（记住上次选中的服务器）
  const [selectedServerId, setSelectedServerId] = useState<string>(() => {
    try {
      return localStorage.getItem(HOME_SELECTED_SERVER_KEY) || 'all';
    } catch {
      return 'all';
    }
  });

  const navigate = useNavigate();
  const addToast = useToastStore((s) => s.addToast);
  // Re-entrancy guard: focus/eof/manual refresh can overlap otherwise,
  // causing interleaved setState and duplicated backend requests.
  const loadingRef = useRef(false);

  // 保持对动态 state 的 ref 引用，避免成为 useCallback 不稳定依赖
  const libraryRowsRef = useRef(libraryRows);
  libraryRowsRef.current = libraryRows;
  const continueWatchingRef = useRef(continueWatching);
  continueWatchingRef.current = continueWatching;
  const selectedServerIdRef = useRef(selectedServerId);
  selectedServerIdRef.current = selectedServerId;

  const loadData = useCallback(async (opts?: { silent?: boolean; serverId?: string }) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    if (opts?.silent) {
      setRefreshing(true); // background refresh: keep existing content visible
    } else if (!hasCache) {
      setLoading(true);
    }
    setError(null);
    setLibraryErrors([]);
    try {
      const serverList = await window.electronAPI.getServers();
      const activeServers = (serverList as ServerInfo[]).filter((s) => s.is_active);
      setServers(activeServers);
      const serverMap = await getServerMap();

      if (activeServers.length === 0) {
        setLoading(false);
        return;
      }

      // 确定当前请求的目标服务器（若选定的 ID 不在激活列表中，回退到 'all'）
      const currentSelected = opts?.serverId ?? selectedServerIdRef.current;
      let effectiveServerId = currentSelected;
      if (currentSelected !== 'all') {
        const numId = Number(currentSelected);
        if (!activeServers.some((s) => s.id === numId)) {
          effectiveServerId = 'all';
          setSelectedServerId('all');
          try {
            localStorage.setItem(HOME_SELECTED_SERVER_KEY, 'all');
          } catch {
            // ignore
          }
        }
      }

      // 统一继续观看（QYP2-036）：目录 + 在线合并、MediaRef 去重、
      // 来源局部失败不阻塞（隔离在 main 侧 isolateSource）。
      let cwItems: MediaItem[] = [];
      let recentItems: MediaItem[] = [];
      try {
        const cw = (await window.electronAPI.unifiedContinueWatching(40)) as {
          ok: boolean;
          data?: UnifiedCard[];
        };
        cwItems = cw.ok ? (cw.data ?? []).map((card) => unifiedToMediaItem(card, serverMap)) : [];
      } catch {
        // 继续观看可选，失败不阻塞首页
      }
      try {
        const recent = (await window.electronAPI.unifiedRecent(24)) as {
          ok: boolean;
          data?: UnifiedCard[];
        };
        recentItems = recent.ok ? (recent.data ?? []).map((card) => unifiedToMediaItem(card, serverMap)) : [];
      } catch {
        // 最近添加可选
      }

      // 媒体库：若指定目标服务器，仅请求目标服务器的视图，避免并发全量拉取或被故障服务器阻塞
      const targetServerNum = effectiveServerId !== 'all' ? Number(effectiveServerId) : undefined;
      const rows: LibraryRow[] = [];
      const libs = (await window.electronAPI.getLibraries(targetServerNum)) as LibraryResult[];
      const errors: string[] = [];
      for (const lib of libs) {
        if (lib.error) {
          errors.push(`${lib.serverName}: ${lib.error}`);
          continue;
        }
        const libServerMap = new Map(
          activeServers.filter((s) => s.id === lib.serverId).map((s) => [s.id, s])
        );
        for (const view of lib.views) {
          const viewImageUrl = buildItemImageUrl(
            libServerMap,
            lib.serverId,
            lib.serverType,
            view as ServerMediaItemLike,
            'Primary',
            500
          );
          const viewThumbUrl = buildItemImageUrl(
            libServerMap,
            lib.serverId,
            lib.serverType,
            view as ServerMediaItemLike,
            'Thumb',
            800
          );
          rows.push({
            viewId: `${lib.serverId}-${view.Id}`,
            rawViewId: view.Id as string,
            serverId: lib.serverId,
            title: (view.Name as string) || lib.serverName || '未命名媒体库',
            collectionType: (view.CollectionType as string) || '',
            viewImageUrl,
            viewThumbUrl,
            items: [],
          });
        }
      }
      if (errors.length > 0) {
        setLibraryErrors(errors);
      }

      // Replace state in one pass (never append - fixes duplicate keys)
      setContinueWatching(cwItems);
      setLibraryRows(rows);
      setRecentlyAdded(recentItems);

      // 仅在全部服务器模式下持久化 SWR 缓存
      if (effectiveServerId === 'all') {
        setCachedHomeData({
          continueWatching: cwItems,
          recentAdditions: recentItems,
          libraryRows: rows,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : '未知错误';
      if (!libraryRowsRef.current.length && !continueWatchingRef.current.length) {
        setError(msg);
        addToast(`加载数据失败: ${msg}`, 'error');
      }
    } finally {
      loadingRef.current = false;
      setLoading(false);
      setRefreshing(false);
    }
  }, [addToast, hasCache]);

  const handleSelectServer = useCallback(
    (idStr: string) => {
      setSelectedServerId(idStr);
      try {
        localStorage.setItem(HOME_SELECTED_SERVER_KEY, idStr);
      } catch {
        // ignore
      }
      void loadData({ serverId: idStr, silent: true });
    },
    [loadData]
  );

  useEffect(() => {
    loadData();

    // Background refresh when window regains focus (user returns from MPV).
    // Silent: keeps current content visible instead of flashing skeletons.
    const onFocus = () => loadData({ silent: true });
    window.addEventListener('focus', onFocus);

    // Refresh when playback ends
    let unsubscribe: (() => void) | undefined;
    if (window.electronAPI) {
      unsubscribe = window.electronAPI.onPlayerStateChange((state: unknown) => {
        const s = state as Record<string, unknown>;
        if (s.eof === true) {
          loadData({ silent: true });
        }
      });
    }

    return () => {
      window.removeEventListener('focus', onFocus);
      unsubscribe?.();
    };
  }, [loadData]);

  const handleItemClick = useCallback(
    (item: MediaItem) => {
      if (item.catalogRef) {
        navigateForRef(navigate, item.catalogRef);
      } else {
        navigate(`/detail/${item.serverType}/${item.serverId}/${item.id}`);
      }
    },
    [navigate]
  );

  const handleItemPlay = usePlayItem();

  // 根据当前选中的服务器过滤展示
  const displayedLibraryRows = useMemo(() => {
    if (selectedServerId === 'all') return libraryRows;
    const srvId = Number(selectedServerId);
    return libraryRows.filter((r) => r.serverId === srvId);
  }, [libraryRows, selectedServerId]);

  const displayedContinueWatching = useMemo(() => {
    if (selectedServerId === 'all') return continueWatching;
    const srvId = Number(selectedServerId);
    return continueWatching.filter((it) => it.serverId === srvId);
  }, [continueWatching, selectedServerId]);

  const displayedRecentlyAdded = useMemo(() => {
    if (selectedServerId === 'all') return recentlyAdded;
    const srvId = Number(selectedServerId);
    return recentlyAdded.filter((it) => it.serverId === srvId);
  }, [recentlyAdded, selectedServerId]);

  // Loading state with skeletons
  if (loading) {
    return (
      <div className="p-8 max-w-6xl">
        <div className="h-8 bg-muted rounded animate-pulse w-48 mb-8" />
        <RowSkeleton count={6} />
        <RowSkeleton count={6} />
        <RowSkeleton count={6} />
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] px-8" role="alert">
        <ServerOff size={48} className="text-muted-foreground mb-4" />
        <h2 className="text-lg font-semibold mb-2">加载失败</h2>
        <p className="text-muted-foreground text-sm mb-6 text-center max-w-md">{error}</p>
        <button
          onClick={() => loadData()}
          className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors focus-ring"
        >
          <RefreshCw size={16} />
          重试
        </button>
      </div>
    );
  }

  // Empty state - no servers configured
  if (servers.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] px-8">
        <Film size={48} className="text-muted-foreground mb-4" />
        <h2 className="text-lg font-semibold mb-2">尚未配置媒体服务器</h2>
        <p className="text-muted-foreground text-sm mb-6 text-center max-w-sm">
          添加 Jellyfin 或 Emby 服务器以浏览您的媒体库
        </p>
        <button
          onClick={() => navigate('/media-sources')}
          className="px-5 py-2.5 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors focus-ring font-medium"
        >
          前往媒体库
        </button>
      </div>
    );
  }

  // Content state
  const hasContent =
    displayedContinueWatching.length > 0 ||
    displayedLibraryRows.length > 0 ||
    displayedRecentlyAdded.length > 0;

  return (
    <div className="p-8 max-w-none">
      <header className="mb-8 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">首页</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {servers.length > 0 && `已连接 ${servers.length} 个服务器`}
          </p>
        </div>
        <button
          onClick={() => {
            void loadData({ silent: servers.length > 0 });
          }}
          className="flex items-center gap-1.5 px-3 py-2 text-sm border border-border rounded-lg hover:bg-accent transition-colors duration-150 focus-ring"
          aria-label="刷新媒体库"
        >
          <RefreshCw size={15} className={refreshing ? 'animate-spin' : ''} />
          {refreshing ? '刷新中…' : '刷新'}
        </button>
      </header>

      {libraryErrors.length > 0 && (
        <div className="mb-6 space-y-2" role="alert">
          {libraryErrors.map((e, i) => (
            <div
              key={i}
              className="flex items-center gap-2.5 p-3 bg-card border border-border text-foreground rounded-xl text-sm"
            >
              <AlertCircle size={16} className="text-amber-400 flex-shrink-0" />
              <span className="flex-1">{e}</span>
              <button
                onClick={() => navigate('/media-sources')}
                className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2 hover:no-underline flex-shrink-0 transition-colors"
              >
                前往媒体库
              </button>
            </div>
          ))}
        </div>
      )}

      {/* 服务端切换标签栏：多于 1 个服务器时展示 */}
      {servers.length > 1 && (
        <nav className="flex flex-wrap items-center gap-2 mb-8" role="tablist" aria-label="服务端切换">
          <button
            type="button"
            role="tab"
            aria-selected={selectedServerId === 'all'}
            onClick={() => handleSelectServer('all')}
            className={`flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium rounded-lg border transition-colors duration-150 focus-ring ${
              selectedServerId === 'all'
                ? 'bg-secondary border-border text-foreground font-semibold shadow-sm'
                : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-accent/60'
            }`}
          >
            <LayoutGrid size={13} />
            全部
          </button>
          {servers.map((srv) => {
            const isSelected = selectedServerId === String(srv.id);
            return (
              <button
                key={srv.id}
                type="button"
                role="tab"
                aria-selected={isSelected}
                onClick={() => handleSelectServer(String(srv.id))}
                className={`flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium rounded-lg border transition-colors duration-150 focus-ring ${
                  isSelected
                    ? 'bg-secondary border-border text-foreground font-semibold shadow-sm'
                    : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-accent/60'
                }`}
              >
                <Server size={13} />
                {srv.name}
              </button>
            );
          })}
        </nav>
      )}

      {hasContent ? (
        <>
          {/* 媒体库分类入口卡片 */}
          {displayedLibraryRows.length > 0 && (
            <section className="mb-10" aria-label="媒体库分类">
              <h2 className="text-sm font-semibold text-muted-foreground mb-4">
                媒体库
              </h2>
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                {displayedLibraryRows.map((row) => (
                  <LibraryCard
                    key={row.viewId}
                    title={row.title}
                    collectionType={row.collectionType}
                    imageUrl={row.viewImageUrl}
                    thumbUrl={row.viewThumbUrl}
                    onClick={() =>
                      navigate(`/library/${row.serverId}/${encodeURIComponent(row.rawViewId)}`, {
                        state: { name: row.title, collectionType: row.collectionType },
                      })
                    }
                  />
                ))}
              </div>
            </section>
          )}

          {displayedContinueWatching.length > 0 && (
            <HorizontalRow
              title="继续观看"
              items={displayedContinueWatching}
              onItemClick={handleItemClick}
              onItemPlay={handleItemPlay}
            />
          )}
          {displayedRecentlyAdded.length > 0 && (
            <HorizontalRow
              title="最近添加"
              items={displayedRecentlyAdded}
              onItemClick={handleItemClick}
              onItemPlay={handleItemPlay}
            />
          )}
        </>
      ) : (
        <div className="flex flex-col items-center justify-center py-20">
          <p className="text-muted-foreground">暂无媒体数据，服务器可能为空</p>
        </div>
      )}
    </div>
  );
}
