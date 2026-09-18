import { create } from 'zustand';
import { WebAudioEngine, type QueueTrack, type RepeatMode } from '../player/web-audio-engine';
import { isLocalFlacUrl } from '../player/flac-strip';
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
}

/** 歌词/进度的来源标识（本地音轨或服务器条目）。 */
export interface MusicSourceRef {
  trackId: number;
  serverId?: number;
  itemId?: string;
}

export interface MusicPlaybackStore extends MusicPlayingState {
  playQueue: (tracks: MusicTrackInput[], startIndex: number) => Promise<void>;
  pause: () => void;
  resume: () => void;
  next: () => Promise<void>;
  prev: () => Promise<void>;
  seek: (position: number) => void;
  setVolume: (volume: number) => void;
  setRepeat: (mode: RepeatMode) => void;
  toggleShuffle: () => void;
  clearError: () => void;
  /** 拾音器（QYP3-023）：实时频谱快照；非 renderer 引擎返回 null。 */
  getSpectrum: () => Uint8Array | null;
  /** 拾音器（QYP3-033）：真实时域波形快照；非 renderer 引擎/静音返回 null。 */
  getWaveform: () => Uint8Array | null;
  /** 服务器队列内跳转（QYP3-025）：mpv 引擎的上下曲靠它推进。 */
  playServerAt: (index: number) => Promise<void>;
  /** 结束音乐会话（QYP3-026）：视频接管 mpv 时由主进程事件触发。 */
  stop: () => void;
}

let engineSingleton: WebAudioEngine | null = null;
let lastReportAt = 0;
/** 播放令牌：新 playQueue 使旧 playCurrent 竞态失效（重复点击防护）。 */
let playToken = 0;

/**
 * direct 引擎解码失败、已交给 mpv 兜底的那一首（QYP3-030）。
 *
 * 失败路径上 `error` 事件先到、`play()` 的 rejection 后到，而状态里的
 * current 是在 `await playQueue()` 之后才写入的 —— 兜底因此不能读 current
 * （首播读到 null 会直接放弃；换曲后读到上一首会喂错曲子）。这里记下
 * 「谁失败了」，playQueue 的 catch 据此判断这次 rejection 是否已被兜底接管。
 */
let directFallbackTrackId: number | null = null;
/**
 * 正在做 FLAC 封面剥离自救的那一首（QYP3-033）。
 *
 * 与 `directFallbackTrackId` 同理：自救是异步的（fetch + 重封装 29MB 级别），
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
let flacRecoveringTrackId: number | null = null;
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

/** 歌词来源标识（QYP3-020b）：本地音轨 / 服务器条目二选一。 */
export function sourceOfTrack(t: MusicTrackInput): MusicSourceRef {
  return t.serverId && t.itemId
    ? { trackId: 0, serverId: t.serverId, itemId: t.itemId }
    : { trackId: t.trackId };
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
      pushDeskLyrics(
        typeof s.currentTime === 'number' ? s.currentTime : store.position,
        typeof s.isPlaying === 'boolean' ? s.isPlaying : store.isPlaying
      );
      // 自然结束：队列内推进（队尾 next() 内部 stop，不回卷）
      if (s.eof && store.serverQueue.length > 0) void store.next();
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
      if (s.engine === 'mpv') return; // 已在兼容引擎上，无兜底可谈
      const failed = s.current as EngineExtTrack | null;
      if (!failed || typeof failed.trackId !== 'number' || typeof failed.sourceId !== 'number') return;
      // QYP3-033：本地 FLAC 因内嵌封面非法被 Chromium 拒绝时，先剥离封面
      // 在内置引擎重播——保留真频谱/真波形，且不必兜底 mpv（也避免黑窗）。
      // 自救进行中：忽略这一首的后续错误，最终决策交给 recoverFlac 的 .then
      if (flacRecoveringTrackId === failed.trackId) return;
      if (isLocalFlacUrl(failed.url)) {
        flacRecoveringTrackId = failed.trackId;
        void getEngine()
          .recoverFlac(failed)
          .then((recovered) => {
            // 期间用户换了曲：这次自救/兜底不再适用于当前会话
            if (useMusicPlaybackStore.getState().current !== failed) return;
            if (recovered) {
              // 自救成功：保持 webaudio 引擎（真频谱/真波形都在这里）
              useMusicPlaybackStore.setState({ engine: 'webaudio', isPlaying: true, errorMessage: null });
              return;
            }
            fallbackToMpvNow(failed);
          });
        return;
      }
      fallbackToMpvNow(failed);
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
 * 兜底到 mpv 的统一入口（QYP3-033 抽取）：标记「谁失败了」+ 同步切到 mpv
 * 状态面 + 实际触发 mpv loadfile。先前的 onError 内联逻辑迁移至此，供
 * FLAC 自救失败后的兜底复用。
 */
function fallbackToMpvNow(track: EngineExtTrack): void {
  directFallbackTrackId = track.trackId;
  // 同步切到 mpv：状态面与"已交给兼容引擎"一致，紧随其后的
  // play() rejection 也才能被认作预期（见 playQueue 的 catch）
  useMusicPlaybackStore.setState({ engine: 'mpv', isPlaying: false, errorMessage: null });
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
 */
async function fallbackToMpv(track: EngineExtTrack): Promise<void> {
  try {
    const resolution = (await window.electronAPI.resolvePlayback(
      { provider: 'music', sourceId: track.sourceId, itemId: String(track.trackId) },
      { engineForce: 'mpv' }
    )) as {
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

export const useMusicPlaybackStore = create<MusicPlaybackStore>((set, get) => ({
  engine: null,
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
  currentSource: null,

  playQueue: async (tracks, startIndex) => {
    const start = tracks[startIndex];
    if (!start) return;
    // 新的播放请求：上一首的 FLAC 自救标记作废（见 flacRecoveringTrackId 注释）
    flacRecoveringTrackId = null;
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
        const { eqGains } = await readAudioChainSettings();
        if (eqGains) engineInstance.setEq(eqGains);
        // 应用当前音量（换曲不重置用户设定的音量）
        engineInstance.setVolume(get().volume / 100);
        lastReportAt = Date.now();
        // QYP3-030：状态先落再起播。引擎失败是异步的（error 事件 → 兜底），
        // 兜底要按"正在播的那首"重播；若等 playQueue 返回再写状态，失败时
        // 这里还是 null（首播）或上一首（换曲），兜底就会放弃或喂错曲子。
        void window.electronAPI.setMusicEngineActive(true); // 媒体键双用途路由
        set({
          engine: 'webaudio',
          current: queue[idx] ?? null,
          currentSource: sourceOfTrack(start),
          position: 0,
          duration: queue[idx]?.duration ?? 0,
          isPlaying: true,
          queueLength: queue.length,
          queueIndex: idx,
          queueSnapshot: queue,
          errorMessage: null,
        });
        await engineInstance.playQueue(queue, idx, get().repeat, get().shuffle);
        loadLyricsFor(sourceOfTrack(start));
      } else {
        // mpv 引擎接管：本地冷门格式（QYP3-011）或服务器音频（QYP3-025）。
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
          position: 0,
          duration: start.duration ?? 0,
          isPlaying: true,
          errorMessage: null,
          currentSource: sourceOfTrack(start),
          // 服务器队列（本地冷门格式时为单曲，上下曲无队列可走）
          serverQueue: start.serverId ? tracks : [],
          serverIndex: start.serverId ? startIndex : -1,
        });
        // QYP3-012：mpv 引擎同样带 EQ/ReplayGain（设置在主进程消费）
        const chain = await readAudioChainSettings();
        await window.electronAPI.playerLoadFile(
          url,
          startPosition > 0 ? startPosition : undefined,
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
      if (directFallbackTrackId === start.trackId) {
        directFallbackTrackId = null;
        return;
      }
      // 正在做 FLAC 封面剥离自救：同理，结果由 recoverFlac 的 .then 定，
      // 这里不能把浏览器原文（Failed to load because no supported source
      // was found.）当成失败弹出来——即便自救随后成功
      if (flacRecoveringTrackId === start.trackId) return;
      set({ errorMessage: decodeErrorMessage(e) });
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
      // QYP3-025：服务器音乐队列内前进；无队列（本地冷门格式）则单曲处理。
      // QYP3-035：循环模式在此落实（one=重播当前 / all=队尾回卷），否则精简
      // 模式的循环按钮对 mpv 音源形同虚设。
      if (s.serverQueue.length > 0) {
        if (s.repeat === 'one') await get().playServerAt(s.serverIndex);
        else if (s.serverIndex + 1 < s.serverQueue.length) await get().playServerAt(s.serverIndex + 1);
        else if (s.repeat === 'all') await get().playServerAt(0);
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
      await engineInstance.prev();
      syncFromEngine(set, engineInstance);
    } else if (s.engine === 'mpv') {
      if (s.serverQueue.length > 0 && s.serverIndex - 1 >= 0) {
        await get().playServerAt(s.serverIndex - 1);
      } else if (s.serverQueue.length > 0 && s.repeat === 'all') {
        await get().playServerAt(s.serverQueue.length - 1);
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
    if (engineSingleton) engineSingleton.queueState.repeat = mode;
  },

  toggleShuffle: () => {
    const next = !get().shuffle;
    set({ shuffle: next });
    if (engineSingleton) engineSingleton.queueState.shuffle = next;
  },

  clearError: () => set({ errorMessage: null }),

  getSpectrum: () => engineSingleton?.getSpectrum() ?? null,
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

  stop: () => {
    // 幂等：视频状态事件会高频到达，已无音乐会话时直接返回（不 set）
    if (get().engine === null) return;
    flacRecoveringTrackId = null; // 音乐会话结束，自救标记作废
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
      errorMessage: null,
    });
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
    currentSource: current ? { trackId: current.id } : null,
    position: 0,
    isPlaying: st.currentTrackId !== null,
  });
  if (current) loadLyricsFor({ trackId: current.id });
}
