import { useCallback, useEffect, useState } from 'react';
import { Disc3, ListMusic, Music2 } from 'lucide-react';
import { useToastStore } from '../../stores/toast-store';
import { useMusicPlaybackStore } from '../../stores/music-playback-store';
import type { MusicAlbumRow, MusicTrackRow } from '../../../shared/types/music';

/**
 * 音乐库页（三期 QYP3-008）：专辑网格 + 专辑曲目 + 全部曲目。
 * 来源 = 本地/WebDAV 音频（服务器音频查询三期未开放）。
 * 版式：拒绝横向滚动（1280×800 实测约束），网格自动换行。
 */

const coverUrl = (trackId: number | null): string | null =>
  trackId ? `qy-file://covers/${trackId}.png` : null;

function fmtDuration(sec: number | null): string {
  if (!sec || sec <= 0) return '';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export default function MusicPage() {
  const addToast = useToastStore((s) => s.addToast);
  const playback = useMusicPlaybackStore();

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
  const [view, setView] = useState<'albums' | 'all'>('albums');
  const [albums, setAlbums] = useState<MusicAlbumRow[] | null>(null);
  const [tracks, setTracks] = useState<MusicTrackRow[] | null>(null);
  const [openAlbum, setOpenAlbum] = useState<{ albumartist: string; album: string } | null>(null);
  const [albumTracks, setAlbumTracks] = useState<MusicTrackRow[] | null>(null);

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
    else void loadAllTracks();
  }, [view, loadAlbums, loadAllTracks]);


  return (
    <div className="h-full overflow-y-auto p-6">
      {/* 视图切换 */}
      <div className="flex items-center gap-2 mb-6">
        <button
          type="button"
          onClick={() => {
            setView('albums');
            setOpenAlbum(null);
          }}
          className={`px-3 py-1.5 text-xs rounded-lg border transition-colors focus-ring flex items-center gap-1.5 ${
            view === 'albums' ? 'bg-secondary border-border text-foreground' : 'border-border text-muted-foreground hover:bg-accent'
          }`}
        >
          <Disc3 size={14} /> 专辑
        </button>
        <button
          type="button"
          onClick={() => setView('all')}
          className={`px-3 py-1.5 text-xs rounded-lg border transition-colors focus-ring flex items-center gap-1.5 ${
            view === 'all' ? 'bg-secondary border-border text-foreground' : 'border-border text-muted-foreground hover:bg-accent'
          }`}
        >
          <ListMusic size={14} /> 全部曲目
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
            ← 返回专辑
          </button>
          <h2 className="text-sm font-semibold mb-1">
            {openAlbum.album || '未知专辑'}
          </h2>
          <p className="text-[11px] text-muted-foreground mb-4">
            {openAlbum.albumartist || '未知歌手'} · {albumTracks?.length ?? 0} 首
          </p>
          <div className="flex flex-col gap-1">
            {(albumTracks ?? []).map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => void playFromList(albumTracks ?? [], t.id)}
                className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-accent transition-colors text-left w-full"
              >
                <span className="text-xs text-muted-foreground w-6 text-right">
                  {t.track_no ?? '–'}
                </span>
                <Music2 size={14} className="text-muted-foreground" />
                <div className="flex-1 min-w-0">
                  <p className="text-xs truncate">{t.title}</p>
                  {t.artist && t.artist !== openAlbum.albumartist && (
                    <p className="text-[10px] text-muted-foreground truncate">{t.artist}</p>
                  )}
                </div>
                <span className="text-[10px] text-muted-foreground">{fmtDuration(t.duration)}</span>
                {t.has_lyrics ? <span className="text-[10px] text-muted-foreground">词</span> : null}
              </button>
            ))}
          </div>
        </div>
      ) : view === 'albums' ? (
        /* 专辑网格 */
        (albums ?? []).length === 0 && albums !== null ? (
          <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
            <Disc3 size={32} className="mb-3 opacity-40" />
            <p className="text-xs">没有音乐</p>
            <p className="text-[11px] mt-1">在媒体库页添加音乐目录后扫描</p>
          </div>
        ) : (
          <div className="flex flex-wrap gap-4">
            {(albums ?? []).map((album, i) => (
              <button
                key={`${album.albumartist}-${album.album}-${i}`}
                type="button"
                onClick={() => void openAlbumTracks(album.albumartist ?? '', album.album ?? '')}
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
                <p className="text-xs truncate group-hover:text-foreground">
                  {album.album || '未知专辑'}
                </p>
                <p className="text-[10px] text-muted-foreground truncate">
                  {album.albumartist || '未知歌手'} · {album.track_count} 首
                </p>
              </button>
            ))}
          </div>
        )
      ) : (
        /* 全部曲目 */
        (tracks ?? []).length === 0 && tracks !== null ? (
          <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
            <ListMusic size={32} className="mb-3 opacity-40" />
            <p className="text-xs">没有曲目</p>
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            {(tracks ?? []).map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => void playFromList(tracks ?? [], t.id)}
                className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-accent transition-colors text-left w-full"
              >
                <Music2 size={14} className="text-muted-foreground" />
                <div className="flex-1 min-w-0">
                  <p className="text-xs truncate">{t.title}</p>
                  <p className="text-[10px] text-muted-foreground truncate">
                    {[t.artist, t.album].filter(Boolean).join(' · ') || '未知歌手'}
                  </p>
                </div>
                <span className="text-[10px] text-muted-foreground">{fmtDuration(t.duration)}</span>
              </button>
            ))}
          </div>
        )
      )}
    </div>
  );
}
