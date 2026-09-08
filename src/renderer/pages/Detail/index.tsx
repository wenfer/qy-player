import { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Play, Star, Calendar, Clock, ChevronLeft, Film, Users, Clapperboard, Tv } from 'lucide-react';
import DetailSkeleton from '../../components/Skeleton/DetailSkeleton';
import { useToastStore } from '../../stores/toast-store';
import { getServerMap } from '../../utils/server-images';
import { usePlayerStore } from '../../stores/player-store';

interface ItemDetails {
  Id: string;
  Name: string;
  OriginalTitle?: string;
  Overview?: string;
  ProductionYear?: number;
  OfficialRating?: string;
  CommunityRating?: number;
  RunTimeTicks?: number;
  Type: string;
  SeriesName?: string;
  SeasonName?: string;
  IndexNumber?: number;
  ParentIndexNumber?: number;
  ImageTags?: { Primary?: string; Backdrop?: string };
  BackdropImageTags?: string[];
  MediaSources?: Array<{ Id: string }>;
  People?: Array<{ Name: string; Type: string; Role?: string }>;
}

interface Season {
  Id: string;
  Name: string;
  IndexNumber: number;
  SeriesId: string;
}

interface Episode {
  Id: string;
  Name: string;
  IndexNumber?: number;
  Overview?: string;
  ImageTags?: { Primary?: string };
  RunTimeTicks?: number;
  MediaSources?: Array<{ Id: string }>;
}

function formatRuntime(ticks?: number): string {
  if (!ticks) return '';
  const minutes = Math.floor(ticks / 10000000 / 60);
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours > 0) return `${hours}小时${mins}分钟`;
  return `${mins}分钟`;
}

const TYPE_BADGE: Record<string, { icon: React.ReactNode; label: string }> = {
  Movie: { icon: <Clapperboard size={12} />, label: '电影' },
  Series: { icon: <Tv size={12} />, label: '剧集' },
  Episode: { icon: <Tv size={12} />, label: '单集' },
  Season: { icon: <Tv size={12} />, label: '季' },
};

export default function Detail() {
  const { type, id } = useParams<{ type: string; id: string }>();
  const navigate = useNavigate();
  const addToast = useToastStore((s) => s.addToast);
  const [details, setDetails] = useState<ItemDetails | null>(null);
  const [seasons, setSeasons] = useState<Season[]>([]);
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [selectedSeason, setSelectedSeason] = useState<number>(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const serverType = type || 'jellyfin';
  const [baseUrl, setBaseUrl] = useState<string | null>(null);

  const loadDetails = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      // Resolve the owning server's baseUrl by type (single-server fallback)
      const serverMap = await getServerMap();
      const server = Array.from(serverMap.values()).find((s) => s.type === serverType);
      setBaseUrl(server?.base_url ?? null);

      const data = await window.electronAPI.getItemDetails(id);
      const item = data as ItemDetails;
      setDetails(item);

      if (item.Type === 'Series') {
        const items = await window.electronAPI.getItems(id, {
          includeItemTypes: 'Season',
          recursive: true,
        });
        const seasonList = (items as Season[]).sort((a, b) => a.IndexNumber - b.IndexNumber);
        setSeasons(seasonList);
        if (seasonList.length > 0) {
          setSelectedSeason(seasonList[0].IndexNumber);
          loadEpisodes(seasonList[0].Id);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : '未知错误';
      setError(msg);
      addToast(`加载详情失败: ${msg}`, 'error');
    } finally {
      setLoading(false);
    }
  }, [id, serverType, addToast]);

  const loadEpisodes = useCallback(async (seasonId: string) => {
    try {
      const items = await window.electronAPI.getItems(seasonId, { includeItemTypes: 'Episode' });
      setEpisodes(items as Episode[]);
    } catch {
      setEpisodes([]);
    }
  }, []);

  useEffect(() => {
    loadDetails();
  }, [loadDetails]);

  const handlePlay = useCallback(async (itemId?: string, mediaSourceId?: string, mode?: 'direct' | 'transcode', startPosition?: number) => {
    const targetId = itemId || id;
    const playMode = mode || 'direct';
    try {
      let targetDetails: ItemDetails;
      if (itemId && itemId !== id) {
        const data = await window.electronAPI.getItemDetails(itemId);
        if (!data) {
          addToast('获取媒体详情失败，请稍后重试', 'error');
          return;
        }
        targetDetails = data as ItemDetails;
      } else {
        targetDetails = details!;
        if (!targetDetails) {
          addToast('详情未加载完成，请稍后重试', 'error');
          return;
        }
      }

      let ms = mediaSourceId || targetDetails.MediaSources?.[0]?.Id;
      let playId = targetId;

      // Container items (Series/Season/Folder/BoxSet) have no MediaSources
      // of their own - resolve a playable child instead.
      if (!ms) {
        if (targetDetails.Type === 'Series' || targetDetails.Type === 'Season') {
          // Prefer the first episode (stable episode ordering)
          let epList = episodes;
          if (epList.length === 0) {
            epList = (await window.electronAPI.getItems(targetDetails.Id, {
              includeItemTypes: 'Episode',
              recursive: true,
              sortBy: 'ParentIndexNumber,IndexNumber',
              sortOrder: 'Ascending',
              limit: 1,
            })) as Episode[];
          }
          const first = epList[0];
          const epMs = first?.MediaSources?.[0]?.Id;
          if (first && epMs) {
            playId = first.Id;
            ms = epMs;
          }
        }
        if (!ms) {
          // Generic container (e.g. Jellyfin Folder wrapping one movie):
          // recursively find the first child that has a MediaSource.
          const children = (await window.electronAPI.getItems(targetDetails.Id, {
            recursive: true,
            sortBy: 'SortName',
            limit: 20,
          })) as Array<Record<string, unknown>>;
          const playable = children.find(
            (it) => ((it.MediaSources as Array<Record<string, unknown>> | undefined)?.length ?? 0) > 0
          );
          const playMs = playable?.MediaSources as Array<Record<string, unknown>> | undefined;
          if (playable && playMs?.[0]) {
            playId = playable.Id as string;
            ms = playMs[0].Id as string;
          }
        }
        if (!ms) {
          addToast('未找到可播放的媒体文件', 'error');
          return;
        }
      }

      const stream = (await window.electronAPI.getStreamUrl(playId!, ms, playMode)) as {
        url: string;
        headers?: string;
      } | null;
      if (stream?.url) {
        await window.electronAPI.playerLoadFile(stream.url, startPosition, stream.headers, {
          mediaType: serverType,
          mediaId: playId!,
          title: targetDetails.Name,
          seriesName: targetDetails.SeriesName,
          seasonNumber: targetDetails.ParentIndexNumber,
          episodeNumber: targetDetails.IndexNumber,
          mediaSourceId: ms,
        });
        addToast(
          playMode === 'transcode' ? '开始播放（服务端转码）' : '开始播放（直连/客户端解码）',
          'success'
        );
      } else {
        addToast('无法获取播放地址（服务器未响应），请稍后重试', 'error');
      }
    } catch (err) {
      addToast(`播放失败: ${err instanceof Error ? err.message : '未知错误'}`, 'error');
    }
  }, [id, details, episodes, addToast]);

  const handleSeasonChange = useCallback((seasonIndex: number, seasonId: string) => {
    setSelectedSeason(seasonIndex);
    loadEpisodes(seasonId);
  }, [loadEpisodes]);

  const getImageUrl = useCallback(
    (itemId: string, imageType: string, tag: string) => {
      if (!baseUrl) return undefined;
      const prefix = serverType === 'emby' ? '/emby' : '';
      return `${baseUrl}${prefix}/Items/${itemId}/Images/${imageType}?tag=${tag}&maxHeight=800&quality=90`;
    },
    [serverType, baseUrl]
  );

  if (loading) {
    return (
      <div>
        <div className="p-8 pb-0">
          <button
            onClick={() => navigate(-1)}
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors focus-ring rounded-md py-1"
          >
            <ChevronLeft size={16} />
            返回
          </button>
        </div>
        <DetailSkeleton />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] px-8" role="alert">
        <Film size={48} className="text-muted-foreground mb-4" />
        <h2 className="text-lg font-semibold mb-2">加载失败</h2>
        <p className="text-muted-foreground text-sm mb-6">{error}</p>
        <button onClick={loadDetails} className="px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors focus-ring">
          重试
        </button>
      </div>
    );
  }

  if (!details) {
    return (
      <div className="p-8">
        <button onClick={() => navigate(-1)} className="flex items-center gap-1 text-muted-foreground hover:text-foreground mb-4 focus-ring rounded">
          <ChevronLeft size={18} /> 返回
        </button>
        <p>无法加载详情</p>
      </div>
    );
  }

  const backdropUrl = details.BackdropImageTags?.[0]
    ? getImageUrl(details.Id, 'Backdrop', details.BackdropImageTags[0])
    : undefined;
  const posterUrl = details.ImageTags?.Primary
    ? getImageUrl(details.Id, 'Primary', details.ImageTags.Primary)
    : undefined;

  const typeBadge = TYPE_BADGE[details.Type];

  return (
    <div className="min-h-screen relative">
      {/* Full-screen backdrop */}
      {backdropUrl && (
        <>
          <div className="fixed inset-0 z-0">
            <img src={backdropUrl} alt="" className="w-full h-full object-cover" />
          </div>
          <div className="fixed inset-0 z-0 bg-background/60 backdrop-blur-sm" />
        </>
      )}

      <div className="relative z-10 px-8 pt-8 pb-16">
        {/* Back button */}
        <button
          onClick={() => navigate(-1)}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-6 transition-colors focus-ring rounded-md py-1"
        >
          <ChevronLeft size={16} />
          返回
        </button>

        <div className="flex gap-8">
          {/* Poster */}
          <div className="flex-shrink-0 w-[200px] md:w-[240px]">
            <div className="relative aspect-[2/3] rounded-xl overflow-hidden bg-card border border-border">
              {typeBadge && (
                <div className="absolute top-2 left-2 z-10 flex items-center gap-1 px-2 py-1 bg-black/70 text-white text-[10px] font-medium rounded-md backdrop-blur-sm">
                  {typeBadge.icon}
                  {typeBadge.label}
                </div>
              )}
              {posterUrl ? (
                <img src={posterUrl} alt={details.Name} className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  <Film size={48} className="text-muted-foreground/30" />
                </div>
              )}
            </div>

            <button
              onClick={() => handlePlay()}
              className="w-full mt-4 flex items-center justify-center gap-2 px-5 py-3 bg-primary text-primary-foreground rounded-xl hover:bg-primary/90 transition-colors focus-ring font-medium text-sm"
            >
              <Play size={16} fill="currentColor" />
              立即播放
            </button>
            <button
              onClick={() => {
                const s = usePlayerStore.getState();
                handlePlay(undefined, undefined, 'transcode', s.isPlaying && s.currentTime > 5 ? Math.floor(s.currentTime) : undefined);
              }}
              className="w-full mt-2 flex items-center justify-center gap-1 px-2 py-2 border border-border rounded-lg hover:bg-accent transition-colors text-xs focus-ring text-muted-foreground hover:text-foreground"
              title="服务端解码转码，客户端压力小（8Mbps h264）"
            >
              服务端转码播放
            </button>
            <p className="text-[10px] text-muted-foreground mt-1.5 leading-relaxed">
              默认客户端直连解码，画质无损；如遇卡顿可选择服务端转码。
            </p>
          </div>

          {/* Info */}
          <div className="flex-1 min-w-0">
            <h1 className="text-3xl font-bold tracking-tight">{details.Name}</h1>
            {details.OriginalTitle && details.OriginalTitle !== details.Name && (
              <p className="text-muted-foreground mt-1">{details.OriginalTitle}</p>
            )}

            {/* Meta */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mt-4 text-sm">
              {details.ProductionYear && (
                <span className="flex items-center gap-1 text-muted-foreground">
                  <Calendar size={14} /> {details.ProductionYear}
                </span>
              )}
              {details.OfficialRating && (
                <span className="px-1.5 py-0.5 border border-border rounded text-xs text-muted-foreground">
                  {details.OfficialRating}
                </span>
              )}
              {details.CommunityRating !== undefined && (
                <span className="flex items-center gap-1 text-yellow-500">
                  <Star size={14} fill="currentColor" /> {details.CommunityRating.toFixed(1)}
                </span>
              )}
              {details.RunTimeTicks && (
                <span className="flex items-center gap-1 text-muted-foreground">
                  <Clock size={14} /> {formatRuntime(details.RunTimeTicks)}
                </span>
              )}
            </div>

            {/* Overview */}
            {details.Overview && (
              <p className="text-muted-foreground leading-relaxed mt-6 text-sm max-w-2xl">{details.Overview}</p>
            )}

            {/* Cast */}
            {details.People && details.People.length > 0 && (
              <div className="mt-8">
                <h3 className="text-sm font-semibold mb-3 flex items-center gap-1.5">
                  <Users size={14} className="text-muted-foreground" />
                  演职员
                </h3>
                <div className="flex flex-wrap gap-3">
                  {details.People.slice(0, 10).map((person) => (
                    <div key={person.Name} className="flex-shrink-0 text-center w-16">
                      <div className="w-12 h-12 rounded-full bg-muted mx-auto mb-1.5 flex items-center justify-center text-xs font-bold text-muted-foreground">
                        {person.Name.charAt(0)}
                      </div>
                      <p className="text-[11px] leading-tight truncate">{person.Name}</p>
                      <p className="text-[10px] text-muted-foreground truncate">{person.Role || person.Type}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Seasons */}
            {details.Type === 'Series' && seasons.length > 0 && (
              <div className="mt-8">
                <h3 className="text-sm font-semibold mb-3">季</h3>
                <div className="flex flex-wrap gap-2 mb-4">
                  {seasons.map((season) => (
                    <button
                      key={season.Id}
                      onClick={() => handleSeasonChange(season.IndexNumber, season.Id)}
                      className={`px-3.5 py-1.5 rounded-lg text-sm font-medium transition-colors focus-ring ${
                        selectedSeason === season.IndexNumber
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-card border border-border hover:border-primary/40 text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      第 {season.IndexNumber} 季
                    </button>
                  ))}
                </div>

                {episodes.length > 0 && (
                  <div className="grid grid-cols-4 sm:grid-cols-5 md:grid-cols-6 lg:grid-cols-8 gap-2">
                    {episodes.map((ep) => {
                      const msId = ep.MediaSources?.[0]?.Id;
                      const epPosterUrl = ep.ImageTags?.Primary
                        ? getImageUrl(ep.Id, 'Primary', ep.ImageTags.Primary)
                        : undefined;
                      return (
                        <button
                          key={ep.Id}
                          className="group relative aspect-[16/10] rounded-xl overflow-hidden bg-card border border-border hover:border-primary/30 transition-colors text-left focus-ring"
                          onClick={() => msId && handlePlay(ep.Id, msId)}
                        >
                          {epPosterUrl ? (
                            <img
                              src={epPosterUrl}
                              alt=""
                              className="absolute inset-0 w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity"
                            />
                          ) : (
                            <div className="absolute inset-0 flex items-center justify-center bg-muted">
                              <span className="text-3xl font-bold text-muted-foreground/20 select-none">
                                {ep.IndexNumber}
                              </span>
                            </div>
                          )}
                          {/* Gradient overlay */}
                          <div className="absolute inset-0 bg-gradient-to-t from-background via-background/50 to-transparent" />
                          {/* Content */}
                          <div className="absolute bottom-0 left-0 right-0 p-2">
                            <div className="text-xs font-medium line-clamp-2 leading-snug">
                              {ep.IndexNumber !== undefined ? `${ep.IndexNumber}. ` : ''}{ep.Name}
                            </div>
                            {ep.RunTimeTicks && (
                              <div className="text-[10px] text-muted-foreground mt-0.5">{formatRuntime(ep.RunTimeTicks)}</div>
                            )}
                          </div>
                          {/* Play overlay */}
                          <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-black/20">
                            <div className="p-2 bg-primary text-primary-foreground rounded-full">
                              <Play size={14} fill="currentColor" />
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
