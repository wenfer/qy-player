import { useCallback, useEffect, useState } from 'react';
import { Disc3, Music2 } from 'lucide-react';
import { useToastStore } from '../../stores/toast-store';
import { useMusicPlaybackStore } from '../../stores/music-playback-store';
import { buildImageUrl, getServerMap, type ServerEntry } from '../../utils/server-images';
import {
  mapServerAlbums,
  mapServerTracks,
  type MusicLibraryRef,
  type ServerAlbum,
  type ServerTrack,
} from '../../utils/server-music';

/**
 * 服务器音乐浏览（QYP3-025）：专辑网格 → 专辑曲目 → 播放（mpv 引擎）。
 * 与本地音乐页同纪律：网格自动换行（拒绝横向滚动）、异步操作 Toast。
 */

function fmtDuration(sec: number | null): string {
  if (!sec || sec <= 0) return '';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export default function ServerMusicBrowser({ library }: { library: MusicLibraryRef }) {
  const addToast = useToastStore((s) => s.addToast);
  const playback = useMusicPlaybackStore();
  const [serverMap, setServerMap] = useState<Map<number, ServerEntry>>(new Map());
  const [albums, setAlbums] = useState<ServerAlbum[] | null>(null);
  const [openAlbum, setOpenAlbum] = useState<ServerAlbum | null>(null);
  const [tracks, setTracks] = useState<ServerTrack[] | null>(null);

  useEffect(() => {
    void getServerMap()
      .then(setServerMap)
      .catch(() => undefined);
  }, []);

  const loadAlbums = useCallback(async (): Promise<void> => {
    try {
      const res = (await window.electronAPI.getItems(
        library.viewId,
        { includeItemTypes: 'MusicAlbum', recursive: true, sortBy: 'SortName' },
        library.serverId
      )) as unknown as Array<Record<string, unknown>>;
      setAlbums(mapServerAlbums(Array.isArray(res) ? res : []));
    } catch {
      setAlbums(null);
      addToast('加载服务器专辑失败', 'error');
    }
  }, [library, addToast]);

  const loadTracks = useCallback(
    async (album: ServerAlbum): Promise<void> => {
      try {
        const res = (await window.electronAPI.getItems(
          album.id,
          { includeItemTypes: 'Audio', sortBy: 'ParentIndexNumber,IndexNumber' },
          library.serverId
        )) as unknown as Array<Record<string, unknown>>;
        setOpenAlbum(album);
        setTracks(mapServerTracks(Array.isArray(res) ? res : []));
      } catch {
        addToast('加载专辑曲目失败', 'error');
      }
    },
    [library, addToast]
  );

  useEffect(() => {
    setOpenAlbum(null);
    setTracks(null);
    void loadAlbums();
  }, [loadAlbums]);

  const coverUrl = (album: ServerAlbum): string | undefined =>
    buildImageUrl(serverMap, library.serverId, library.serverType, album.id, 'Primary', album.tag ?? undefined, 300);

  const playFrom = useCallback(
    async (list: ServerTrack[], trackId: string): Promise<void> => {
      const startIndex = list.findIndex((t) => t.id === trackId);
      if (startIndex === -1) return;
      await playback.playQueue(
        list.map((t) => ({
          trackId: 0,
          sourceId: 0,
          serverId: library.serverId,
          provider: library.serverType === 'emby' ? ('emby' as const) : ('jellyfin' as const),
          itemId: t.id,
          title: t.name,
          artist: t.artist,
          albumartist: t.artist,
          duration: t.duration,
          path: '',
          codec: null,
        })),
        startIndex
      );
      if (playback.errorMessage) addToast(playback.errorMessage, 'error');
    },
    [playback, library, addToast]
  );

  return (
    <div>
      {openAlbum ? (
        <div>
          <button
            type="button"
            onClick={() => setOpenAlbum(null)}
            className="text-xs text-muted-foreground hover:text-foreground mb-4 focus-ring"
          >
            ← 返回专辑
          </button>
          <h2 className="text-sm font-semibold mb-1">{openAlbum.name}</h2>
          <p className="text-[11px] text-muted-foreground mb-4">
            {openAlbum.artist ?? '未知歌手'}
            {openAlbum.year ? ` · ${openAlbum.year}` : ''} · {tracks?.length ?? 0} 首
          </p>
          <div className="flex flex-col gap-1">
            {(tracks ?? []).map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => void playFrom(tracks ?? [], t.id)}
                className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-accent transition-colors text-left w-full"
              >
                <span className="text-xs text-muted-foreground w-6 text-right">{t.index ?? '–'}</span>
                <Music2 size={14} className="text-muted-foreground" />
                <span className="flex-1 min-w-0">
                  <span className="block text-xs truncate">{t.name}</span>
                  {t.artist && <span className="block text-[10px] text-muted-foreground truncate">{t.artist}</span>}
                </span>
                <span className="text-[10px] text-muted-foreground">{fmtDuration(t.duration)}</span>
              </button>
            ))}
          </div>
        </div>
      ) : albums && albums.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
          <Disc3 size={32} className="mb-3 opacity-40" />
          <p className="text-xs">这个音乐库还没有专辑</p>
        </div>
      ) : (
        <div className="flex flex-wrap gap-4">
          {(albums ?? []).map((album) => {
            const cover = coverUrl(album);
            return (
              <button
                key={album.id}
                type="button"
                onClick={() => void loadTracks(album)}
                className="w-40 text-left group focus-ring"
              >
                <div className="aspect-square rounded-lg bg-muted border border-border overflow-hidden mb-2 flex items-center justify-center">
                  {cover ? (
                    <img src={cover} alt="" className="w-full h-full object-cover" loading="lazy" />
                  ) : (
                    <Disc3 size={28} className="text-muted-foreground opacity-40" />
                  )}
                </div>
                <p className="text-xs truncate group-hover:text-foreground">{album.name}</p>
                <p className="text-[10px] text-muted-foreground truncate">
                  {album.artist ?? '未知歌手'}
                  {album.year ? ` · ${album.year}` : ''}
                </p>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
