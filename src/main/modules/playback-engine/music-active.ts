/**
 * 音乐引擎激活状态（QYP3-013）：main 侧全局快捷键的媒体键
 * （MediaPlayPause/Next/Previous）需要知道当前是音乐还是视频——
 * renderer 引擎不经 mpv，主进程无法从播放器状态判断。
 *
 * QYP3-026：mpv 引擎播音乐时同样算音乐会话（媒体键也交给 renderer，
 * 因为"下一曲"要按音乐队列走而不是 mpv 的快进 30 秒）。mpv 是否在放
 * 音乐只能从 LOAD_FILE 的 audioChain 参数判断（音乐加载独有）。
 */

let active = false;
let mpvMusic = false;

export function setMusicEngineActive(value: boolean): void {
  active = Boolean(value);
}

export function isMusicEngineActive(): boolean {
  return active;
}

/** mpv 本次加载的是音乐（LOAD_FILE 带 audioChain，视频不带）。 */
export function setMpvMusicActive(value: boolean): void {
  mpvMusic = Boolean(value);
}

export function isMpvMusicActive(): boolean {
  return mpvMusic;
}

/** 是否有音乐会话在进行（任一引擎）。 */
export function isMusicSessionActive(): boolean {
  return active || mpvMusic;
}

/** 结束音乐会话（视频加载时由 LOAD_FILE 调用）。 */
export function clearMusicSession(): void {
  active = false;
  mpvMusic = false;
}
