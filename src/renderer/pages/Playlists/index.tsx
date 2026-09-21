import { useCallback, useEffect, useState } from 'react';
import { Cloud, ListMusic, Plus, Download, Trash2, Pencil, ArrowUp, ArrowDown, Play, X, Music2, GripVertical } from 'lucide-react';
import { useToastStore } from '../../stores/toast-store';
import { useMusicPlaybackStore } from '../../stores/music-playback-store';
import ServerPlaylists from './ServerPlaylists';

/**
 * 歌单页（QYP3-015/017）：列表 + 详情 + m3u8/XSPF 导出。
 * m3u 导入在 1.5.0 移除（QYP3-068k）：路径匹配在服务器/WebDAV 混排的曲库里
 * 长期半失效，且导出已经覆盖了"搬到别处播"的诉求。
 * 排序（QYP3-015a）= 拖拽为主 + 上/下移按钮（键盘/触屏可达性兜底）；
 * 列表操作一律乐观更新 + 失败回滚。
 * P2：新增「服务器歌单」只读页签（服务器歌单不可在本应用内编辑）。
 */

const tabClass = (active: boolean): string =>
  `px-3 py-1.5 text-xs rounded-lg border transition-colors focus-ring flex items-center gap-1.5 ${
    active ? 'bg-secondary border-border text-foreground' : 'border-border text-muted-foreground hover:bg-accent'
  }`;

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
  // 页签（P2）：本地歌单可管理，服务器歌单只读
  const [tab, setTab] = useState<'local' | 'server'>('local');
  const [openId, setOpenId] = useState<number | null>(null);
  const [items, setItems] = useState<PlaylistItemRow[] | null>(null);
  const [newName, setNewName] = useState('');
  const [editing, setEditing] = useState<{ id: number; name: string } | null>(null);
  // 拖拽排序（QYP3-015a）：拖起项与被悬停项，仅用于样式反馈
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

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

  /**
   * 拖拽/按钮排序共用（QYP3-015a）：把 from 位置的条目整移到 to
   * （主进程事务整移，中间项顺移）。乐观重排 + 失败回滚。
   */
  const moveItem = useCallback(
    async (playlistId: number, from: number, to: number): Promise<void> => {
      const list = items ?? [];
      if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return;
      const prev = items;
      const copy = [...list];
      const [moved] = copy.splice(from, 1);
      copy.splice(to, 0, moved);
      setItems(copy.map((it, i) => ({ ...it, position: i })));
      const res = (await window.electronAPI.reorderPlaylistItem(playlistId, from, to)) as {
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

  const reorder = useCallback(
    (playlistId: number, position: number, direction: -1 | 1): void => {
      void moveItem(playlistId, position, position + direction);
    },
    [moveItem]
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
      <h1 className="text-2xl font-bold tracking-tight mb-4">歌单</h1>

      {/* 来源切换（P2）：本地歌单可增删改，服务器歌单只读 */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <button
          type="button"
          onClick={() => setTab('local')}
          aria-pressed={tab === 'local'}
          className={tabClass(tab === 'local')}
        >
          <ListMusic size={14} /> 我的歌单
        </button>
        <button
          type="button"
          onClick={() => setTab('server')}
          aria-pressed={tab === 'server'}
          className={tabClass(tab === 'server')}
        >
          <Cloud size={14} /> 服务器歌单
        </button>
      </div>

      {tab === 'server' ? (
        <ServerPlaylists />
      ) : (
        <>
      <div className="flex flex-wrap items-center gap-2 mb-6">
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
        /* 歌单列表：playlists === null 是加载中，此前会渲染成一块空白 */
        playlists === null ? (
          <div className="flex flex-col gap-2" aria-busy="true" aria-label="加载歌单">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-16 bg-card border border-border rounded-xl animate-pulse" />
            ))}
          </div>
        ) : current.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
            <ListMusic size={32} className="mb-3 opacity-40" />
            <p className="text-xs">还没有歌单</p>
            <p className="text-[11px] mt-1">在上方输入名称新建歌单</p>
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
          <p className="text-[10px] text-muted-foreground mb-2">拖动条目可调整顺序</p>
          <div className="flex flex-col gap-1">
            {(items ?? []).map((it) => (
              <div
                key={it.id}
                draggable
                aria-grabbed={dragIndex === it.position}
                onDragStart={(e) => {
                  setDragIndex(it.position);
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/plain', String(it.position));
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  if (overIndex !== it.position) setOverIndex(it.position);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  const raw = e.dataTransfer.getData('text/plain');
                  const from = dragIndex ?? (raw ? Number(raw) : NaN);
                  if (openId !== null && Number.isInteger(from)) void moveItem(openId, from, it.position);
                  setDragIndex(null);
                  setOverIndex(null);
                }}
                onDragEnd={() => {
                  setDragIndex(null);
                  setOverIndex(null);
                }}
                className={`flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-accent transition-colors ${
                  dragIndex === it.position ? 'opacity-50' : ''
                } ${overIndex === it.position && dragIndex !== it.position ? 'ring-1 ring-primary' : ''}`}
              >
                <span
                  aria-hidden
                  title="拖动可调整顺序"
                  className="text-muted-foreground/60 cursor-grab flex-shrink-0"
                >
                  <GripVertical size={14} />
                </span>
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
        </>
      )}
    </div>
  );
}
