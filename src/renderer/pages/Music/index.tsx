import { useCallback, useEffect, useState } from 'react';
import { Disc3, Heart, ListMusic, Music2, User } from 'lucide-react';
import { useToastStore } from '../../stores/toast-store';
import { useMusicPlaybackStore } from '../../stores/music-playback-store';
import type { MusicAlbumRow, MusicArtistRow, MusicTrackRow } from '../../../shared/types/music';

/**
 * 音乐库页（三期 QYP3-008 / QYP3-008a）：专辑 / 歌手 / 全部曲目 / 收藏
 * 四个视图。来源 = 本地/WebDAV 音频（服务器音频查询三期未开放）。
 * 版式：拒绝横向滚动（1280×800 实测约束），网格自动换行。
 * 收藏标记在音轨行上（music_tracks.favorite，migration 008）。
 */

type View = 'albums' | 'artists' | 'all' | 'favorites';

const coverUrl = (trackId: number | null): string | null =>
  trackId ? `qy-file://covers/${trackId}.png` : null;

function fmtDuration(sec: number | null): string {
  if (!sec || sec <= 0) return '';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function TrackRow({
  track,
  showTrackNo,
  subtitle,
  onPlay,
  onToggleFavorite,
}: {
  track: MusicTrackRow;
  showTrackNo?: boolean;
  subtitle?: string;
  onPlay: () => void;
  onToggleFavorite: () => void;
}) {
  const favorite = track.favorite === 1;
  return (
    <div className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-accent transition-colors">
      {showTrackNo && (
        <span className="text-xs text-muted-foreground w-6 text-right">{track.track_no ?? '–'}</span>
      )}
      <button
        type="button"
        onClick={onPlay}
        className="flex items-center gap-3 flex-1 min-w-0 text-left focus-ring"
      >
        <Music2 size={14} className="text-muted-foreground flex-shrink-0" />
        <span className="flex-1 min-w-0">
          <span className="block text-xs truncate">{track.title}</span>
          <span className="block text-[10px] text-muted-foreground truncate">
            {subtitle ?? ([track.artist, track.album].filter(Boolean).join(' · ') || '未知歌手')}
          </span>
        </span>
      </button>
      <span className="text-[10px] text-muted-foreground">{fmtDuration(track.duration)}</span>
      {track.has_lyrics ? <span className="text-[10px] text-muted-foreground">词</span> : null}
      <button
        type="button"
        onClick={onToggleFavorite}
        aria-label={favorite ? '取消收藏' : '收藏此曲'}
        aria-pressed={favorite}
        className="p-1 rounded-lg hover:bg-accent focus-ring flex-shrink-0"
      >
        <Heart size={13} className={favorite ? 'text-primary fill-primary' : 'text-muted-foreground'} />
      </button>
    </div>
  );
}

function AlbumGrid({
  albums,
  onOpen,
}: {
  albums: MusicAlbumRow[];
  onOpen: (albumartist: string, album: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-4">
      {albums.map((album, i) => (
        <button
          key={`${album.albumartist}-${album.album}-${i}`}
          type="button"
          onClick={() => onOpen(album.albumartist ?? '', album.album ?? '')}
          className="w-40 text-left group focus-ring"
        >
          <div className="aspect-square rounded-lg bg-muted border border-border overflow-hidden mb-2 flex items-center justify-center">
            {album.cover_track_id ? (
              <img
                src={coverUrl(album.cover_track_id) ?? ''}
                alt=""
                className="w-full h-full object-cover"
                loading="lazy"
              />
            ) : (
              <Disc3 size={28} className="text-muted-foreground opacity-40" />
            )}
          </div>
          <p className="text-xs truncate group-hover:text-foreground">{album.album || '未知专辑'}</p>
          <p className="text-[10px] text-muted-foreground truncate">
            {album.albumartist || '未知歌手'} · {album.track_count} 首
          </p>
        </button>
      ))}
    </div>
  );
}

function EmptyState({ icon, title, hint }: { icon: React.ReactNode; title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
      {icon}
      <p className="text-xs mt-3">{title}</p>
      {hint && <p className="text-[11px] mt-1">{hint}</p>}
    </div>
  );
}

export default function MusicPage() {
  const addToast = useToastStore((s) => s.addToast);
  const playback = useMusicPlaybackStore();

  const [view, setView] = useState<View>('albums');
  const [albums, setAlbums] = useState<MusicAlbumRow[] | null>(null);
  const [artists, setArtists] = useState<MusicArtistRow[] | null>(null);
  const [artistAlbums, setArtistAlbums] = useState<MusicAlbumRow[] | null>(null);
  const [tracks, setTracks] = useState<MusicTrackRow[] | null>(null);
  const [favorites, setFavorites] = useState<MusicTrackRow[] | null>(null);
  const [openAlbum, setOpenAlbum] = useState<{ albumartist: string; album: string } | null>(null);
  const [albumTracks, setAlbumTracks] = useState<MusicTrackRow[] | null>(null);
  const [selectedArtist, setSelectedArtist] = useState<string | null>(null);

  const playFromList = useCallback(
    async (list: MusicTrackRow[], trackId: number) => {
      const startIndex = list.findIndex((t) => t.id === trackId);
      if (startIndex === -1) return;
      await playback.playQueue(
        list.map((t) => ({
          trackId: t.id,
          sourceId: t.source_id,
          title: t.title,
          artist: t.artist,
          albumartist: t.albumartist,
          duration: t.duration,
          path: t.path,
          codec: t.codec,
        })),
        startIndex
      );
      if (playback.errorMessage) addToast(playback.errorMessage, 'error');
    },
    [playback, addToast]
  );

  /** 收藏切换：乐观更新 + 失败回滚（列表操作统一纪律）。 */
  const toggleFavorite = useCallback(
    async (track: MusicTrackRow) => {
      const next = track.favorite === 1 ? 0 : 1;
      const patch = (list: MusicTrackRow[] | null): MusicTrackRow[] | null =>
        list ? list.map((t) => (t.id === track.id ? { ...t, favorite: next } : t)) : list;
      const prev = { tracks, albumTracks, favorites };
      setTracks(patch(tracks));
      setAlbumTracks(patch(albumTracks));
      setFavorites(
        favorites
          ? next === 1
            ? favorites.some((t) => t.id === track.id)
              ? patch(favorites)
              : [...favorites, { ...track, favorite: next }]
            : favorites.filter((t) => t.id !== track.id)
          : favorites
      );
      try {
        const res = (await window.electronAPI.setMusicFavorite(track.id, next === 1)) as {
          ok?: boolean;
        };
        if (res?.ok === false) throw new Error('收藏失败');
      } catch {
        setTracks(prev.tracks);
        setAlbumTracks(prev.albumTracks);
        setFavorites(prev.favorites);
        addToast('收藏失败，请重试', 'error');
      }
    },
    [tracks, albumTracks, favorites, addToast]
  );

  const loadAlbums = useCallback(async (): Promise<void> => {
    try {
      const res = (await window.electronAPI.getMusicAlbums(200)) as {
        ok: boolean;
        data?: { albums: MusicAlbumRow[] };
      };
      setAlbums(res.ok ? res.data?.albums ?? [] : null);
      if (!res.ok) addToast('加载专辑失败', 'error');
    } catch {
      setAlbums(null);
      addToast('加载专辑失败', 'error');
    }
  }, [addToast]);

  const loadArtists = useCallback(async (): Promise<void> => {
    try {
      const res = (await window.electronAPI.getMusicArtists(200)) as {
        ok: boolean;
        data?: { artists: MusicArtistRow[] };
      };
      setArtists(res.ok ? res.data?.artists ?? [] : null);
      if (!res.ok) addToast('加载歌手失败', 'error');
    } catch {
      setArtists(null);
      addToast('加载歌手失败', 'error');
    }
  }, [addToast]);

  const loadArtistAlbums = useCallback(
    async (artist: string): Promise<void> => {
      try {
        const res = (await window.electronAPI.getArtistAlbums(artist)) as {
          ok: boolean;
          data?: { albums: MusicAlbumRow[] };
        };
        setArtistAlbums(res.ok ? res.data?.albums ?? [] : null);
        if (!res.ok) addToast('加载专辑失败', 'error');
      } catch {
        setArtistAlbums(null);
        addToast('加载专辑失败', 'error');
      }
    },
    [addToast]
  );

  const loadAllTracks = useCallback(async (): Promise<void> => {
    try {
      const res = (await window.electronAPI.getMusicTracks(0, 200)) as {
        ok: boolean;
        data?: { tracks: MusicTrackRow[] };
      };
      setTracks(res.ok ? res.data?.tracks ?? [] : null);
      if (!res.ok) addToast('加载曲目失败', 'error');
    } catch {
      setTracks(null);
      addToast('加载曲目失败', 'error');
    }
  }, [addToast]);

  const loadFavorites = useCallback(async (): Promise<void> => {
    try {
      const res = (await window.electronAPI.getMusicFavorites(200)) as {
        ok: boolean;
        data?: { tracks: MusicTrackRow[] };
      };
      setFavorites(res.ok ? res.data?.tracks ?? [] : null);
      if (!res.ok) addToast('加载收藏失败', 'error');
    } catch {
      setFavorites(null);
      addToast('加载收藏失败', 'error');
    }
  }, [addToast]);

  const openAlbumTracks = useCallback(
    async (albumartist: string, album: string): Promise<void> => {
      try {
        const res = (await window.electronAPI.getAlbumTracks(albumartist, album)) as {
          ok: boolean;
          data?: { tracks: MusicTrackRow[] };
        };
        if (res.ok && res.data) {
          setOpenAlbum({ albumartist, album });
          setAlbumTracks(res.data.tracks);
        } else {
          addToast('加载专辑曲目失败', 'error');
        }
      } catch {
        addToast('加载专辑曲目失败', 'error');
      }
    },
    [addToast]
  );

  useEffect(() => {
    if (view === 'albums') void loadAlbums();
    else if (view === 'artists') {
      if (selectedArtist) void loadArtistAlbums(selectedArtist);
      else void loadArtists();
    } else if (view === 'all') void loadAllTracks();
    else void loadFavorites();
  }, [view, selectedArtist, loadAlbums, loadArtists, loadArtistAlbums, loadAllTracks, loadFavorites]);

  const tabClass = (active: boolean): string =>
    `px-3 py-1.5 text-xs rounded-lg border transition-colors focus-ring flex items-center gap-1.5 ${
      active ? 'bg-secondary border-border text-foreground' : 'border-border text-muted-foreground hover:bg-accent'
    }`;

  const switchView = (next: View): void => {
    setView(next);
    setOpenAlbum(null);
    setSelectedArtist(null);
  };

  const trackList = (list: MusicTrackRow[], showTrackNo?: boolean, subtitleFor?: (t: MusicTrackRow) => string) => (
    <div className="flex flex-col gap-1">
      {list.map((t) => (
        <TrackRow
          key={t.id}
          track={t}
          {...(showTrackNo ? { showTrackNo } : {})}
          {...(subtitleFor ? { subtitle: subtitleFor(t) } : {})}
          onPlay={() => void playFromList(list, t.id)}
          onToggleFavorite={() => void toggleFavorite(t)}
        />
      ))}
    </div>
  );

  return (
    <div className="h-full overflow-y-auto p-6">
      {/* 视图切换 */}
      <div className="flex flex-wrap items-center gap-2 mb-6">
        <button type="button" onClick={() => switchView('albums')} className={tabClass(view === 'albums')}>
          <Disc3 size={14} /> 专辑
        </button>
        <button type="button" onClick={() => switchView('artists')} className={tabClass(view === 'artists')}>
          <User size={14} /> 歌手
        </button>
        <button type="button" onClick={() => switchView('all')} className={tabClass(view === 'all')}>
          <ListMusic size={14} /> 全部曲目
        </button>
        <button type="button" onClick={() => switchView('favorites')} className={tabClass(view === 'favorites')}>
          <Heart size={14} /> 收藏
        </button>
      </div>

      {openAlbum ? (
        /* 专辑详情（曲目列表） */
        <div>
          <button
            type="button"
            onClick={() => setOpenAlbum(null)}
            className="text-xs text-muted-foreground hover:text-foreground mb-4 focus-ring"
          >
            ← 返回{selectedArtist ? '歌手' : '专辑'}
          </button>
          <h2 className="text-sm font-semibold mb-1">{openAlbum.album || '未知专辑'}</h2>
          <p className="text-[11px] text-muted-foreground mb-4">
            {openAlbum.albumartist || '未知歌手'} · {albumTracks?.length ?? 0} 首
          </p>
          {trackList(albumTracks ?? [], true, (t) =>
            t.artist && t.artist !== openAlbum.albumartist ? t.artist : ''
          )}
        </div>
      ) : view === 'albums' ? (
        albums && albums.length === 0 ? (
          <EmptyState
            icon={<Disc3 size={32} className="opacity-40" />}
            title="没有音乐"
            hint="在媒体库页添加音乐目录后扫描"
          />
        ) : (
          <AlbumGrid albums={albums ?? []} onOpen={(a, b) => void openAlbumTracks(a, b)} />
        )
      ) : view === 'artists' && selectedArtist ? (
        <div>
          <button
            type="button"
            onClick={() => setSelectedArtist(null)}
            className="text-xs text-muted-foreground hover:text-foreground mb-4 focus-ring"
          >
            ← 返回歌手
          </button>
          <h2 className="text-sm font-semibold mb-4">{selectedArtist || '未知歌手'}</h2>
          {artistAlbums && artistAlbums.length === 0 ? (
            <EmptyState icon={<Disc3 size={32} className="opacity-40" />} title="该歌手没有专辑" />
          ) : (
            <AlbumGrid albums={artistAlbums ?? []} onOpen={(a, b) => void openAlbumTracks(a, b)} />
          )}
        </div>
      ) : view === 'artists' ? (
        artists && artists.length === 0 ? (
          <EmptyState
            icon={<User size={32} className="opacity-40" />}
            title="没有歌手"
            hint="在媒体库页添加音乐目录后扫描"
          />
        ) : (
          <div className="flex flex-wrap gap-4">
            {(artists ?? []).map((artist, i) => (
              <button
                key={`${artist.albumartist}-${i}`}
                type="button"
                onClick={() => setSelectedArtist(artist.albumartist ?? '')}
                className="w-40 text-left group focus-ring"
              >
                <div className="aspect-square rounded-full bg-muted border border-border overflow-hidden mb-2 flex items-center justify-center">
                  {artist.cover_track_id ? (
                    <img
                      src={coverUrl(artist.cover_track_id) ?? ''}
                      alt=""
                      className="w-full h-full object-cover"
                      loading="lazy"
                    />
                  ) : (
                    <User size={28} className="text-muted-foreground opacity-40" />
                  )}
                </div>
                <p className="text-xs truncate group-hover:text-foreground">
                  {artist.albumartist || '未知歌手'}
                </p>
                <p className="text-[10px] text-muted-foreground truncate">
                  {artist.album_count} 张专辑 · {artist.track_count} 首
                </p>
              </button>
            ))}
          </div>
        )
      ) : view === 'all' ? (
        tracks && tracks.length === 0 ? (
          <EmptyState icon={<ListMusic size={32} className="opacity-40" />} title="没有曲目" />
        ) : (
          trackList(tracks ?? [])
        )
      ) : favorites && favorites.length === 0 ? (
        <EmptyState
          icon={<Heart size={32} className="opacity-40" />}
          title="还没有收藏"
          hint="在曲目列表点爱心即可收藏"
        />
      ) : (
        trackList(favorites ?? [])
      )}
    </div>
  );
}
