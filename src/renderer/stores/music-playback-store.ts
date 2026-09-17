import { create } from 'zustand';
import { WebAudioEngine, type QueueTrack, type RepeatMode } from '../player/web-audio-engine';
import type { MediaRef } from '../../shared/types/catalog';

/**
 * 音乐播放状态（QYP3-010/011/014）。
 *
 * 引擎归一（ADR-0007）：renderer 引擎与 mpv 引擎共用这一个状态面——
 * mpv 引擎沿用主进程 player:on-state-change 事件（PlayerControls 已接）；
 * renderer 引擎在此单点驱动并向上节流上报进度（≤10s + 收尾）。
 * direct 解码失败 → 回退 mpv 引擎一次（ADR-0007）。
 */

type EngineExtTrack = QueueTrack & { trackId: number; sourceId: number; mediaId: string };

export interface MusicPlayingState {
  engine: 'webaudio' | 'mpv' | null;
  current: QueueTrack | null;
  position: number;
  duration: number;
  isPlaying: boolean;
  queueLength: number;
  queueIndex: number;
  repeat: RepeatMode;
  shuffle: boolean;
  errorMessage: string | null;
  /** 引擎队列快照（next/prev 后恢复 current；不进渲染热点）。 */
  queueSnapshot: EngineExtTrack[];
  /** 服务器音乐队列（QYP3-025）：mpv 引擎下靠它推进上下曲。 */
  serverQueue: MusicTrackInput[];
  serverIndex: number;
}

export interface MusicPlaybackStore extends MusicPlayingState {
  playQueue: (tracks: MusicTrackInput[], startIndex: number) => Promise<void>;
  pause: () => void;
  resume: () => void;
  next: () => Promise<void>;
  prev: () => Promise<void>;
  seek: (position: number) => void;
  setRepeat: (mode: RepeatMode) => void;
  toggleShuffle: () => void;
  clearError: () => void;
  /** 拾音器（QYP3-023）：实时频谱快照；非 renderer 引擎返回 null。 */
  getSpectrum: () => Uint8Array | null;
  /** 服务器队列内跳转（QYP3-025）：mpv 引擎的上下曲靠它推进。 */
  playServerAt: (index: number) => Promise<void>;
}

let engineSingleton: WebAudioEngine | null = null;
let lastReportAt = 0;
/** 播放令牌：新 playQueue 使旧 playCurrent 竞态失效（重复点击防护）。 */
let playToken = 0;
/** 当前曲目的歌词原文（桌面歌词用；QYP3-022）。 */
let currentLyrics: string | null = null;
let lastDeskPushAt = 0;

/** 桌面歌词推送（≤10Hz；窗口未开时 main 侧直接丢弃）。 */
function pushDeskLyrics(position: number, isPlaying: boolean): void {
  const now = Date.now();
  if (now - lastDeskPushAt < 100) return;
  lastDeskPushAt = now;
  const s = useMusicPlaybackStore.getState();
  void window.electronAPI.pushDeskLyricsState({
    title: s.current?.title ?? '',
    content: currentLyrics,
    position,
    isPlaying,
  });
}

/** MediaRef 构造（QYP3-025）：服务器曲目按 serverId 严格路由。 */
export function refOfTrack(t: MusicTrackInput): MediaRef {
  if (t.serverId && t.itemId) {
    return { provider: t.provider ?? 'jellyfin', serverId: t.serverId, itemId: t.itemId };
  }
  return { provider: 'music', sourceId: t.sourceId, itemId: String(t.trackId) };
}

/** 换曲时重新拉取歌词（缓存读取，失败静默=无词）。 */
function loadLyricsFor(trackId: number): void {
  currentLyrics = null;
  void window.electronAPI
    .getMusicLyrics(trackId)
    .then((res) => {
      const data = (res as { data?: { content?: string | null } })?.data;
      currentLyrics = typeof data?.content === 'string' ? data.content : null;
      pushDeskLyrics(0, true);
    })
    .catch(() => {
      currentLyrics = null;
    });
}

function getEngine(): WebAudioEngine {
  if (!engineSingleton) {
    engineSingleton = new WebAudioEngine();
    engineSingleton.onTime = (position, duration) => {
      const s = useMusicPlaybackStore.getState();
      if (s.engine === 'mpv') return; // mpv 引擎状态由主进程事件驱动
      useMusicPlaybackStore.setState({ position, duration: duration || s.duration });
      pushDeskLyrics(position, true);
      const now = Date.now();
      if (now - lastReportAt >= 10_000) {
        lastReportAt = now;
        reportProgress(false);
      }
    };
    engineSingleton.onEnded = () => {
      // 收尾保存上一曲（final=false 已在 onTime 覆盖；这里只推进）
      void useMusicPlaybackStore.getState().next();
    };
    engineSingleton.onPlaying = (isPlaying) => {
      const s = useMusicPlaybackStore.getState();
      if (s.engine === 'mpv') return;
      useMusicPlaybackStore.setState({ isPlaying });
    };
    engineSingleton.onError = () => {
      const s = useMusicPlaybackStore.getState();
      if (s.engine === 'mpv') return;
      void fallbackToMpv();
    };
  }
  return engineSingleton;
}

function reportProgress(final: boolean): void {
  const s = useMusicPlaybackStore.getState();
  if (s.engine !== 'webaudio' || !s.current) return;
  void window.electronAPI.reportMusicProgress({
    mediaId: (s.current as EngineExtTrack).mediaId,
    title: s.current.title,
    position: s.position,
    duration: s.duration,
    isFinished: final,
  });
}

/** 音频链设置读取（QYP3-012）：EQ dB 数组 + ReplayGain 模式。 */
async function readAudioChainSettings(): Promise<[number[] | null, string | null]> {
  try {
    const eqRes = (await window.electronAPI.getSettings('playback.eqGains')) as {
      ok?: boolean;
      data?: unknown;
    };
    const eqValue = eqRes?.data;
    let eqGains: number[] | null = null;
    if (Array.isArray(eqValue)) {
      eqGains = eqValue.map((v) => Number(v) || 0);
    }
    const rgRes = (await window.electronAPI.getSettings('playback.replaygain')) as { data?: unknown };
    const rg = typeof rgRes?.data === 'string' ? rgRes.data : null;
    return [eqGains, rg && rg !== 'off' ? rg : null];
  } catch {
    return [null, null];
  }
}

/**
 * 队列输入（QYP3-025 扩展）：本地音轨（trackId/sourceId）或服务器音频
 * 条目（serverId/provider/itemId）。二者互斥——服务器曲目一律走 mpv
 * 引擎（ADR-0007：服务器 → mpv）。
 */
export interface MusicTrackInput {
  /** 本地音轨 id；服务器曲目为 0。 */
  trackId: number;
  /** 本地来源 id；服务器曲目为 0。 */
  sourceId: number;
  serverId?: number;
  provider?: 'jellyfin' | 'emby';
  /** 服务器条目 id（Jellyfin/Emby Audio）。 */
  itemId?: string;
  title: string;
  artist: string | null;
  albumartist: string | null;
  duration: number | null;
  path: string;
  codec: string | null;
}

async function fallbackToMpv(): Promise<void> {
  const s = useMusicPlaybackStore.getState();
  if (s.engine !== 'webaudio' || !s.current) return;
  const cur = s.current as EngineExtTrack;
  const resolution = (await window.electronAPI.resolvePlayback(
    { provider: 'music', sourceId: cur.sourceId, itemId: String(cur.trackId) },
    { engineForce: 'mpv' }
  )) as { ok: boolean; data?: { url: string; startPosition: number; mediaContext?: unknown }; error?: { message: string } };
  if (!resolution.ok || !resolution.data) {
    useMusicPlaybackStore.setState({
      engine: null,
      isPlaying: false,
      errorMessage: resolution.error?.message ?? '播放失败',
    });
    return;
  }
  engineSingleton?.pause();
  useMusicPlaybackStore.setState({ engine: 'mpv', isPlaying: false });
  const [eqGains, replaygain] = await readAudioChainSettings();
  await window.electronAPI.playerLoadFile(
    resolution.data.url,
    resolution.data.startPosition > 0 ? resolution.data.startPosition : undefined,
    undefined,
    resolution.data.mediaContext as Parameters<typeof window.electronAPI.playerLoadFile>[3],
    undefined,
    { ...(eqGains ? { eqGains } : {}), ...(replaygain ? { replaygain } : {}) }
  );
}

export const useMusicPlaybackStore = create<MusicPlaybackStore>((set, get) => ({
  engine: null,
  current: null,
  position: 0,
  duration: 0,
  isPlaying: false,
  queueLength: 0,
  queueIndex: 0,
  repeat: 'off',
  shuffle: false,
  errorMessage: null,
  queueSnapshot: [],
  serverQueue: [],
  serverIndex: -1,

  playQueue: async (tracks, startIndex) => {
    const start = tracks[startIndex];
    if (!start) return;
    const token = ++playToken;
    try {
      const resolution = (await window.electronAPI.resolvePlayback(
        refOfTrack(start)
      )) as {
        ok: boolean;
        data?: {
          kind: string;
          url: string;
          startPosition: number;
          engine?: { engine: 'webaudio' | 'mpv'; reason: string };
          mediaContext?: unknown;
        };
        error?: { message: string };
      };
      if (!resolution.ok || !resolution.data) {
        set({ errorMessage: resolution.error?.message ?? '解析播放地址失败' });
        return;
      }
      if (token !== playToken) return; // 期间又点了新曲目：让位
      const { url, startPosition, engine, mediaContext } = resolution.data;

      if (engine?.engine === 'webaudio') {
        // 整队逐曲解析（webaudio 判定单源在主进程）；解析失败的曲跳过
        const queue: EngineExtTrack[] = [];
        for (const t of tracks) {
          const r = (await window.electronAPI.resolvePlayback(refOfTrack(t))) as typeof resolution;
          if (r.ok && r.data?.engine?.engine === 'webaudio') {
            queue.push({
              id: t.trackId,
              title: t.title,
              artist: t.artist,
              album: null,
              albumartist: t.albumartist,
              duration: t.duration,
              url: r.data.url,
              trackId: t.trackId,
              sourceId: t.sourceId,
              mediaId: (r.data.mediaContext as { mediaId: string } | undefined)?.mediaId ?? t.path,
            });
          }
        }
        const idx = Math.max(0, queue.findIndex((q) => q.id === start.trackId));
        if (token !== playToken) return;
        const engineInstance = getEngine();
        // QYP3-012：webaudio 引擎读 EQ 设置直连 BiquadFilter
        const [eqGains] = await readAudioChainSettings();
        if (eqGains) engineInstance.setEq(eqGains);
        lastReportAt = Date.now();
        await engineInstance.playQueue(queue, idx, get().repeat, get().shuffle);
        const st = engineInstance.queueState;
        void window.electronAPI.setMusicEngineActive(true); // 媒体键双用途路由
        set({
          engine: 'webaudio',
          current: engineSnapshotCurrent(queue, st.currentTrackId),
          position: 0,
          duration: queue[idx]?.duration ?? 0,
          isPlaying: true,
          queueLength: st.length,
          queueIndex: st.index,
          queueSnapshot: queue,
          errorMessage: null,
        });
        loadLyricsFor(queue[idx]?.trackId ?? start.trackId);
      } else {
        // mpv 引擎接管：本地冷门格式（QYP3-011）或服务器音频（QYP3-025）。
        // 音乐激活态解除（媒体键回到视频语义）
        void window.electronAPI.setMusicEngineActive(false);
        set({
          engine: 'mpv',
          current: {
            id: start.trackId,
            title: start.title,
            artist: start.artist,
            album: null,
            albumartist: start.albumartist,
            duration: start.duration,
            url,
          },
          position: 0,
          duration: start.duration ?? 0,
          isPlaying: true,
          errorMessage: null,
          // 服务器队列（本地冷门格式时为单曲，上下曲无队列可走）
          serverQueue: start.serverId ? tracks : [],
          serverIndex: start.serverId ? startIndex : -1,
        });
        // QYP3-012：mpv 引擎同样带 EQ/ReplayGain（设置在主进程消费）
        const [eqGains, replaygain] = await readAudioChainSettings();
        await window.electronAPI.playerLoadFile(
          url,
          startPosition > 0 ? startPosition : undefined,
          undefined,
          mediaContext as Parameters<typeof window.electronAPI.playerLoadFile>[3],
          undefined,
          { ...(eqGains ? { eqGains } : {}), ...(replaygain ? { replaygain } : {}) },
        );
        // 服务器曲目无本地歌词缓存（QYP3-020b 接服务器歌词前先清空，
        // 否则桌面歌词会残留上一首的原文）
        if (start.serverId) currentLyrics = null;
        else loadLyricsFor(start.trackId);
      }
    } catch (e) {
      set({ errorMessage: e instanceof Error ? e.message : '播放失败' });
    }
  },

  pause: () => {
    const s = get();
    if (s.engine === 'webaudio') {
      engineSingleton?.pause();
      reportProgress(false);
      pushDeskLyrics(get().position, false);
      set({ isPlaying: false });
      void window.electronAPI.setMusicEngineActive(false); // 暂停时媒体键还给视频（若无视频则无操作）
    } else if (s.engine === 'mpv') {
      void window.electronAPI.playerControl('pause');
    }
  },

  resume: () => {
    const s = get();
    if (s.engine === 'webaudio') {
      void engineSingleton?.resume();
      set({ isPlaying: true });
      void window.electronAPI.setMusicEngineActive(true);
    } else if (s.engine === 'mpv') {
      void window.electronAPI.playerControl('pause');
    }
  },

  next: async () => {
    const s = get();
    if (s.engine === 'webaudio') {
      reportProgress(false);
      const engineInstance = engineSingleton;
      if (!engineInstance) return;
      await engineInstance.next(false);
      syncFromEngine(set, engineInstance);
    } else if (s.engine === 'mpv') {
      // QYP3-025：服务器音乐队列内前进；无队列（本地冷门格式）则沿用旧行为
      if (s.serverQueue.length > 0 && s.serverIndex + 1 < s.serverQueue.length) {
        await get().playServerAt(s.serverIndex + 1);
      } else {
        void window.electronAPI.playerControl('stop');
      }
    }
  },

  prev: async () => {
    const s = get();
    if (s.engine === 'webaudio') {
      const engineInstance = engineSingleton;
      if (!engineInstance) return;
      await engineInstance.prev();
      syncFromEngine(set, engineInstance);
    } else if (s.engine === 'mpv') {
      if (s.serverQueue.length > 0 && s.serverIndex - 1 >= 0) {
        await get().playServerAt(s.serverIndex - 1);
      } else {
        void window.electronAPI.playerControl('stop');
      }
    }
  },

  seek: (position) => {
    const s = get();
    if (s.engine === 'webaudio') engineSingleton?.seek(position);
    else if (s.engine === 'mpv') void window.electronAPI.playerControl('seek', position, 'absolute');
  },

  setRepeat: (mode) => {
    set({ repeat: mode });
    if (engineSingleton) engineSingleton.queueState.repeat = mode;
  },

  toggleShuffle: () => {
    const next = !get().shuffle;
    set({ shuffle: next });
    if (engineSingleton) engineSingleton.queueState.shuffle = next;
  },

  clearError: () => set({ errorMessage: null }),

  getSpectrum: () => engineSingleton?.getSpectrum() ?? null,

  playServerAt: async (index) => {
    const s = get();
    const track = s.serverQueue[index];
    if (!track) return;
    try {
      const res = (await window.electronAPI.resolvePlayback(refOfTrack(track))) as {
        ok: boolean;
        data?: { url: string; startPosition: number; mediaContext?: unknown };
        error?: { message: string };
      };
      if (!res.ok || !res.data) {
        set({ errorMessage: res.error?.message ?? '解析播放地址失败' });
        return;
      }
      set({
        current: {
          id: track.trackId,
          title: track.title,
          artist: track.artist,
          album: null,
          albumartist: track.albumartist,
          duration: track.duration,
          url: res.data.url,
        },
        serverIndex: index,
        position: 0,
        duration: track.duration ?? 0,
        isPlaying: true,
        errorMessage: null,
      });
      currentLyrics = null; // 服务器曲目：本地无歌词缓存
      const [eqGains, replaygain] = await readAudioChainSettings();
      await window.electronAPI.playerLoadFile(
        res.data.url,
        res.data.startPosition > 0 ? res.data.startPosition : undefined,
        undefined,
        res.data.mediaContext as Parameters<typeof window.electronAPI.playerLoadFile>[3],
        undefined,
        { ...(eqGains ? { eqGains } : {}), ...(replaygain ? { replaygain } : {}) },
      );
    } catch (e) {
      set({ errorMessage: e instanceof Error ? e.message : '播放失败' });
    }
  },
}));

function engineSnapshotCurrent(
  queue: EngineExtTrack[],
  currentTrackId: number | null
): QueueTrack | null {
  if (currentTrackId === null) return null;
  return queue.find((q) => q.id === currentTrackId) ?? null;
}

/** next/prev 后从引擎实例 + store 快照拉回状态（单点归一）。 */
function syncFromEngine(
  set: (partial: Partial<MusicPlayingState>) => void,
  engineInstance: WebAudioEngine
): void {
  const st = engineInstance.queueState;
  const snapshot = useMusicPlaybackStore.getState().queueSnapshot;
  const current = engineSnapshotCurrent(snapshot, st.currentTrackId);
  set({
    queueLength: st.length,
    queueIndex: st.index,
    current,
    position: 0,
    isPlaying: st.currentTrackId !== null,
  });
  if (current) loadLyricsFor(current.id);
}
