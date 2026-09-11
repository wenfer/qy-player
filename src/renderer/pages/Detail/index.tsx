import { useEffect, useState, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Play, Star, Calendar, Clock, ChevronLeft, Film, Users, Clapperboard, Tv } from 'lucide-react';
import SeriesResumeButton from './SeriesResumeButton';
import EpisodeGrid from './EpisodeGrid';
import type { ResumeEpisodeInput, ResumeTarget } from '../../../shared/types/playback';
import DetailSkeleton from '../../components/Skeleton/DetailSkeleton';
import MediaInfoPanel, { type ProbePhase } from './MediaInfoPanel';
import ProgressSummary from './ProgressSummary';
import type { MediaProbeOutcome, ProbeItemInput } from '../../../shared/types/media-info';
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
  MediaSources?: Array<{ Id: string; Size?: number }>;
  People?: Array<{ Name: string; Type: string; Role?: string }>;
}

interface Season {
  Id: string;
  Name: string;
  IndexNumber: number;
  SeriesId: string;
}

export interface Episode {
  Id: string;
  Name: string;
  IndexNumber?: number;
  ParentIndexNumber?: number;
  Overview?: string;
  ImageTags?: { Primary?: string };
  RunTimeTicks?: number;
  MediaSources?: Array<{ Id: string }>;
  /** Server-side watch state (§12.1: server UserData preferred). */
  UserData?: { PlaybackPositionTicks?: number; Played?: boolean; LastPlayedDate?: string };
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
  // serverId is part of the route (QYP2-015 exact routing): playback and
  // details are always bound to one server, never try-every-server.
  const { type, serverId: serverIdParam, id } = useParams<{ type: string; serverId: string; id: string }>();
  const navigate = useNavigate();
  const addToast = useToastStore((s) => s.addToast);
  const [details, setDetails] = useState<ItemDetails | null>(null);
  const [seasons, setSeasons] = useState<Season[]>([]);
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [selectedSeason, setSelectedSeason] = useState<number>(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // QYP2-019: technical-info probe state (non-blocking; never gates playback)
  const [probeRequest, setProbeRequest] = useState<ProbeItemInput | null>(null);
  const [probePhase, setProbePhase] = useState<ProbePhase>('idle');
  const [probeOutcome, setProbeOutcome] = useState<MediaProbeOutcome | null>(null);
  // Latest request for staleness checks: an old probe resolving after the
  // item changed must never paint its outcome on the new item.
  const probeRequestRef = useRef<ProbeItemInput | null>(null);

  const serverType = type || 'jellyfin';
  const serverId = Number(serverIdParam);
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

      const data = await window.electronAPI.getItemDetails(id, Number.isInteger(serverId) ? serverId : undefined);
      const item = data as ItemDetails;
      setDetails(item);

      if (item.Type === 'Series') {
        const items = await window.electronAPI.getItems(id, {
          includeItemTypes: 'Season',
          recursive: true,
        }, Number.isInteger(serverId) ? serverId : undefined);
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
  }, [id, serverId, serverType, addToast]);

  const loadEpisodes = useCallback(async (seasonId: string) => {
    try {
      const items = await window.electronAPI.getItems(seasonId, { includeItemTypes: 'Episode' }, Number.isInteger(serverId) ? serverId : undefined);
      setEpisodes(items as Episode[]);
    } catch {
      setEpisodes([]);
    }
  }, [serverId]);

  useEffect(() => {
    loadDetails();
  }, [loadDetails]);

  // Probe lifecycle: distinct terminal states (QYP2-018 contract); failures
  // are rendered, never thrown, and never gate the play buttons.
  const runProbe = useCallback(async () => {
    const request = probeRequestRef.current;
    if (!request) return;
    setProbePhase('probing');
    setProbeOutcome(null);
    try {
      const result = (await window.electronAPI.probeItem(request)) as {
        ok: boolean;
        data?: MediaProbeOutcome;
        error?: { code?: string };
      };
      // Stale response: the item changed while this probe was in flight.
      if (probeRequestRef.current !== request) return;
      if (!result.ok || !result.data) {
        setProbePhase(result.error?.code === 'AUTH_REQUIRED' ? 'auth' : 'offline');
        return;
      }
      const outcome = result.data;
      setProbeOutcome(outcome.status === 'cancelled' ? null : outcome);
      setProbePhase(
        outcome.status === 'cancelled'
          ? 'idle'
          : outcome.status === 'offline'
            ? 'offline'
            : outcome.status === 'timeout'
              ? 'timeout'
              : outcome.status === 'no-mpv'
                ? 'no-mpv'
                : outcome.status
      );
    } catch {
      if (probeRequestRef.current === request) setProbePhase('offline');
    }
  }, []);

  // Only playable types carry technical info + progress.
  useEffect(() => {
    if (!details || (details.Type !== 'Movie' && details.Type !== 'Episode')) {
      setProbeRequest(null);
      setProbePhase('idle');
      setProbeOutcome(null);
      return;
    }
    const size = details.MediaSources?.[0]?.Size;
    // Item changed: previous outcome must never leak into the new item.
    setProbePhase('idle');
    setProbeOutcome(null);
    const request: ProbeItemInput = {
      ref: { provider: serverType, serverId: Number.isInteger(serverId) ? serverId : undefined, itemId: details.Id },
      mode: 'direct',
      fingerprint: `${details.RunTimeTicks ?? 0}:${size ?? 0}`,
    };
    probeRequestRef.current = request;
    setProbeRequest(request);
  }, [details, serverType, serverId]);

  // Playback goes through the unified resolver (QYP2-015): one MediaRef
  // in, one ready-to-load payload out. Series/Season containers resolve to
  // their first playable episode main-side.
  const handlePlay = useCallback(async (itemId?: string, mediaSourceId?: string, mode?: 'direct' | 'transcode', startPosition?: number) => {
    const targetId = itemId || id;
    const playMode = mode || 'direct';
    if (!targetId || !Number.isInteger(serverId)) {
      addToast('无法确定媒体来源的服务器', 'error');
      return;
    }
    try {
      const result = (await window.electronAPI.resolvePlayback(
        { provider: serverType, serverId, itemId: targetId },
        { mode: playMode, ...(mediaSourceId ? { mediaSourceId } : {}) }
      )) as {
        ok: boolean;
        data?: {
          url: string;
          streamSessionId?: string;
          startPosition: number;
          mediaContext: {
            mediaType: string;
            mediaId: string;
            title?: string;
            seriesName?: string;
            seasonNumber?: number;
            episodeNumber?: number;
            mediaSourceId?: string;
          };
        };
        error?: { message: string };
      };
      if (!result.ok || !result.data) {
        addToast(result.error?.message ?? '无法获取播放地址，请稍后重试', 'error');
        return;
      }
      const resolved = result.data;
      const position =
        startPosition !== undefined
          ? startPosition
          : resolved.startPosition > 0
            ? Math.floor(resolved.startPosition)
            : undefined;
      await window.electronAPI.playerLoadFile(
        resolved.url,
        position,
        undefined,
        resolved.mediaContext,
        resolved.streamSessionId
      );
      addToast(
        playMode === 'transcode' ? '开始播放（服务端转码）' : '开始播放（直连/客户端解码）',
        'success'
      );
      // 回到本页时（focus）会静默重解析；这里先主动失效一次。
      setResumeEpoch((n) => n + 1);
    } catch (err) {
      addToast(`播放失败: ${err instanceof Error ? err.message : '未知错误'}`, 'error');
    }
  }, [id, serverId, serverType, addToast]);

  const handleSeasonChange = useCallback((seasonIndex: number, seasonId: string) => {
    setSelectedSeason(seasonIndex);
    loadEpisodes(seasonId);
  }, [loadEpisodes]);

  // QYP2-034: series primary-button target. The episode snapshots come
  // from the server (UserData preferred, §12.1); the DECISION runs
  // main-side via the pure resolver — the renderer never copies the
  // algorithm. resumeEpoch lets play-back/focus refresh re-resolve.
  const [resumeEpoch, setResumeEpoch] = useState(0);
  const resolveResumeTarget = useCallback(async (): Promise<ResumeTarget | null> => {
    if (!details || details.Type !== 'Series' || !Number.isInteger(serverId)) return null;
    try {
      const all = await window.electronAPI.getItems(details.Id, {
        includeItemTypes: 'Episode',
        recursive: true,
      }, serverId) as Episode[];
      const inputs: ResumeEpisodeInput[] = all.map((ep) => ({
        itemId: ep.Id,
        seasonNumber: ep.ParentIndexNumber ?? null,
        episodeNumber: ep.IndexNumber ?? null,
        title: ep.Name,
        progress: {
          position: ep.UserData?.PlaybackPositionTicks ? ep.UserData.PlaybackPositionTicks / 10000000 : 0,
          duration: ep.RunTimeTicks ? ep.RunTimeTicks / 10000000 : 0,
          isFinished: ep.UserData?.Played === true,
          updatedAt: ep.UserData?.LastPlayedDate ? Date.parse(ep.UserData.LastPlayedDate) || 0 : 0,
        },
      }));
      const res = (await window.electronAPI.resolveSeriesResume(inputs)) as {
        ok: boolean;
        data?: ResumeTarget | null;
      };
      return res.ok ? res.data ?? null : null;
    } catch {
      return null;
    }
  }, [details, serverId, resumeEpoch]);

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

            {details.Type === 'Series' ? (
              <div className="mt-4">
                <SeriesResumeButton
                  resolve={resolveResumeTarget}
                  onPlay={(target) =>
                    void handlePlay(
                      String(target.itemId),
                      undefined,
                      'direct',
                      // 明确传 0：start/next/replay 不吃该集旧位置（§12.2）
                      target.position > 0 ? Math.floor(target.position) : 0
                    )
                  }
                />
              </div>
            ) : (
              <button
                onClick={() => handlePlay()}
                className="w-full mt-4 flex items-center justify-center gap-2 px-5 py-3 bg-primary text-primary-foreground rounded-xl hover:bg-primary/90 transition-colors focus-ring font-medium text-sm"
              >
                <Play size={16} fill="currentColor" />
                立即播放
              </button>
            )}
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

            {/* Last position: honest resume wording; finished ≠ 继续播放 */}
            {(details.Type === 'Movie' || details.Type === 'Episode') && (
              <ProgressSummary
                mediaType={serverType}
                mediaId={details.Id}
                durationHint={details.RunTimeTicks ? details.RunTimeTicks / 10000000 : undefined}
              />
            )}

            {/* Technical info: probe 中/失败/离线独立状态，永不阻塞播放。
                Rendered only when the request matches the shown item, so a
                stale request can never mount (and never double-probe). */}
            {(details.Type === 'Movie' || details.Type === 'Episode') &&
              probeRequest?.ref.itemId === details.Id && (
                <MediaInfoPanel
                  key={details.Id}
                  request={probeRequest}
                  onProbe={runProbe}
                  outcome={probeOutcome}
                  phase={probePhase}
                />
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

                <EpisodeGrid
                  episodes={episodes}
                  getImageUrl={getImageUrl}
                  onPlay={(ep) => {
                    const msId = ep.MediaSources?.[0]?.Id;
                    if (msId) handlePlay(ep.Id, msId);
                  }}
                  onPlayFromStart={(ep) => {
                    const msId = ep.MediaSources?.[0]?.Id;
                    // 从头播放：显式 0 起播，不清除历史（§12.1）
                    if (msId) handlePlay(ep.Id, msId, 'direct', 0);
                  }}
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
