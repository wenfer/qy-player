/**
 * 音乐播放引擎选择器（QYP3-009，ADR-0007）。
 *
 * 单一来源：UI 不得复制算法。纯函数、表驱动测试。
 *
 * 决策规则（顺序即优先级）：
 * 1. 服务端转码 → mpv（HLS，Chromium 直连解不了）。
 * 2. CUE 分轨 → mpv（精确 start/end 由 mpv loadfile 选项承载）。
 * 3. 用户偏好「兼容性优先」→ 一律 mpv。
 * 4. 用户偏好「拾音器优先」（默认）→ Chromium 直连可解码格式走
 *    renderer 引擎（Web Audio：真频谱 + 真波形 + 均衡器），其余 mpv。
 *
 * QYP3-037：服务器（Jellyfin/Emby）与 WebDAV **不再**因认证问题强制 mpv——
 * 音频改由主进程 `qy-stream://` 代理转发（Range 透传 + 认证头注入，token 不
 * 跨 IPC），渲染层拿到的是同源自定义协议，可以喂 `createMediaElementSource`
 * 出真实频谱。因此 sourceKind 只作记录，不再参与判定；非直解格式仍走 mpv。
 *
 * direct 格式清单是**契约**：以 spike 实测为准（PHASE3-PLAN §10 风险 1），
 * 不凭文档假设；宁可错降 mpv（兼容性保底），不可误判 direct。
 * 唯一例外：服务器音频条目拿不到 codec 时按「乐观直解」处理（见
 * playback-resolver），由 direct 解码失败 → mpv 的一次性回退兜底。
 */

export type EngineId = 'webaudio' | 'mpv';
export type EnginePreference = 'spectrum-first' | 'compat-first';

/** Chromium 原生可解码（MediaSource/`<audio>`）——保守清单。 */
export const DIRECT_CODECS: ReadonlySet<string> = new Set([
  'mp3', 'aac', 'flac', 'ogg', 'oga', 'opus', 'wav', 'm4a', 'm4b', 'webm', 'weba',
]);

export interface EngineInput {
  /** 音轨 codec（music_tracks.codec / 服务器 MediaStreams.Codec）；未知可空。 */
  codec: string | null;
  /** 来源类型（仅记录用：认证已由 qy-stream 代理解决）。 */
  sourceKind: 'local' | 'webdav' | 'server';
  /** 服务端转码模式强制 mpv。 */
  transcode?: boolean;
  /** CUE 分轨（music_cue_entries 存在）。 */
  isCueTrack?: boolean;
  preference: EnginePreference;
}

export interface EngineDecision {
  engine: EngineId;
  reason: 'transcode' | 'cue-track' | 'compat-first' | 'direct-codec' | 'non-direct-codec';
}

export function selectAudioEngine(input: EngineInput): EngineDecision {
  if (input.transcode) return { engine: 'mpv', reason: 'transcode' };
  if (input.isCueTrack) return { engine: 'mpv', reason: 'cue-track' };
  if (input.preference === 'compat-first') return { engine: 'mpv', reason: 'compat-first' };
  const codec = (input.codec ?? '').toLowerCase();
  if (DIRECT_CODECS.has(codec)) return { engine: 'webaudio', reason: 'direct-codec' };
  return { engine: 'mpv', reason: 'non-direct-codec' };
}

/**
 * 快捷判定：是否 renderer 引擎（UI 显隐拾音器模式用）。
 * reason 'direct-codec' 之外的一律 mpv。
 */
export function isWebAudioEngine(input: EngineInput): boolean {
  return selectAudioEngine(input).engine === 'webaudio';
}
