import { useCallback, useEffect, useState } from 'react';
import { ListMusic, Music2 } from 'lucide-react';
import { useToastStore } from '../../stores/toast-store';
import { useMusicPlaybackStore } from '../../stores/music-playback-store';
import { mapServerPlaylists, mapServerTracks, isAudioItem, type ServerPlaylist } from '../../utils/server-music';

/**
 * 服务器歌单（P2，只读）：Jellyfin/Emby 的歌单原样浏览与播放，
 * 不在本地库里增删改（服务器歌单的写操作不在本期范围）。
 *
 * 与「我的歌单」同一纪律：网格/列表自动换行（拒绝横向滚动）、
 * 失败 Toast、播放走 mpv（服务器音频 → mpv，ADR-0007）。
 */

interface ServerPlaylistEntry extends ServerPlaylist {
  serverId: number;
  serverName: string;
  serverType: string;
}

interface ServerRow {
  id: number;
  name: string;
  type: string;
  is_active: number;
}

export default function ServerPlaylists() {
  const addToast = useToastStore((s) => s.addToast);
  const playback = useMusicPlaybackStore();
  const [playlists, setPlaylists] = useState<ServerPlaylistEntry[] | null>(null);
  const [open, setOpen] = useState<ServerPlaylistEntry | null>(null);
  const [tracks, setTracks] = useState<ReturnType<typeof mapServerTracks> | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const servers = ((await window.electronAPI.getServers()) as ServerRow[]) ?? [];
      const active = servers.filter((s) => s.is_active);
      const collected: ServerPlaylistEntry[] = [];
      let failures = 0;
      for (const server of active) {
        try {
          // 歌单列表没有专用端点：按类型查用户的 Items（Playlist 是可见项）
          const items = (await window.electronAPI.getItems(
            '',
            { includeItemTypes: 'Playlist', recursive: true },
            server.id
          )) as unknown[];
          for (const p of mapServerPlaylists(Array.isArray(items) ? items : [])) {
            collected.push({
              ...p,
              serverId: server.id,
              serverName: server.name,
              serverType: server.type,
            });
          }
        } catch {
          failures += 1;
        }
      }
      setPlaylists(collected);
      if (failures > 0) addToast(`${failures} 台服务器的歌单加载失败`, 'error');
    } catch {
      setPlaylists(null);
      addToast('加载服务器歌单失败', 'error');
    } finally {
      setLoading(false);
    }
  }, [addToast]);

  useEffect(() => {
    void load();
  }, [load]);

  const openPlaylist = useCallback(
    async (entry: ServerPlaylistEntry): Promise<void> => {
      try {
        // 歌单条目走规范端点 `/Playlists/{id}/Items`（顺序即歌单顺序）
        const items = (await window.electronAPI.getServerPlaylistItems(entry.id, entry.serverId)) as unknown[];
        const list = Array.isArray(items) ? items : [];
        setOpen(entry);
        setTracks(mapServerTracks(list.filter(isAudioItem)));
      } catch {
        addToast('加载歌单曲目失败', 'error');
      }
    },
    [addToast]
  );

  const playFrom = useCallback(
    async (list: ReturnType<typeof mapServerTracks>, trackId: string): Promise<void> => {
      if (!open) return;
      const startIndex = list.findIndex((t) => t.id === trackId);
      if (startIndex === -1) return;
      await playback.playQueue(
        list.map((t) => ({
          trackId: 0,
          sourceId: 0,
          serverId: open.serverId,
          provider: open.serverType === 'emby' ? ('emby' as const) : ('jellyfin' as const),
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
      // 实时 state（闭包里的 playback 是点击时的旧快照，读不到刚写下的错误）
      const failed = useMusicPlaybackStore.getState().errorMessage;
      if (failed) addToast(failed, 'error');
    },
    [open, playback, addToast]
  );

  if (open) {
    return (
      <div>
        <button
          type="button"
          onClick={() => setOpen(null)}
          className="text-xs text-muted-foreground hover:text-foreground mb-4 focus-ring"
        >
          ← 返回服务器歌单
        </button>
        <h2 className="text-sm font-semibold mb-1">{open.name}</h2>
        <p className="text-[11px] text-muted-foreground mb-4">
          {open.serverName} · 只读（服务器歌单在本应用内不可编辑）
        </p>
        {tracks && tracks.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            这个歌单里没有可播放的音乐（视频歌单请在服务器端或用视频库浏览）。
          </p>
        ) : (
          <div className="flex flex-col gap-1">
            {(tracks ?? []).map((t, i) => (
              <button
                key={`${t.id}-${i}`}
                type="button"
                onClick={() => void playFrom(tracks ?? [], t.id)}
                className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-accent transition-colors text-left w-full focus-ring"
              >
                <span className="text-xs text-muted-foreground w-6 text-right">
                  {t.index ?? i + 1}
                </span>
                <Music2 size={14} className="text-muted-foreground flex-shrink-0" />
                <span className="flex-1 min-w-0">
                  <span className="block text-xs truncate">{t.name}</span>
                  <span className="block text-[10px] text-muted-foreground truncate">
                    {[t.artist, t.album].filter(Boolean).join(' · ') || '未知歌手'}
                  </span>
                </span>
                {t.duration ? (
                  <span className="text-[10px] text-muted-foreground">
                    {Math.floor(t.duration / 60)}:{String(Math.floor(t.duration % 60)).padStart(2, '0')}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (loading) {
    return <p className="text-xs text-muted-foreground py-8">正在读取服务器歌单…</p>;
  }

  if (!playlists || playlists.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
        <ListMusic size={32} className="opacity-40" />
        <p className="text-xs mt-3">服务器上没有歌单</p>
        <p className="text-[11px] mt-1">服务器歌单在服务器端创建，这里只读浏览与播放</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      {playlists.map((entry, i) => (
        <div
          key={`${entry.serverId}-${entry.id}-${i}`}
          className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-accent transition-colors"
        >
          <ListMusic size={14} className="text-muted-foreground flex-shrink-0" />
          <button
            type="button"
            onClick={() => void openPlaylist(entry)}
            className="flex-1 min-w-0 text-left focus-ring"
          >
            <span className="block text-xs truncate">{entry.name}</span>
            <span className="block text-[10px] text-muted-foreground truncate">
              {entry.serverName}
              {entry.itemCount !== null ? ` · ${entry.itemCount} 首` : ''}
              {' · 只读'}
            </span>
          </button>
        </div>
      ))}
    </div>
  );
}
