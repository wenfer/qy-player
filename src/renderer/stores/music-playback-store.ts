import { create } from 'zustand';
import { WebAudioEngine, type QueueTrack, type RepeatMode } from '../player/web-audio-engine';
import { isLocalFlacUrl } from '../player/flac-strip';
import { estimatePosition, makeAnchor, type PositionAnchor } from '../player/spectrum-anchor';
import type { MediaRef } from '../../shared/types/catalog';
import type { MusicTrackRow } from '../../shared/types/music';
import type { GetSpectrumResult, SpectrumReadyEvent } from '../../shared/types/music-spectrum';

/**
 * 音乐播放状态（QYP3-010/011/014）。
 *
 * 引擎归一（ADR-0007）：renderer 引擎与 mpv 引擎共用这一个状态面——
 * mpv 引擎沿用主进程 player:on-state-change 事件（PlayerControls 已接）；
 * renderer 引擎在此单点驱动并向上节流上报进度（≤10s + 收尾）。
 * direct 解码失败 → 回退 mpv 引擎一次（ADR-0007）。
 */

/**
 * 队列条目扩展（QYP3-037 重构）：携带原始队列输入，回退/歌词/来源路由
 * 全部从 musicInput 取——服务器曲目 trackId 恒为 0，不能再按它路由。
 */
type EngineExtTrack = QueueTrack & {
  trackId: number;
  sourceId: number;
  mediaId: string;
  musicInput: MusicTrackInput;
  serverId?: number;
  provider?: 'jellyfin' | 'emby';
  itemId?: string;
  mediaSourceId?: string;
};

/**
 * 队列条目 id（QYP3-037）：本地用 music_tracks.id；服务器曲目 trackId 恒为
 * 0（多首相撞），改用负数合成 id（按队列下标，唯一且非 0）。
 */
function queueIdFor(t: MusicTrackInput, index: number): number {
  return t.serverId ? -(index + 1) : t.trackId;
}

export interface MusicPlayingState {
  engine: 'webaudio' | 'mpv' | null;
  current: QueueTrack | null;
  /** 当前曲目来源（QYP3-020b：歌词按来源路由——本地 trackId / 服务器 {serverId,itemId}）。 */
  currentSource: MusicSourceRef | null;
  position: number;
  duration: number;
  isPlaying: boolean;
  /** 音量 0..100（webaudio 走 gain，mpv 走 playerControl('volume')）。 */
  volume: number;
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
  /**
   * mpv 引擎的本地队列（QYP3-068d）：本地 mpv 音源（APE/兼容性优先/兜底）
   * 的上下曲也要能走完整个列表——此前 serverQueue 只装服务器曲目，本地
   * mpv 曲目的 next/prev 是死路（队尾 stop 看起来就是"没反应"）。
   */
  mpvQueue: MusicTrackInput[];
  mpvQueueIndex: number;
  /**
   * 启动恢复态（QYP3-053）：上次退出时那首曲目 + 进度已经回填，但**引擎是
   * null**（不出声）。故意不伪装成引擎：`CompactModeHost` 与全局媒体键都只看
   * `engine`，伪装会出现"一启动就自动进精简模式/媒体键劫持视频"。
   */
  restored: boolean;
  /** 恢复态的曲目输入（点播放时用它入队）。 */
  restoreInput: MusicTrackInput | null;
  /** 恢复态的进度（秒）：点播放从这里起播。 */
  restorePosition: number;
}

/** 歌词/进度的来源标识（本地音轨或服务器条目）。 */
export interface MusicSourceRef {
  trackId: number;
  /** 本地/WebDAV 音轨所属来源（QYP3-053：恢复记录按 (sourceId, trackId) 反查）。 */
  sourceId?: number;
  serverId?: number;
  itemId?: string;
}

export interface MusicPlaybackStore extends MusicPlayingState {
  playQueue: (
    tracks: MusicTrackInput[],
    startIndex: number,
    opts?: { startPosition?: number }
  ) => Promise<void>;
  pause: () => void;
  resume: () => void;
  next: () => Promise<void>;
  prev: () => Promise<void>;
  seek: (position: number) => void;
  setVolume: (volume: number) => void;
  setRepeat: (mode: RepeatMode) => void;
  toggleShuffle: () => void;
  /** 播放模式一键循环（QYP3-068t）：顺序 → 列表循环 → 单曲循环 → 随机。 */
  cyclePlayMode: () => void;
  clearError: () => void;
  /** 拾音器（QYP3-023）：实时频谱快照；非 renderer 引擎返回 null。 */
  getSpectrum: () => Uint8Array | null;
  /** 拾音器（QYP3-033）：真实时域波形快照；非 renderer 引擎/静音返回 null。 */
  getWaveform: () => Uint8Array | null;
  /** 服务器队列内跳转（QYP3-025）：mpv 引擎的上下曲靠它推进。 */
  playServerAt: (index: number) => Promise<void>;
  /** 结束音乐会话（QYP3-026）：视频接管 mpv 时由主进程事件触发。 */
  stop: () => void;
  /**
   * 彻底结束音乐会话（QYP3-068p）：回到影视模式时调用——`stop()` 只清正在
   * 播的引擎（engine 为 null 时直接返回），这里连"待播"的恢复态与落盘的
   * 「当前播放的音乐」一起清掉，播放条随之消失。
   */
  endSession: () => void;
  /** 启动恢复（QYP3-053）：读回上次的"当前播放的音乐"（不出声）。 */
  initNowPlaying: () => Promise<void>;
  /** 恢复态起播（QYP3-053）：从上一次的进度继续。 */
  resumeRestored: () => Promise<void>;
}

let engineSingleton: WebAudioEngine | null = null;
let lastReportAt = 0;
/** 「当前播放的音乐」的上报节流（QYP3-053）：收尾不受它限制。 */
let lastNowPlayingAt = 0;
/** 播放令牌：新 playQueue 使旧 playCurrent 竞态失效（重复点击防护）。 */
let playToken = 0;
/**
 * 时长回填哨兵（QYP3-052）：已经报告过真实时长的曲目 id。
 * mpv 在重载/seek 后会重发 duration，没有这个哨兵就会反复写库。
 */
let durationReportedTrackId: number | null = null;

/**
 * 离线频谱（QYP3-050）：mpv 音源的真频谱由主进程用 ffmpeg 预算，渲染层按
 * 播放进度索引回放。**放模块级变量而不是 zustand**——一份矩阵 100KB 级，
 * 不该进渲染热点，也不该触发任何组件重渲染（拾音器每帧来读即可）。
 */
let offlineSpectrum: {
  fps: number;
  bands: number;
  frameCount: number;
  data: Uint8Array;
} | null = null;
/** 位置锚点：mpv 位置是 1Hz 离散推送，两次之间靠它外推（否则频谱一秒一跳）。 */
let spectrumAnchor: PositionAnchor = { position: 0, at: 0, playing: false };
/** 请求令牌：切歌/停播后到达的过期回包直接丢弃。 */
let spectrumRequestId = 0;

/** 拉一次当前曲目的离线频谱（主进程是"当前 mpv 曲目"的权威）。 */
async function refreshOfflineSpectrum(): Promise<void> {
  const id = ++spectrumRequestId;
  try {
    const res = (await window.electronAPI.getMusicSpectrum()) as {
      ok?: boolean;
      data?: GetSpectrumResult;
    };
    if (id !== spectrumRequestId) return; // 已切歌/停播
    const data = res?.data;
    offlineSpectrum =
      data && data.status === 'ready'
        ? {
            fps: data.fps,
            bands: data.bands,
            frameCount: data.frameCount,
            data: data.data,
          }
        : null; // pending / unavailable / failed / none 都按"暂时没有"处理
  } catch {
    if (id === spectrumRequestId) offlineSpectrum = null;
  }
}

/** 清空离线频谱并使在途回包失效（切歌、停播、换引擎）。 */
function clearOfflineSpectrum(): void {
  spectrumRequestId += 1;
  offlineSpectrum = null;
}

/**
 * direct 引擎解码失败、已交给 mpv 兜底的那一首（QYP3-030）。
 *
 * 失败路径上 `error` 事件先到、`play()` 的 rejection 后到，而状态里的
 * current 是在 `await playQueue()` 之后才写入的 —— 兜底因此不能读 current
 * （首播读到 null 会直接放弃；换曲后读到上一首会喂错曲子）。这里记下
 * 「谁失败了」，playQueue 的 catch 据此判断这次 rejection 是否已被兜底接管。
 *
 * QYP3-037：改按**队列 id**（QueueTrack.id）记——服务器曲目 trackId 全是 0，
 * 按 trackId 记会互相认领。
 */
let directFallbackQueueId: number | null = null;
/**
 * 正在做 FLAC 封面剥离自救的那一首（QYP3-033；QYP3-037 起按队列 id 记）。
 *
 * 与 `directFallbackQueueId` 同理：自救是异步的（fetch + 重封装 29MB 级别），
 * 而 `error` 事件先到、`play()` 的 rejection 紧随其后——若 catch 不认领这次
 * rejection，就会把浏览器原文「Failed to load because no supported source was
 * found.」当成播放失败弹给用户，即便自救随后成功。这里记下「谁在自救」，catch
 * 据此跳过；同一首的后续错误事件也被忽略，最终决策交给 recoverFlac 的 .then。
 *
 * 刻意**不在 .then 里清除**：recoverFlac 可能非常快地 resolve（比如非 flac 直接
 * 返回 false），若 .then 先于 catch 跑，marker 被清掉后 catch 又会把原始英文
 * 错误弹出来。改为在下一次 playQueue / stop 时重置，让 catch 的判定与异步顺序
 * 无关。
 */
let flacRecoveringQueueId: number | null = null;
/**
 * 懒解析已失败的队列条目（QYP3-037）：用于「整队都解不出来」的终止判定，
 * 防止 repeat=all 时空转循环。
 */
const resolveFailedIds = new Set<number>();
/** 当前曲目的歌词原文（桌面歌词用；QYP3-022）。 */
let currentLyrics: string | null = null;
let lastDeskPushAt = 0;
/** 服务器音乐会话 id（QYP3-038）：Progress/Stopped 必须携带同一 id。 */
let serverPlaySessionId: string | null = null;

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

/** 循环模式顺序（QYP3-068g）：off → all → one → off。 */
export function nextRepeat(mode: 'off' | 'all' | 'one'): 'off' | 'all' | 'one' {
  return mode === 'off' ? 'all' : mode === 'all' ? 'one' : 'off';
}

/** 循环模式的用户可读文案（播放条/浮窗共用）。 */
export function repeatLabel(mode: 'off' | 'all' | 'one'): string {
  return mode === 'all' ? '列表循环' : mode === 'one' ? '单曲循环' : '顺序播放';
}

/**
 * 播放模式（QYP3-068t）：循环与随机合并成**一个**按钮循环切换。
 *
 * 存储层仍是两个字段（`repeat` + `shuffle`，主进程/mpv 路径照旧读它们），
 * 只是 UI 上做成一维四态：顺序 → 列表循环 → 单曲循环 → 随机 → 顺序。
 * 随机不与循环叠加（二选一），这样用户不用理解笛卡尔积。
 */
export type PlayMode = 'sequence' | 'repeat-all' | 'repeat-one' | 'shuffle';

export function playModeOf(repeat: 'off' | 'all' | 'one', shuffle: boolean): PlayMode {
  if (shuffle) return 'shuffle';
  return repeat === 'all' ? 'repeat-all' : repeat === 'one' ? 'repeat-one' : 'sequence';
}

export function nextPlayMode(mode: PlayMode): PlayMode {
  return mode === 'sequence'
    ? 'repeat-all'
    : mode === 'repeat-all'
      ? 'repeat-one'
      : mode === 'repeat-one'
        ? 'shuffle'
        : 'sequence';
}

export function playModeLabel(mode: PlayMode): string {
  return mode === 'repeat-all'
    ? '列表循环'
    : mode === 'repeat-one'
      ? '单曲循环'
      : mode === 'shuffle'
        ? '随机播放'
        : '顺序播放';
}

/** 一维模式 → 存储层两个字段（`cyclePlayMode` 的唯一写入口）。 */
export function playModeState(mode: PlayMode): { repeat: 'off' | 'all' | 'one'; shuffle: boolean } {
  return {
    repeat: mode === 'repeat-all' ? 'all' : mode === 'repeat-one' ? 'one' : 'off',
    shuffle: mode === 'shuffle',
  };
}

/** MediaRef 构造（QYP3-025）：服务器曲目按 serverId 严格路由。 */
export function refOfTrack(t: MusicTrackInput): MediaRef {
  if (t.serverId && t.itemId) {
    return { provider: t.provider ?? 'jellyfin', serverId: t.serverId, itemId: t.itemId };
  }
  return { provider: 'music', sourceId: t.sourceId, itemId: String(t.trackId) };
}

/** 歌词来源标识（QYP3-020b）：本地音轨 / 服务器条目二选一。 */
export function sourceOfTrack(t: MusicTrackInput): MusicSourceRef {
  return t.serverId && t.itemId
    ? { trackId: 0, serverId: t.serverId, itemId: t.itemId }
    : { trackId: t.trackId, sourceId: t.sourceId };
}

/** 换曲时重新拉取歌词（本地读缓存 / 服务器走端点，失败静默=无词）。 */
function loadLyricsFor(source: MusicSourceRef | null): void {
  currentLyrics = null;
  if (!source) return;
  const request =
    source.serverId && source.itemId
      ? window.electronAPI.getServerLyrics(source.serverId, source.itemId)
      : window.electronAPI.getMusicLyrics(source.trackId);
  void request
    .then((res) => {
      const data = (res as { data?: { content?: string | null } })?.data;
      currentLyrics = typeof data?.content === 'string' ? data.content : null;
      pushDeskLyrics(0, true);
    })
    .catch(() => {
      currentLyrics = null;
    });
}

let bridgeAttached = false;

/**
 * mpv 引擎位置源（QYP3-026）。
 *
 * mpv 的音乐与视频共用同一路 `player:on-state-change`，主进程按
 * LOAD_FILE 是否带 audioChain 打 `music` 标记；这里只在音乐会话内写回
 * store（否则视频进度会驱动音乐控制条）。自然播放结束按音乐队列推进
 * 下一曲（与 renderer 引擎的 onEnded 同语义，无倒计时）。
 *
 * 幂等：多处挂载只会订阅一次。
 */
export function attachMusicMpvBridge(): void {
  if (bridgeAttached) return;
  bridgeAttached = true;
  window.electronAPI.onPlayerStateChange((state: unknown) => {
    const s = state as {
      music?: boolean;
      currentTime?: number;
      duration?: number;
      isPlaying?: boolean;
      eof?: boolean;
    };
    const store = useMusicPlaybackStore.getState();
    if (s.music && store.engine === 'mpv') {
      const patch: Partial<MusicPlayingState> = {};
      if (typeof s.currentTime === 'number') patch.position = s.currentTime;
      if (typeof s.duration === 'number' && s.duration > 0) patch.duration = s.duration;
      if (typeof s.isPlaying === 'boolean') patch.isPlaying = s.isPlaying;
      if (Object.keys(patch).length > 0) useMusicPlaybackStore.setState(patch);
      if (patch.duration !== undefined) maybeReportDuration(); // QYP3-052 时长回填
      // 「当前播放的音乐」（QYP3-053）：mpv 音乐的位置也来自这里；暂停是
      // 收尾语义，必须立刻落盘（正在播时按 5s 节流）
      pushNowPlaying({ final: s.isPlaying === false });
      // 离线频谱（QYP3-050）：每个位置事件都重置锚点，两次推送之间外推
      if (typeof s.currentTime === 'number') {
        spectrumAnchor = makeAnchor(
          s.currentTime,
          typeof s.isPlaying === 'boolean' ? s.isPlaying : store.isPlaying,
          performance.now()
        );
      }
      pushDeskLyrics(
        typeof s.currentTime === 'number' ? s.currentTime : store.position,
        typeof s.isPlaying === 'boolean' ? s.isPlaying : store.isPlaying
      );
      // 自然结束：队列内推进（队尾 next() 内部 stop，不回卷）
      // 自然结束：队列内推进（队尾 next() 内部 stop，不回卷）。
      // QYP3-068d：本地 mpv 队列（mpvQueue）同样自动推进
      if (s.eof && (store.serverQueue.length > 0 || store.mpvQueue.length > 0)) void store.next();
      return;
    }
    // 视频接管 mpv（非音乐加载）：只在本 store 认为 mpv 在放音乐时收尾。
    // renderer 引擎与视频互斥走主进程的显式 ON_SESSION_END（否则一次
    // 残留的 mpv 事件会误杀刚起播的 renderer 引擎音乐）。
    if (!s.music && useMusicPlaybackStore.getState().engine === 'mpv') {
      useMusicPlaybackStore.getState().stop();
    }
  });
  window.electronAPI.onMusicSessionEnd(() => {
    useMusicPlaybackStore.getState().stop();
  });
  // 离线频谱：主进程算完（或判定拿不到）会推一次，这里再取一次就有结论了
  window.electronAPI.onMusicSpectrumReady?.((event: unknown) => {
    const e = event as SpectrumReadyEvent | undefined;
    if (!e || e.status !== 'ready') return;
    if (useMusicPlaybackStore.getState().engine === 'mpv') void refreshOfflineSpectrum();
  });
  // mpv 音乐起播/切歌 → 拉一次；离开 mpv 引擎或停播 → 清空
  useMusicPlaybackStore.subscribe((state, prev) => {
    if (state.engine !== 'mpv') {
      if (prev.engine === 'mpv') clearOfflineSpectrum();
      return;
    }
    if (prev.engine !== 'mpv' || prev.current !== state.current) {
      clearOfflineSpectrum();
      spectrumAnchor = makeAnchor(state.position, state.isPlaying, performance.now());
      void refreshOfflineSpectrum();
    }
  });
}

function getEngine(): WebAudioEngine {
  if (!engineSingleton) {
    engineSingleton = new WebAudioEngine();
    engineSingleton.onTime = (position, duration) => {
      const s = useMusicPlaybackStore.getState();
      if (s.engine === 'mpv') return; // mpv 引擎状态由主进程事件驱动
      const known = duration || s.duration;
      useMusicPlaybackStore.setState({ position, duration: known });
      if (known > 0) maybeReportDuration(); // QYP3-052 时长回填
      pushDeskLyrics(position, true);
      // 上次在放哪首/放到哪（QYP3-053）：内部 5s 节流，1Hz 的位置事件
      // 不会变成写盘风暴
      pushNowPlaying();
      // 服务器回传沿用 10s 节流（Sessions/Playing 系列不宜高频）
      const now = Date.now();
      if (now - lastReportAt >= 10_000) {
        lastReportAt = now;
        reportServerProgress();
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
    engineSingleton.onError = (_err, track) => {
      const s = useMusicPlaybackStore.getState();
      if (s.engine === 'mpv') return; // 已在兼容引擎上，无兜底可谈
      const instance = engineSingleton;
      if (!instance) return;
      // 失败曲目以引擎报上来的为准（QYP3-068d）：换曲窗口里引擎队列已前进、
      // store.current 还是上一首——按 store 识别会认领错曲。快照条目才是
      // 权威 EngineExtTrack（带 musicInput），按 id 回查
      const snapshot = useMusicPlaybackStore.getState().queueSnapshot;
      const trackId = instance.queueState.currentTrackId;
      const failed =
        (track && (snapshot.find((q) => q.id === track.id) as EngineExtTrack | undefined)) ??
        (track as EngineExtTrack | null) ??
        (trackId !== null
          ? (snapshot.find((q) => q.id === trackId) as EngineExtTrack | undefined) ?? null
          : null);
      if (!failed || !failed.musicInput) return;
      // 引擎已不在这一首上（用户又点了别的曲）：这次错误属于过去，不再处理
      if (instance.queueState.currentTrackId !== failed.id) return;
      // QYP3-033：FLAC 因内嵌封面非法被 Chromium 拒绝时，先剥离封面
      // 在内置引擎重播——保留真频谱/真波形，且不必兜底 mpv（也避免黑窗）。
      // QYP3-037：服务器/WebDAV 的 qy-stream URL 不带扩展名，只能靠 codec
      // 判定（isFlacUrl 对任意 qy-stream 都为真，会造成 mp3 白拉整文件）；
      // 本地 qy-file 仍可按扩展名兜底 codec 缺失的情况。
      // 自救进行中：忽略这一首的后续错误，最终决策交给 recoverFlac 的 .then
      if (flacRecoveringQueueId === failed.id) return;
      if (failed.codec === 'flac' || isLocalFlacUrl(failed.url)) {
        flacRecoveringQueueId = failed.id;
        void instance
          .recoverFlac(failed)
          .then((recovered) => {
            // 期间引擎已不在这一首上（用户换了曲/视频接管）：自救作废
            if (
              useMusicPlaybackStore.getState().engine !== 'webaudio' ||
              instance.queueState.currentTrackId !== failed.id
            ) {
              return;
            }
            if (recovered) {
              // 自救成功：引擎队列停在 failed 上，store 对齐它（换曲窗口里
              // current 还是上一首），真频谱/真波形都留在内置引擎
              syncFromEngine(instance);
              useMusicPlaybackStore.setState({ engine: 'webaudio', isPlaying: true, errorMessage: null });
              return;
            }
            fallbackToMpvNow(failed);
          });
        return;
      }
      fallbackToMpvNow(failed);
    };
    // 懒解析失败（QYP3-037）：解析报错或解析结果不是 webaudio（NEEDS_MPV）。
    // 服务器曲目直接兜底 mpv（mpv 能继续服务器队列）；本地/WebDAV 先尝试
    // 跳到下一首（与旧版「解析失败的曲不进队」等价的继续性），跳不动才兜底。
    const instance = engineSingleton;
    instance.onResolveError = (_err, track) => {
      const s = useMusicPlaybackStore.getState();
      if (s.engine !== 'webaudio') return;
      const ext = track as EngineExtTrack;
      resolveFailedIds.add(track.id);
      if (ext.serverId && ext.itemId) {
        fallbackToMpvNow(ext);
        return;
      }
      const st = instance.queueState;
      const total = st.length;
      const allFailed = resolveFailedIds.size >= total;
      const nextIndex = st.repeat === 'all' && !allFailed ? (st.index + 1) % total : st.index + 1;
      if (!allFailed && nextIndex >= 0 && nextIndex < total) {
        void instance.jumpTo(nextIndex).then(() => {
          syncFromEngine(instance);
        });
        return;
      }
      fallbackToMpvNow(ext);
    };
  }
  return engineSingleton;
}

/**
 * 服务器音乐会话（QYP3-038）：起播时报告 Sessions/Playing，记下
 * playSessionId（Progress/Stopped 必须携带同一 id）。本地曲目清空。
 */
function beginServerSession(track: EngineExtTrack | null): void {
  if (!track || !(track.serverId && track.itemId)) {
    serverPlaySessionId = null;
    return;
  }
  serverPlaySessionId = null;
  void window.electronAPI
    .startMusicServerSession({
      serverId: track.serverId,
      provider: track.provider ?? 'jellyfin',
      itemId: track.itemId,
      mediaSourceId: track.mediaSourceId,
      title: track.title,
    })
    .then((res) => {
      const data = (res as { data?: { playSessionId?: string } } | undefined)?.data;
      serverPlaySessionId = typeof data?.playSessionId === 'string' ? data.playSessionId : null;
    })
    .catch(() => {
      serverPlaySessionId = null;
    });
}

/**
 * 「当前播放的音乐」上报（QYP3-053）。
 *
 * 用户诉求：**音频不记播放历史**，只需要一条"上次在放哪首 + 放到哪"。
 * 这条记录只用于下次启动恢复播放条（不自动出声，点播放从上次位置继续）；
 * 音乐不再按曲目续播，所以它不进 `watch_history` / `playback_progress`。
 *
 * 节流 ~5s；收尾（暂停/跳曲/停止/会话结束）立即上报，保证退出时是最新位置。
 */
function pushNowPlaying(opts: { final?: boolean } = {}): void {
  const s = useMusicPlaybackStore.getState();
  const source = s.currentSource;
  if (!source || !s.current) return;
  const now = Date.now();
  if (!opts.final && now - lastNowPlayingAt < 5_000) return;
  lastNowPlayingAt = now;
  const base = {
    title: s.current.title,
    artist: s.current.artist,
    albumartist: s.current.albumartist,
    duration: s.duration > 0 ? s.duration : null,
    position: s.position,
  };
  // 服务器曲目（trackId 恒为 0）与本地/WebDAV 音轨走两套定位键
  const payload =
    source.serverId && source.itemId
      ? { ...base, type: 'server' as const, serverId: source.serverId, itemId: source.itemId }
      : { ...base, type: 'track' as const, sourceId: source.sourceId ?? 0, trackId: source.trackId };
  void Promise.resolve(window.electronAPI.setNowPlaying?.(payload)).catch(() => undefined);
}

/**
 * 服务器音乐进度回传（QYP3-038，QYP3-053 起本地表不再写）。
 *
 * 只有 **webaudio 引擎** 走这里：mpv 引擎的服务器曲目由主进程
 * `PlaybackStateManager` 的 `onProgressSaved` 回传（LOAD_FILE 带了会话）。
 * final = 收尾（跳曲/停止/自然结束）：服务器走 Stopped 端点落位。
 */
function reportServerProgress(opts: { final?: boolean } = {}): void {
  const s = useMusicPlaybackStore.getState();
  if (s.engine !== 'webaudio' || !s.current) return;
  const ext = s.current as EngineExtTrack;
  if (!(ext.serverId && ext.itemId)) return;
  void window.electronAPI.reportMusicServerProgress({
    serverId: ext.serverId,
    provider: ext.provider ?? 'jellyfin',
    itemId: ext.itemId,
    mediaSourceId: ext.mediaSourceId,
    title: ext.title,
    position: s.position,
    duration: s.duration,
    isStopped: opts.final === true ? true : undefined,
    playSessionId: serverPlaySessionId ?? undefined,
  });
}

/**
 * 播放期回填真实时长（QYP3-052）。
 *
 * 扫描期解析不出来的曲目（VBR mp3 没有 Xing 头、ID3 标签超出读取窗口、
 * WebDAV 来源）列表里一直是空白，但播放器知道真实值——每个曲目报一次。
 * 非关键路径：失败静默，绝不影响播放。
 */
function maybeReportDuration(): void {
  const s = useMusicPlaybackStore.getState();
  const trackId = s.currentSource?.trackId ?? 0;
  // 服务器曲目不落本地库（trackId = 0），队列合成 id 是负数
  if (!(trackId > 0)) return;
  if (durationReportedTrackId === trackId) return;
  const duration = s.duration;
  if (!Number.isFinite(duration) || duration <= 0) return;
  const stored = s.current?.duration ?? 0;
  if (stored > 0 && Math.abs(stored - duration) <= 2) return; // 库里已经够准，不打扰
  durationReportedTrackId = trackId;
  void Promise.resolve(window.electronAPI.setMusicTrackDuration?.(trackId, duration)).catch(
    () => undefined
  );
}

/** 音频链设备侧参数（主进程按此 set_property；P2 增加 ReplayGain 高级项）。 */
interface AudioChainSettings {
  eqGains: number[] | null;
  replaygain: string | null;
  replaygainPreamp: number | null;
  replaygainFallback: number | null;
  replaygainClip: boolean;
}

/**
 * 音频链设置读取（QYP3-012 + P2）：EQ dB 数组 + ReplayGain（模式与
 * 预增益/兜底增益/削波保护）。读不到的项留给主进程默认值。
 */
async function readAudioChainSettings(): Promise<AudioChainSettings> {
  const empty: AudioChainSettings = {
    eqGains: null,
    replaygain: null,
    replaygainPreamp: null,
    replaygainFallback: null,
    replaygainClip: false,
  };
  try {
    const read = async (key: string): Promise<unknown> => {
      const res = (await window.electronAPI.getSettings(key)) as { data?: unknown };
      return res?.data;
    };
    const [eqValue, rgValue, preampValue, fallbackValue, clipValue] = await Promise.all([
      read('playback.eqGains'),
      read('playback.replaygain'),
      read('playback.replaygainPreamp'),
      read('playback.replaygainFallback'),
      read('playback.replaygainClip'),
    ]);
    const rg = typeof rgValue === 'string' && rgValue !== 'off' ? rgValue : null;
    const num = (v: unknown): number | null => {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    return {
      eqGains: Array.isArray(eqValue) ? eqValue.map((v) => Number(v) || 0) : null,
      replaygain: rg,
      replaygainPreamp: num(preampValue),
      replaygainFallback: num(fallbackValue),
      // SETTINGS.GET 与 SET 对称：布尔设置读回就是布尔；兼容旧裸值
      replaygainClip: clipValue === true || clipValue === 'true',
    };
  } catch {
    return empty;
  }
}

/** 音频链 → playerLoadFile 第 6 参数（未设置的模式不发键，主进程用默认值）。 */
function audioChainPayload(chain: AudioChainSettings): Record<string, unknown> {
  return {
    ...(chain.eqGains ? { eqGains: chain.eqGains } : {}),
    ...(chain.replaygain ? { replaygain: chain.replaygain } : {}),
    ...(chain.replaygainPreamp !== null ? { replaygainPreamp: chain.replaygainPreamp } : {}),
    ...(chain.replaygainFallback !== null ? { replaygainFallback: chain.replaygainFallback } : {}),
    replaygainClip: chain.replaygainClip,
  };
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

/**
 * 上次的音乐状态（QYP3-053）：主进程把记录补成可直接入队的
 * `MusicTrackInput`（本地音轨按 (sourceId, trackId) 查库、服务器条目按
 * serverId 路由），渲染层拿到就能 `playQueue([input], 0, {startPosition})`。
 */
export interface RestoredNowPlaying {
  type: 'track' | 'server';
  position: number;
  duration: number | null;
  updatedAt: number;
  input: MusicTrackInput;
}

/**
 * 浏览器解码失败的原文是英文（"Failed to load because no supported source
 * was found."），不该直接亮给用户；统一成中文。其余错误按原文展示。
 */
function decodeErrorMessage(e: unknown): string {
  if (e instanceof DOMException && e.name === 'NotSupportedError') {
    return '这首曲目无法解码播放';
  }
  if (e instanceof Error) {
    if (/no supported source|DEMUXER_ERROR|failed to load/i.test(e.message)) {
      return '这首曲目无法解码播放';
    }
    return e.message;
  }
  return '播放失败';
}

/**
 * 兜底到 mpv 的统一入口（QYP3-033 抽取；QYP3-037 改按队列 id 认领 + 服务器
 * 队列位置对齐）：标记「谁失败了」+ 同步切到 mpv 状态面 + 实际触发 mpv
 * loadfile。先前的 onError 内联逻辑迁移至此，供 FLAC 自救失败后的兜底复用。
 */
function fallbackToMpvNow(track: EngineExtTrack): void {
  directFallbackQueueId = track.id;
  const patch: Partial<MusicPlayingState> = {
    engine: 'mpv',
    isPlaying: false,
    errorMessage: null,
  };
  // 服务器队列：把 mpv 的推进位置对到兜底曲（此后 eof 靠 serverQueue 继续），
  // 否则 next() 会从 webaudio 起播时的旧位置重复播放
  if (track.serverId) {
    const idx = useMusicPlaybackStore.getState().serverQueue.indexOf(track.musicInput);
    if (idx >= 0) patch.serverIndex = idx;
  }
  // 同步切到 mpv：状态面与"已交给兼容引擎"一致，紧随其后的
  // play() rejection 也才能被认作预期（见 playQueue 的 catch）。
  // 本地队列一并带过去（QYP3-068d）：兜底后 next/prev 仍按原列表走
  const snapshot = useMusicPlaybackStore.getState().queueSnapshot;
  const fallbackIdx = snapshot.findIndex((q) => q.id === track.id);
  useMusicPlaybackStore.setState({
    ...patch,
    // 服务器曲目仍走 serverQueue 推进；mpvQueue 只服务本地/WebDAV 曲目
    mpvQueue: !track.serverId && fallbackIdx !== -1 ? snapshot.map((q) => q.musicInput) : [],
    mpvQueueIndex: fallbackIdx,
  });
  void fallbackToMpv(track);
}

/**
 * direct 引擎解码失败兜底（ADR-0007，QYP3-030）。
 *
 * 参数是**失败的那一首**，不是 store 里的 current：`error` 事件先于
 * `play()` 的 rejection 到达，而当前曲目状态是在 `await playQueue()` 之后
 * 才写入的，读 current 会在首播时读到 null（兜底失效）、在换曲后读到上一首
 * （喂错曲子）。
 *
 * 兜底失败才报错：能播的文件（内置引擎解不了但 mpv 能解的，如内嵌图片块
 * 非法的 FLAC）对用户而言是「能播的」，不该弹一条误导性的错误。
 *
 * QYP3-037：解析 ref 按来源分支——服务器曲目走 {provider, serverId, itemId}，
 * 不能再用本地构造（服务器曲目 trackId/sourceId 全是 0）。
 */
async function fallbackToMpv(track: EngineExtTrack): Promise<void> {
  try {
    const ref = track.serverId && track.itemId
      ? {
          provider: track.provider ?? ('jellyfin' as const),
          serverId: track.serverId,
          itemId: track.itemId,
        }
      : { provider: 'music' as const, sourceId: track.sourceId, itemId: String(track.trackId) };
    const resolution = (await window.electronAPI.resolvePlayback(ref, {
      engineForce: 'mpv',
    })) as {
      ok: boolean;
      data?: { url: string; startPosition: number; mediaContext?: unknown; streamSessionId?: string };
      error?: { message: string };
    };
    if (!resolution.ok || !resolution.data) {
      useMusicPlaybackStore.setState({
        engine: null,
        isPlaying: false,
        errorMessage: resolution.error?.message ?? '这首曲目无法播放',
      });
      return;
    }
    engineSingleton?.pause();
    useMusicPlaybackStore.setState({ engine: 'mpv', isPlaying: false });
    const chain = await readAudioChainSettings();
    await window.electronAPI.playerLoadFile(
      resolution.data.url,
      resolution.data.startPosition > 0 ? resolution.data.startPosition : undefined,
      undefined,
      resolution.data.mediaContext as Parameters<typeof window.electronAPI.playerLoadFile>[3],
      // 认证头会话必须回传（WebDAV Basic / 转码 token）：主进程凭它 take()
      // 出 headers 交给 mpv，缺了就是静默 401
      resolution.data.streamSessionId,
      audioChainPayload(chain)
    );
  } catch (e) {
    useMusicPlaybackStore.setState({
      engine: null,
      isPlaying: false,
      errorMessage: e instanceof Error ? e.message : '这首曲目无法播放',
    });
  }
}

export const useMusicPlaybackStore = create<MusicPlaybackStore>((set, get) => ({  engine: null,
  current: null,
  position: 0,
  duration: 0,
  isPlaying: false,
  volume: 100,
  queueLength: 0,
  queueIndex: 0,
  repeat: 'off',
  shuffle: false,
  errorMessage: null,
  queueSnapshot: [],
  serverQueue: [],
  serverIndex: -1,
  mpvQueue: [],
  mpvQueueIndex: -1,
  currentSource: null,
  restored: false,
  restoreInput: null,
  restorePosition: 0,

  playQueue: async (tracks, startIndex, opts) => {
    const start = tracks[startIndex];
    if (!start) return;
    // 新的播放请求：上一首的自救/失败标记与懒解析记录全部作废
    // （QYP3-037 起按队列 id 记，见各自注释）
    flacRecoveringQueueId = null;
    directFallbackQueueId = null;
    resolveFailedIds.clear();
    const token = ++playToken;
    const startQueueId = queueIdFor(start, startIndex);
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
          streamSessionId?: string;
        };
        error?: { message: string };
      };
      if (!resolution.ok || !resolution.data) {
        set({ errorMessage: resolution.error?.message ?? '解析播放地址失败' });
        return;
      }
      if (token !== playToken) return; // 期间又点了新曲目：让位
      const { url, startPosition, engine, mediaContext, streamSessionId } = resolution.data;
      // QYP3-053：音乐不再按曲目续播（resolver 恒回 0），起播位置只可能来自
      // 显式入参——点恢复出来的播放条「播放」时带上上次的位置。
      const effectiveStart = opts?.startPosition ?? startPosition;

      if (engine?.engine === 'webaudio') {
        // QYP3-037：整队不再逐曲预解析——本地是纯 DB 查询无妨，但服务器是
        // N 次网络请求（500 首专辑不可接受）。只同步构建快照（首曲带已解析
        // 的 url 与续播位置），其余曲目由引擎在起播前懒解析；解析出非
        // webaudio（NEEDS_MPV）或失败的曲子走 onResolveError（跳下一首或
        // 兜底 mpv），不再依赖「预解析过滤」。
        const queue: EngineExtTrack[] = tracks.map((t, i) => {
          const isServer = Boolean(t.serverId && t.itemId);
          return {
            id: queueIdFor(t, i),
            title: t.title,
            artist: t.artist,
            album: null,
            albumartist: t.albumartist,
            duration: t.duration,
            url: i === startIndex ? url : '',
            trackId: t.trackId,
            sourceId: t.sourceId,
            mediaId: isServer ? t.itemId! : t.path,
            musicInput: t,
            codec: t.codec,
            ...(isServer
              ? { serverId: t.serverId, provider: t.provider ?? 'jellyfin', itemId: t.itemId }
              : {}),
          };
        });
        const idx = startIndex;
        // 首曲的上下文里带权威 mediaId（WebDAV 是 <sourceId>:<path>）与
        // mediaSourceId（服务器 Sessions 回传要用），回填进队列条目
        const startCtx = mediaContext as { mediaId?: string; mediaSourceId?: string } | undefined;
        if (queue[idx]) {
          if (startCtx?.mediaId) queue[idx].mediaId = startCtx.mediaId;
          if (startCtx?.mediaSourceId) queue[idx].mediaSourceId = startCtx.mediaSourceId;
        }
        if (token !== playToken) return;
        const engineInstance = getEngine();
        // QYP3-012：webaudio 引擎读 EQ 设置直连 BiquadFilter
        const { eqGains } = await readAudioChainSettings();
        if (eqGains) engineInstance.setEq(eqGains);
        // 应用当前音量（换曲不重置用户设定的音量）
        engineInstance.setVolume(get().volume / 100);
        lastReportAt = Date.now();
        // QYP3-030：状态先落再起播。引擎失败是异步的（error 事件 → 兜底），
        // 兜底要按"正在播的那首"重播；若等 playQueue 返回再写状态，失败时
        // 这里还是 null（首播）或上一首（换曲），兜底就会放弃或喂错曲子。
        // QYP3-067：上一首还握在 mpv 里时（音乐→音乐切引擎不经过视频
        // LOAD_FILE，主进程不会结束 mpv 会话），无窗 mpv 会继续出声——
        // 起播 webaudio 前先显式停掉（stop 在主进程同时收尾保存进度）
        if (get().engine === 'mpv') {
          await window.electronAPI.playerControl('stop');
        }
        void window.electronAPI.setMusicEngineActive(true); // 媒体键双用途路由
        set({
          engine: 'webaudio',
          current: queue[idx] ?? null,
          currentSource: sourceOfTrack(start),
          position: effectiveStart,
          duration: queue[idx]?.duration ?? 0,
          isPlaying: true,
          queueLength: queue.length,
          queueIndex: idx,
          queueSnapshot: queue,
          errorMessage: null,
          restored: false,
          restoreInput: null,
          restorePosition: 0,
          // QYP3-037：服务器队列也记进状态——中途某曲兜底 mpv 时，
          // mpv 的 eof 推进（serverQueue/serverIndex）才有据可依
          serverQueue: start.serverId ? tracks : [],
          serverIndex: start.serverId ? startIndex : -1,
          // mpv 引擎的本地队列只在 mpv 分支记（webaudio 走 queueSnapshot）
          mpvQueue: [],
          mpvQueueIndex: -1,
        });
        // QYP3-038：服务器曲目起播先开 Sessions/Playing 会话（本地清空）
        beginServerSession(queue[idx] ?? null);
        await engineInstance.playQueue(
          queue,
          idx,
          get().repeat,
          get().shuffle,
          async (track) => {
            const ext = track as EngineExtTrack;
            const r = (await window.electronAPI.resolvePlayback(
              refOfTrack(ext.musicInput)
            )) as typeof resolution;
            if (!r.ok || !r.data) {
              throw new Error(r.error?.message ?? '解析播放地址失败');
            }
            if (r.data.engine?.engine !== 'webaudio') {
              throw new Error('NEEDS_MPV');
            }
            // 回填权威键：进度上报与 Sessions 回传都从这里取
            const ctx = r.data.mediaContext as { mediaId?: string; mediaSourceId?: string } | undefined;
            if (ctx?.mediaId) ext.mediaId = ctx.mediaId;
            if (ctx?.mediaSourceId) ext.mediaSourceId = ctx.mediaSourceId;
            return { url: r.data.url, startPosition: r.data.startPosition };
          },
          effectiveStart
        );
        loadLyricsFor(sourceOfTrack(start));
      } else {
        // mpv 引擎接管：本地冷门格式（QYP3-011）或服务器音频（QYP3-025）。
        // QYP3-067：engine 改成 'mpv' 只会让 onTime/onPlaying 静默，旧
        // webaudio 的音频图照常出声——先显式暂停（fallbackToMpv 同款）。
        // AudioContext 不销毁，回到 webaudio 曲目时恢复即可
        engineSingleton?.pause();
        // QYP3-026：媒体键仍按音乐语义路由到 renderer（"下一曲"要走音乐
        // 队列，而不是 mpv 的快进 30 秒）；视频加载时主进程会结束会话。
        void window.electronAPI.setMusicEngineActive(true);
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
          position: effectiveStart,
          duration: start.duration ?? 0,
          isPlaying: true,
          errorMessage: null,
          currentSource: sourceOfTrack(start),
          restored: false,
          restoreInput: null,
          restorePosition: 0,
          // 服务器队列（本地冷门格式时为单曲，上下曲无队列可走）
          serverQueue: start.serverId ? tracks : [],
          serverIndex: start.serverId ? startIndex : -1,
          // 本地队列（QYP3-068d）：本地 mpv 音源的 next/prev 按「全部曲目」
          // 走完整个列表，不再是一条"队尾 stop"的死路
          mpvQueue: start.serverId ? [] : tracks,
          mpvQueueIndex: start.serverId ? -1 : startIndex,
        });
        // QYP3-012：mpv 引擎同样带 EQ/ReplayGain（设置在主进程消费）
        const chain = await readAudioChainSettings();
        await window.electronAPI.playerLoadFile(
          url,
          effectiveStart > 0 ? effectiveStart : undefined,
          undefined,
          mediaContext as Parameters<typeof window.electronAPI.playerLoadFile>[3],
          // WebDAV 音频的实际路径：直链不带凭据，认证头只能靠这个不透明
          // 会话 id 回传（QYP3-027）
          streamSessionId,
          audioChainPayload(chain),
        );
        // 服务器曲目走服务器歌词端点（QYP3-020b），本地读缓存分区
        loadLyricsFor(sourceOfTrack(start));
      }
    } catch (e) {
      // 这一首已交给 mpv 兜底：紧随 error 事件而来的 rejection
      // （NotSupportedError）属预期，报错会误导用户以为放不了
      // （QYP3-037 起按队列 id 认领，服务器曲目不能再按恒为 0 的 trackId）
      if (directFallbackQueueId === startQueueId) {
        directFallbackQueueId = null;
        return;
      }
      // 正在做 FLAC 封面剥离自救：同理，结果由 recoverFlac 的 .then 定，
      // 这里不能把浏览器原文（Failed to load because no supported source
      // was found.）当成失败弹出来——即便自救随后成功
      if (flacRecoveringQueueId === startQueueId) return;
      set({ errorMessage: decodeErrorMessage(e) });
    }
  },

  pause: () => {
    const s = get();
    if (s.engine === 'webaudio') {
      engineSingleton?.pause();
      // 收尾（QYP3-053）：暂停位置立刻落进"当前播放的音乐"
      pushNowPlaying({ final: true });
      reportServerProgress({ final: true });
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
      // 离曲收尾：服务器曲目走 Stopped 落位（是否看完由比率判定），
      // "当前播放的音乐"记下这首的位置（QYP3-053；音乐不写历史）
      pushNowPlaying({ final: true });
      reportServerProgress({ final: true });
      const engineInstance = engineSingleton;
      if (!engineInstance) return;
      try {
        await engineInstance.next(false);
        syncFromEngine(engineInstance);
      } catch {
        // 换曲失败（解码/加载）由 onError → 自救/兜底接管（QYP3-068d）：
        // 这里吞掉 rejection，否则就是 unhandled——兜底已按引擎报上的
        // 失败曲目重播，不需要也不能再把"换曲"报成"播放失败"
      }
    } else if (s.engine === 'mpv') {
      // QYP3-025：服务器音乐队列内前进；无队列（本地冷门格式）则单曲处理。
      // QYP3-035：循环模式在此落实（one=重播当前 / all=队尾回卷），否则精简
      // 模式的循环按钮对 mpv 音源形同虚设。
      // QYP3-068d：本地 mpv 音源走 mpvQueue（「全部曲目」/播放时的列表），
      // 下一曲不再是一条"队尾 stop"的死路。
      if (s.serverQueue.length > 0) {
        if (s.repeat === 'one') await get().playServerAt(s.serverIndex);
        else if (s.serverIndex + 1 < s.serverQueue.length) await get().playServerAt(s.serverIndex + 1);
        else if (s.repeat === 'all') await get().playServerAt(0);
        else void window.electronAPI.playerControl('stop');
      } else if (s.mpvQueue.length > 0) {
        const i = s.mpvQueueIndex;
        if (s.repeat === 'one') await get().playQueue(s.mpvQueue, i);
        else if (s.shuffle && s.mpvQueue.length > 1) {
          // 随机模式（QYP3-068g）：mpv 队列没有内建随机（只有 webaudio 的
          // PlaybackQueue 有），这里在整队里随机挑一首（排除当前这首）——
          // 否则随机按钮在 mpv 音源上是个静默的假开关
          let pick = Math.floor(Math.random() * s.mpvQueue.length);
          if (pick === i) pick = (pick + 1) % s.mpvQueue.length;
          await get().playQueue(s.mpvQueue, pick);
        } else if (i + 1 < s.mpvQueue.length) await get().playQueue(s.mpvQueue, i + 1);
        else if (s.repeat === 'all') await get().playQueue(s.mpvQueue, 0);
        else void window.electronAPI.playerControl('stop');
      } else if (s.repeat !== 'off') {
        void window.electronAPI.playerControl('seek', 0, 'absolute'); // 单曲重播
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
      try {
        await engineInstance.prev();
        syncFromEngine(engineInstance);
      } catch {
        // 同 next：失败由 onError → 自救/兜底接管，这里不冒泡（QYP3-068d）
      }
    } else if (s.engine === 'mpv') {
      if (s.serverQueue.length > 0 && s.serverIndex - 1 >= 0) {
        await get().playServerAt(s.serverIndex - 1);
      } else if (s.serverQueue.length > 0 && s.repeat === 'all') {
        await get().playServerAt(s.serverQueue.length - 1);
      } else if (s.mpvQueue.length > 0) {
        // 本地 mpv 队列回退（QYP3-068d）
        const i = s.mpvQueueIndex;
        if (i - 1 >= 0) await get().playQueue(s.mpvQueue, i - 1);
        else if (s.repeat === 'all') await get().playQueue(s.mpvQueue, s.mpvQueue.length - 1);
        else void window.electronAPI.playerControl('stop');
      } else {
        void window.electronAPI.playerControl('stop');
      }
    }
  },

  seek: (position) => {
    const s = get();
    if (s.engine === 'webaudio') engineSingleton?.seek(position);
    else if (s.engine === 'mpv') void window.electronAPI.playerControl('seek', position, 'absolute');
    else if (s.restored) {
      // 恢复态还没起播（引擎是 null）：拖动只是选定"从哪开始"，落进
      // 恢复位置，点播放时带进 playQueue（QYP3-053）
      set({ position, restorePosition: position });
      pushNowPlaying({ final: true });
    }
  },

  setVolume: (volume) => {
    const clamped = Math.max(0, Math.min(100, Math.round(volume)));
    set({ volume: clamped });
    const s = get();
    // webaudio：gain 0..1；mpv：0..100（共享实例，视频音量同源）
    if (s.engine === 'webaudio') engineSingleton?.setVolume(clamped / 100);
    else if (s.engine === 'mpv') void window.electronAPI.playerControl('volume', clamped);
  },

  setRepeat: (mode) => {
    set({ repeat: mode });
    // QYP3-068t：必须走 setQueueMode——`queueState` 是只读快照，往它上面写字段
    // 是静默空操作（曾让会话中的循环/随机切换对内置引擎完全无效）
    engineSingleton?.setQueueMode(mode, get().shuffle);
  },

  toggleShuffle: () => {
    const next = !get().shuffle;
    set({ shuffle: next });
    engineSingleton?.setQueueMode(get().repeat, next);
  },

  cyclePlayMode: () => {
    const s = get();
    const next = playModeState(nextPlayMode(playModeOf(s.repeat, s.shuffle)));
    set({ repeat: next.repeat, shuffle: next.shuffle });
    engineSingleton?.setQueueMode(next.repeat, next.shuffle);
  },

  clearError: () => set({ errorMessage: null }),

  /**
   * 拾音器数据源（QYP3-023 / QYP3-050）：renderer 引擎有实时频谱；mpv 引擎
   * 改用主进程预算好的离线矩阵，按外推后的播放位置取当前帧（零拷贝子视图）。
   */
  getSpectrum: () => {
    const live = engineSingleton?.getSpectrum();
    if (live) return live;
    if (!offlineSpectrum) return null;
    const s = get();
    if (s.engine !== 'mpv') return null;
    const t = estimatePosition(spectrumAnchor, s.isPlaying, performance.now());
    const { fps, bands, frameCount, data } = offlineSpectrum;
    const index = Math.min(frameCount - 1, Math.max(0, Math.round(t * fps)));
    return data.subarray(index * bands, (index + 1) * bands);
  },
  getWaveform: () => engineSingleton?.getWaveform() ?? null,

  playServerAt: async (index) => {
    const s = get();
    const track = s.serverQueue[index];
    if (!track) return;
    try {
      const res = (await window.electronAPI.resolvePlayback(refOfTrack(track))) as {
        ok: boolean;
        data?: { url: string; startPosition: number; mediaContext?: unknown; streamSessionId?: string };
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
        currentSource: sourceOfTrack(track),
      });
      const chain = await readAudioChainSettings();
      await window.electronAPI.playerLoadFile(
        res.data.url,
        res.data.startPosition > 0 ? res.data.startPosition : undefined,
        undefined,
        res.data.mediaContext as Parameters<typeof window.electronAPI.playerLoadFile>[3],
        res.data.streamSessionId,
        audioChainPayload(chain),
      );
      // 歌词在起播之后拉取（QYP3-020b）：歌词是非关键路径，任何失败
      // 都不允许影响已经发生的 loadfile
      loadLyricsFor(sourceOfTrack(track));
    } catch (e) {
      set({ errorMessage: e instanceof Error ? e.message : '播放失败' });
    }
  },

  /**
   * 启动恢复（QYP3-053）：读回"上次在放哪首 + 放到哪"。
   *
   * 刻意**不设置 engine**（保持 null）：`CompactModeHost`、全局媒体键与
   * 「音乐会话」判定都只看 engine，伪装成有会话会一启动就自动进精简模式、
   * 还会把媒体键从视频手里抢走。播放条只认 `restored`。
   */
  initNowPlaying: async () => {
    try {
      const res = (await window.electronAPI.getNowPlaying?.()) as
        | { ok?: boolean; data?: { record?: RestoredNowPlaying | null } }
        | undefined;
      const record = res?.data?.record;
      if (!record?.input) return;
      // 期间已经真的开始播了（用户手快）：恢复态让位
      if (useMusicPlaybackStore.getState().engine !== null) return;
      const { input } = record;
      useMusicPlaybackStore.setState({
        restored: true,
        restoreInput: input,
        restorePosition: record.position,
        current: {
          id: input.trackId,
          title: input.title,
          artist: input.artist,
          album: null,
          albumartist: input.albumartist,
          duration: input.duration,
          url: '',
        },
        currentSource: sourceOfTrack(input),
        position: record.position,
        duration: record.duration ?? input.duration ?? 0,
        isPlaying: false,
        errorMessage: null,
      });
    } catch {
      // 恢复是非关键路径：读不到就当没有
    }
  },

  /** 恢复态起播（QYP3-053）：从上一次的进度继续（点播放条上的「播放」）。 */
  resumeRestored: async () => {
    const s = get();
    if (s.engine !== null || !s.restored || !s.restoreInput) return;
    const input = s.restoreInput;
    // 下一曲/上一曲要能走完整个曲库（用户预期"默认播放全部曲目"）：本地/
    // WebDAV 恢复态按「全部曲目」的同一排序重建完整队列，恢复的那首落在
    // 原位；只取到一页或多页里找不到它（已删除）时退回单曲队列。
    // 服务器曲目不在全部曲目域内，保持单曲队列（上个会话的队列已不可考）。
    let queue: MusicTrackInput[] = [input];
    let startIndex = 0;
    if (!input.serverId) {
      try {
        const rows: MusicTrackRow[] = [];
        const limit = 200;
        for (let offset = 0; ; offset += limit) {
          const res = (await window.electronAPI.getMusicTracks(offset, limit)) as {
            ok?: boolean;
            data?: { tracks: MusicTrackRow[] };
          };
          const page = res?.data?.tracks ?? [];
          rows.push(...page);
          if (page.length < limit) break;
        }
        const idx = rows.findIndex((t) => t.id === input.trackId);
        if (rows.length > 1 && idx !== -1) {
          queue = rows.map((t) => ({
            trackId: t.id,
            sourceId: t.source_id,
            title: t.title,
            artist: t.artist,
            albumartist: t.albumartist,
            duration: t.duration,
            path: t.path,
            codec: t.codec,
          }));
          startIndex = idx;
        }
      } catch {
        // 曲库读取失败不阻塞恢复起播：退回单曲队列
      }
    }
    await get().playQueue(queue, startIndex, { startPosition: s.restorePosition });
  },

  stop: () => {
    // 幂等：视频状态事件会高频到达，已无音乐会话时直接返回（不 set）
    if (get().engine === null) return;
    // 音乐会话结束，自救/兜底标记与懒解析记录作废（QYP3-037）
    flacRecoveringQueueId = null;
    directFallbackQueueId = null;
    resolveFailedIds.clear();
    // 收尾上报要在状态清空**之前**（读的是当前状态）：服务器曲目由此走
    // Stopped 落位（QYP3-038），"当前播放的音乐"留下最后位置（QYP3-053）
    pushNowPlaying({ final: true });
    reportServerProgress({ final: true });
    serverPlaySessionId = null;
    engineSingleton?.pause();
    currentLyrics = null;
    pushDeskLyrics(get().position, false);
    void window.electronAPI.setMusicEngineActive(false);
    set({
      engine: null,
      current: null,
      currentSource: null,
      position: 0,
      duration: 0,
      isPlaying: false,
      queueLength: 0,
      queueIndex: 0,
      queueSnapshot: [],
      serverQueue: [],
      serverIndex: -1,
      mpvQueue: [],
      mpvQueueIndex: -1,
      errorMessage: null,
    });
  },

  endSession: () => {
    const s = get();
    if (s.engine === null && !s.restored) return;
    // mpv 引擎要显式停（QYP3-067）：只清渲染层状态，mpv 会在看不见的地方
    // 继续把这首放完
    if (s.engine === 'mpv') void window.electronAPI.playerControl('stop');
    // 收尾上报（本地进度 / 服务器 Stopped）在状态清空之前走 stop()
    get().stop();
    // 恢复态也要清：`stop()` 对 engine === null 是幂等的，不会动这些字段
    set({
      restored: false,
      restoreInput: null,
      restorePosition: 0,
      current: null,
      currentSource: null,
      position: 0,
      duration: 0,
      isPlaying: false,
      queueLength: 0,
      queueIndex: 0,
      queueSnapshot: [],
      serverQueue: [],
      serverIndex: -1,
      mpvQueue: [],
      mpvQueueIndex: -1,
      errorMessage: null,
    });
    // 落盘的待播记录一并作废，否则下次启动又把播放条恢复出来
    void Promise.resolve(window.electronAPI.clearNowPlaying?.()).catch(() => undefined);
  },
}));

/**
 * next/prev 后从引擎实例 + store 快照拉回状态（单点归一）。
 * QYP3-037：改按引擎队列下标对齐快照（服务器合成 id 为负，按 id 查找
 * 语义脆弱）；currentSource/歌词从 musicInput 路由，服务器歌词仍走端点。
 */
function syncFromEngine(engineInstance: WebAudioEngine): void {
  const st = engineInstance.queueState;
  const snapshot = useMusicPlaybackStore.getState().queueSnapshot;
  const track = (snapshot[st.index] as EngineExtTrack | undefined) ?? null;
  useMusicPlaybackStore.setState({
    queueLength: st.length,
    queueIndex: st.index,
    current: track,
    currentSource: track ? sourceOfTrack(track.musicInput) : null,
    position: 0,
    isPlaying: st.currentTrackId !== null,
  });
  if (track) {
    loadLyricsFor(sourceOfTrack(track.musicInput));
    // 换曲重开服务器会话（QYP3-038）；本地曲目顺带清空
    beginServerSession(track);
  }
}

// 开发期调试出口（QYP3-068e 排查换曲问题引入）：CDP 里可直接读播放状态，
// 生产构建（import.meta.env.PROD）不挂
const devFlag = (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV;
if (devFlag) {
  (window as unknown as { __qyMusicStore?: unknown }).__qyMusicStore = useMusicPlaybackStore;
}
