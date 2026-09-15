import { useCallback, useEffect, useState } from 'react';
import { ListMusic, Plus, Upload, Download, Trash2, Pencil, ArrowUp, ArrowDown, Play, X, Music2 } from 'lucide-react';
import { useToastStore } from '../../stores/toast-store';
import { useMusicPlaybackStore } from '../../stores/music-playback-store';

/**
 * 歌单页（QYP3-015/016/017）：列表 + 详情 + m3u/m3u8 导入 + m3u8/XSPF 导出。
 * 排序 = 上/下移（拖拽列 P1）；列表操作乐观更新 + 失败回滚。
 */

interface PlaylistRow {
  id: number;
  name: string;
  track_count: number;
  created_at: number;
  updated_at: number;
}

interface PlaylistItemRow {
  id: number;
  position: number;
  item_ref: string;
  track: {
    id: number;
    source_id: number;
    path: string;
    title: string;
    artist: string | null;
    albumartist: string | null;
    duration: number | null;
    codec: string | null;
  } | null;
}

function fmtDuration(sec: number | null): string {
  if (!sec || sec <= 0) return '';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export default function PlaylistsPage() {
  const addToast = useToastStore((s) => s.addToast);
  const playback = useMusicPlaybackStore();
  const [playlists, setPlaylists] = useState<PlaylistRow[] | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const [items, setItems] = useState<PlaylistItemRow[] | null>(null);
  const [newName, setNewName] = useState('');
  const [editing, setEditing] = useState<{ id: number; name: string } | null>(null);

  const loadPlaylists = useCallback(async (): Promise<void> => {
    try {
      const res = (await window.electronAPI.listPlaylists()) as {
        ok: boolean;
        data?: { playlists: PlaylistRow[] };
      };
      setPlaylists(res.ok ? res.data?.playlists ?? [] : null);
    } catch {
      setPlaylists(null);
    }
  }, []);

  const loadItems = useCallback(async (id: number): Promise<void> => {
    const res = (await window.electronAPI.getPlaylistItems(id)) as {
      ok: boolean;
      data?: { items: PlaylistItemRow[] };
    };
    setItems(res.ok ? res.data?.items ?? [] : null);
  }, []);

  useEffect(() => {
    void loadPlaylists();
  }, [loadPlaylists]);

  useEffect(() => {
    if (openId !== null) void loadItems(openId);
  }, [openId, loadItems]);

  const create = useCallback(async (): Promise<void> => {
    const name = newName.trim();
    if (!name) return;
    const res = (await window.electronAPI.createPlaylist(name)) as { ok: boolean };
    if (res.ok) {
      setNewName('');
      void loadPlaylists();
      addToast(`歌单「${name}」已创建`, 'success');
    } else {
      addToast('创建失败，请重试', 'error');
    }
  }, [newName, loadPlaylists, addToast]);

  const rename = useCallback(async (): Promise<void> => {
    if (!editing) return;
    const name = editing.name.trim();
    if (!name) return;
    const res = (await window.electronAPI.renamePlaylist(editing.id, name)) as { ok: boolean };
    if (res.ok) {
      setEditing(null);
      void loadPlaylists();
      addToast('歌单已重命名', 'success');
    } else {
      addToast('重命名失败，请重试', 'error');
    }
  }, [editing, loadPlaylists, addToast]);

  const del = useCallback(
    async (id: number, name: string): Promise<void> => {
      if (!window.confirm(`删除歌单「${name}」？曲目文件不受影响。`)) return;
      const res = (await window.electronAPI.deletePlaylist(id)) as { ok: boolean };
      if (res.ok) {
        if (openId === id) setOpenId(null);
        void loadPlaylists();
        addToast('歌单已删除', 'success');
      } else {
        addToast('删除失败，请重试', 'error');
      }
    },
    [loadPlaylists, setOpenId, addToast]
  );

  const importM3u = useCallback(async (): Promise<void> => {
    const res = (await window.electronAPI.importPlaylistFile()) as {
      ok: boolean;
      data?: { imported: { playlistId: number; name: string; matched: number } | null; unmatched: number; report?: string };
      error?: { message: string };
    };
    if (!res.ok) {
      addToast(res.error?.message ?? '导入失败', 'error');
      return;
    }
    if (res.data?.imported) {
      addToast(
        `已导入「${res.data.imported.name}」：${res.data.imported.matched} 首` +
          (res.data.unmatched > 0 ? `（${res.data.unmatched} 首未匹配跳过）` : ''),
        'success'
      );
      void loadPlaylists();
    } else if (res.data?.report) {
      addToast(res.data.report, 'warning');
    }
  }, [loadPlaylists, addToast]);

  const exportM3u8 = useCallback(
    async (id: number, name: string): Promise<void> => {
      const res = (await window.electronAPI.exportPlaylistM3u8(id)) as {
        ok: boolean;
        data?: { saved?: string };
      };
      if (res.ok && res.data?.saved) addToast(`已导出 m3u8（${name}）`, 'success');
    },
    [addToast]
  );

  const exportXspf = useCallback(
    async (id: number, name: string): Promise<void> => {
      const res = (await window.electronAPI.exportPlaylistXspf(id)) as { ok: boolean; data?: { saved?: string } };
      if (res.ok && res.data?.saved) addToast(`已导出 XSPF（${name}）`, 'success');
    },
    [addToast]
  );

  const removeItem = useCallback(
    async (playlistId: number, position: number): Promise<void> => {
      // 乐观更新 + 失败回滚
      const prev = items;
      setItems((cur) => (cur ?? []).filter((it) => it.position !== position).map((it, i) => ({ ...it, position: i })));
      const res = (await window.electronAPI.removeFromPlaylist(playlistId, position)) as { ok: boolean; data?: { removed: boolean } };
      if (!res.ok || !res.data?.removed) {
        setItems(prev ?? null);
        addToast('移除失败，请重试', 'error');
      } else {
        void loadPlaylists();
      }
    },
    [items, loadPlaylists, addToast]
  );

  const reorder = useCallback(
    async (playlistId: number, position: number, direction: -1 | 1): Promise<void> => {
      const to = position + direction;
      if (to < 0 || to >= (items?.length ?? 0)) return;
      // 乐观重排
      const swap = (arr: PlaylistItemRow[]): PlaylistItemRow[] => {
        const a = arr.findIndex((i) => i.position === position);
        const b = arr.findIndex((i) => i.position === to);
        if (a === -1 || b === -1) return arr;
        const copy = [...arr];
        [copy[a], copy[b]] = [copy[b], copy[a]];
        return copy.map((it, i) => ({ ...it, position: i }));
      };
      const prev = items;
      setItems((cur) => swap(cur ?? []));
      const res = (await window.electronAPI.reorderPlaylistItem(playlistId, position, to)) as {
        ok: boolean;
        data?: { reordered: boolean };
      };
      if (!res.ok || !res.data?.reordered) {
        setItems(prev ?? null);
        addToast('排序失败', 'error');
      }
    },
    [items, addToast]
  );

  const playFrom = useCallback(
    async (playlistId: number, position: number): Promise<void> => {
      const all = items ?? [];
      const start = all.find((i) => i.position === position);
      if (!start?.track) return;
      const playable = all.filter((i) => i.track) as PlaylistItemRow[];
      void playlistId;
      await playback.playQueue(
        playable.map((i) => ({
          trackId: i.track!.id,
          sourceId: i.track!.source_id,
          title: i.track!.title,
          artist: i.track!.artist,
          albumartist: i.track!.albumartist,
          duration: i.track!.duration,
          path: i.track!.path,
          codec: i.track!.codec,
        })),
        Math.max(0, playable.findIndex((i) => i.id === start.id))
      );
    },
    [items, playback]
  );

  const current = playlists ?? [];
  const openName = current.find((p) => p.id === openId)?.name ?? '';

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="flex flex-wrap items-center gap-2 mb-6">
        <button
          type="button"
          onClick={() => void importM3u()}
          className="px-3 py-1.5 text-xs border border-border rounded-lg hover:bg-accent focus-ring flex items-center gap-1.5"
        >
          <Upload size={13} /> 导入 m3u/m3u8
        </button>
        <div className="flex items-center gap-1.5">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="新歌单名称"
            maxLength={128}
            className="bg-input border border-border rounded-lg px-2 py-1.5 text-xs focus-ring w-40"
          />
          <button
            type="button"
            onClick={() => void create()}
            disabled={!newName.trim()}
            className="px-3 py-1.5 text-xs bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 focus-ring flex items-center gap-1 disabled:opacity-50"
          >
            <Plus size={13} /> 新建
          </button>
        </div>
      </div>

      {openId === null ? (
        /* 歌单列表 */
        current.length === 0 && playlists !== null ? (
          <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
            <ListMusic size={32} className="mb-3 opacity-40" />
            <p className="text-xs">还没有歌单</p>
            <p className="text-[11px] mt-1">新建歌单或导入 m3u 文件</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {current.map((p) => (
              <div key={p.id} className="bg-card border border-border rounded-xl p-4 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => setOpenId(p.id)}
                  className="flex items-center gap-3 flex-1 min-w-0 text-left focus-ring"
                >
                  <ListMusic size={16} className="text-muted-foreground" />
                  <div className="min-w-0">
                    <p className="text-sm truncate">{p.name}</p>
                    <p className="text-[11px] text-muted-foreground">{p.track_count} 首</p>
                  </div>
                </button>
                {editing?.id === p.id ? (
                  <div className="flex items-center gap-1.5">
                    <input
                      type="text"
                      value={editing.name}
                      onChange={(e) => setEditing({ id: p.id, name: e.target.value })}
                      className="bg-input border border-border rounded-lg px-2 py-1 text-xs focus-ring w-32"
                    />
                    <button type="button" onClick={() => void rename()} className="text-xs px-2 py-1 bg-primary text-primary-foreground rounded-lg focus-ring" aria-label="确认重命名">
                      ✓
                    </button>
                    <button type="button" onClick={() => setEditing(null)} className="p-1 rounded hover:bg-accent text-muted-foreground focus-ring" aria-label="取消">
                      <X size={12} />
                    </button>
                  </div>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => setEditing({ id: p.id, name: p.name })}
                      aria-label="重命名歌单"
                      className="p-1.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground focus-ring"
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      type="button"
                      onClick={() => void exportM3u8(p.id, p.name)}
                      aria-label="导出 m3u8"
                      className="p-1.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground focus-ring"
                    >
                      <Download size={13} />
                    </button>
                    <button
                      type="button"
                      onClick={() => void exportXspf(p.id, p.name)}
                      aria-label="导出 XSPF"
                      className="p-1.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground focus-ring"
                    >
                      <ListMusic size={13} />
                    </button>
                    <button
                      type="button"
                      onClick={() => void del(p.id, p.name)}
                      aria-label="删除歌单"
                      className="p-1.5 rounded hover:bg-accent text-destructive hover:text-destructive focus-ring"
                    >
                      <Trash2 size={13} />
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
        )
      ) : (
        /* 歌单详情 */
        <div>
          <div className="flex flex-wrap items-center gap-3 mb-4">
            <button
              type="button"
              onClick={() => setOpenId(null)}
              className="text-xs text-muted-foreground hover:text-foreground focus-ring"
            >
              ← 返回歌单列表
            </button>
            <h2 className="text-sm font-semibold">{openName}</h2>
            {(items ?? []).some((i) => i.track) && (
              <button
                type="button"
                onClick={() => void playFrom(openId, 0)}
                className="px-3 py-1.5 text-xs bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 focus-ring flex items-center gap-1.5"
              >
                <Play size={12} /> 播放
              </button>
            )}
          </div>
          <div className="flex flex-col gap-1">
            {(items ?? []).map((it) => (
              <div key={it.id} className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-accent transition-colors">
                <Music2 size={14} className="text-muted-foreground" />
                <button
                  type="button"
                  onClick={() => void playFrom(openId, it.position)}
                  className="flex-1 min-w-0 text-left"
                >
                  <p className={`text-xs truncate ${it.track ? '' : 'text-muted-foreground line-through'}`}>
                    {it.track?.title ?? '（音轨已失效）'}
                  </p>
                  <p className="text-[10px] text-muted-foreground truncate">
                    {it.track ? [it.track.artist, it.track.albumartist].filter(Boolean).join(' · ') || '未知歌手' : it.item_ref}
                  </p>
                </button>
                <span className="text-[10px] text-muted-foreground">{fmtDuration(it.track?.duration ?? null)}</span>
                <div className="flex items-center gap-0.5">
                  <button
                    type="button"
                    onClick={() => void reorder(openId, it.position, -1)}
                    disabled={it.position === 0}
                    aria-label="上移"
                    className="p-1 rounded hover:bg-accent text-muted-foreground focus-ring disabled:opacity-30"
                  >
                    <ArrowUp size={12} />
                  </button>
                  <button
                    type="button"
                    onClick={() => void reorder(openId, it.position, 1)}
                    disabled={it.position === (items?.length ?? 0) - 1}
                    aria-label="下移"
                    className="p-1 rounded hover:bg-accent text-muted-foreground focus-ring disabled:opacity-30"
                  >
                    <ArrowDown size={12} />
                  </button>
                  <button
                    type="button"
                    onClick={() => void removeItem(openId, it.position)}
                    aria-label="从歌单移除"
                    className="p-1 rounded hover:bg-accent text-destructive focus-ring"
                  >
                    <X size={12} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
