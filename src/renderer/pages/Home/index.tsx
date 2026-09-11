import { useEffect, useState, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { ServerOff, RefreshCw, Film, AlertCircle, Tv, Music, FolderOpen, Clapperboard } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import HorizontalRow from '../../components/HorizontalRow';
import RowSkeleton from '../../components/Skeleton/RowSkeleton';
import { useToastStore } from '../../stores/toast-store';
import { getServerMap, buildImageUrl } from '../../utils/server-images';
import { usePlayItem } from '../../hooks/use-play-item';
import type { MediaItem } from '../../components/HorizontalRow';
import type { UnifiedCard } from '../../../main/modules/catalog/unified-query';
import type { MediaRef } from '../../../shared/types/catalog';

/**
 * QYP2-036: 统一卡片 → MediaItem 适配。catalog 卡走 /browse 路由 +
 * catalogRef 播放（use-play-item 已支持）；在线卡保持原 /detail 路由。
 * 海报只按来源拼 URL；目录卡暂无 tag → 占位（不臆造 URL）。
 */
function unifiedToMediaItem(card: UnifiedCard, serverMap: ReturnType<typeof getServerMap> extends Promise<infer M> ? M : never): MediaItem {
  const isCatalog = card.ref.provider === 'catalog';
  const provider = card.ref.provider;
  const serverId =
    card.ref.provider === 'catalog' ? card.ref.sourceId : card.ref.serverId;
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
    type: isCatalog ? 'Movie' : card.kind === 'series' ? 'Series' : card.kind === 'episode' ? 'Episode' : 'Movie',
    serverId,
    serverType: isCatalog ? 'local' : provider,
    catalogRef: card.ref,
    ...(card.position != null && card.duration
      ? { catalogProgress: { position: card.position, duration: card.duration, isFinished: card.isFinished ?? false } }
      : {}),
    dateCreated: card.updatedAt ? new Date(card.updatedAt).toISOString() : undefined,
  };
}

function navigateForRef(navigate: (path: string) => void, ref: MediaRef): void {
  if (ref.provider === 'catalog') {
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

interface LibraryRow {
  viewId: string;
  rawViewId: string;
  serverId: number;
  title: string;
  collectionType: string;
  items: MediaItem[];
}

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
  count: number;
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
      className="group relative aspect-[16/9] rounded-xl overflow-hidden bg-card border border-border transition-all duration-200 hover:border-primary/40 card-lift focus-ring text-left"
      aria-label={`打开媒体库 ${title}，共 ${count} 部影片`}
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
        <div className="text-xs text-muted-foreground">{count} 部影片</div>
      </div>
    </button>
  );
}

export default function Home() {
  const [continueWatching, setContinueWatching] = useState<MediaItem[]>([]);
  const [libraryRows, setLibraryRows] = useState<LibraryRow[]>([]);
  const [recentlyAdded, setRecentlyAdded] = useState<MediaItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [servers, setServers] = useState<ServerInfo[]>([]);
  const [libraryErrors, setLibraryErrors] = useState<string[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const navigate = useNavigate();
  const addToast = useToastStore((s) => s.addToast);
  // Re-entrancy guard: focus/eof/manual refresh can overlap otherwise,
  // causing interleaved setState and duplicated backend requests.
  const loadingRef = useRef(false);

  const loadData = useCallback(async (opts?: { silent?: boolean }) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    if (opts?.silent) {
      setRefreshing(true); // background refresh: keep existing content visible
    } else {
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

      // Libraries - one row per media library view (matches server categorization)
      const rows: LibraryRow[] = [];
      const libs = (await window.electronAPI.getLibraries()) as LibraryResult[];
      const errors: string[] = [];
      for (const lib of libs) {
        if (lib.error) {
          errors.push(`${lib.serverName}: ${lib.error}`);
          continue;
        }
        const libServerMap = new Map(
          activeServers.filter((s) => s.id === lib.serverId).map((s) => [s.id, s])
        );
        // Fetch all views in parallel (one IPC per view; serial awaits
        // made multi-library servers load noticeably slower)
        const viewItems = await Promise.all(
          lib.views.map((view) =>
            window.electronAPI
              .getItems(view.Id as string, {
                sortBy: 'DateCreated',
                sortOrder: 'Descending',
                limit: 20,
              })
              .catch(() => [] as Array<Record<string, unknown>>)
          )
        );
        for (let vi = 0; vi < lib.views.length; vi++) {
          const view = lib.views[vi];
          const items = viewItems[vi];

          const mapped = (items as Array<Record<string, unknown>>).map((item) => {
            const imageTags = item.ImageTags as Record<string, string> | undefined;
            const itemServerType = (item.serverType as string) || lib.serverType || 'jellyfin';
            const baseServerId = (item.serverId as number) || lib.serverId;
            return {
              id: item.Id as string,
              name: (item.Name as string) || '未知',
              imageUrl: buildImageUrl(
                libServerMap,
                baseServerId,
                itemServerType,
                item.Id as string,
                'Primary',
                imageTags?.Primary
              ),
              // Landscape thumbnail - far better suited as a wide card bg
              // than a cropped portrait poster
              thumbUrl: imageTags?.Thumb
                ? buildImageUrl(
                    libServerMap,
                    baseServerId,
                    itemServerType,
                    item.Id as string,
                    'Thumb',
                    imageTags.Thumb,
                    800
                  )
                : undefined,
              year: item.ProductionYear as number,
              rating: item.CommunityRating as number,
              type: item.Type as string,
              serverId: (item.serverId as number) || lib.serverId,
              serverType: itemServerType,
              dateCreated: item.DateCreated as string | undefined,
            };
          });

          // Keep the server's own library name (e.g. 电影 / 电视剧 / 音乐)
          rows.push({
            viewId: `${lib.serverId}-${view.Id}`,
            rawViewId: view.Id as string,
            serverId: lib.serverId,
            title: (view.Name as string) || lib.serverName || '未命名媒体库',
            collectionType: (view.CollectionType as string) || '',
            items: mapped,
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
    } catch (err) {
      const msg = err instanceof Error ? err.message : '未知错误';
      setError(msg);
      addToast(`加载数据失败: ${msg}`, 'error');
    } finally {
      loadingRef.current = false;
      setLoading(false);
      setRefreshing(false);
    }
  }, [addToast]);

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
          onClick={() => navigate('/settings')}
          className="px-5 py-2.5 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors focus-ring font-medium"
        >
          前往设置
        </button>
      </div>
    );
  }

  // Content state
  const hasContent =
    continueWatching.length > 0 || libraryRows.length > 0 || recentlyAdded.length > 0;

  return (
    <div className="p-8 max-w-none">
      <header className="mb-10 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">首页</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {servers.length > 0 && `已连接 ${servers.length} 个服务器`}
          </p>
        </div>
        <button
          onClick={() => loadData({ silent: servers.length > 0 })}
          className="flex items-center gap-1.5 px-3 py-2 text-sm border border-border rounded-lg hover:bg-accent transition-colors focus-ring"
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
              className="flex items-center gap-2 p-3 bg-amber-500/10 text-amber-600 rounded-lg text-sm"
            >
              <AlertCircle size={16} className="flex-shrink-0" />
              {e}
              <button
                onClick={() => navigate('/settings')}
                className="ml-auto text-xs underline underline-offset-2 hover:no-underline flex-shrink-0"
              >
                前往设置
              </button>
            </div>
          ))}
        </div>
      )}

      {hasContent ? (
        <>
          {/* Media library categories - primary navigation */}
          {libraryRows.length > 0 && (
            <section className="mb-10" aria-label="媒体库分类">
              <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-4">
                媒体库
              </h2>
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                {libraryRows.map((row) => (
                  <LibraryCard
                    key={row.viewId}
                    title={row.title}
                    count={row.items.length}
                    collectionType={row.collectionType}
                    imageUrl={row.items[0]?.imageUrl}
                    thumbUrl={row.items[0]?.thumbUrl}
                    onClick={() =>
                      navigate(`/library/${row.serverId}/${encodeURIComponent(row.rawViewId)}`, {
                        state: { name: row.title },
                      })
                    }
                  />
                ))}
              </div>
            </section>
          )}

          {continueWatching.length > 0 && (
            <HorizontalRow
              title="继续观看"
              items={continueWatching}
              onItemClick={handleItemClick}
              onItemPlay={handleItemPlay}
            />
          )}
          {recentlyAdded.length > 0 && (
            <HorizontalRow
              title="最近添加"
              items={recentlyAdded}
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
