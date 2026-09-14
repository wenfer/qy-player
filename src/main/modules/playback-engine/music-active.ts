/**
 * 音乐引擎激活状态（QYP3-013）：main 侧全局快捷键的媒体键
 * （MediaPlayPause/Next/Previous）需要知道当前是音乐（renderer 引擎）
 * 还是视频（mpv）——renderer 引擎不经 mpv，主进程无法从播放器状态
 * 判断。renderer 在 webaudio 起播/停止时上报，main 侧消费。
 */

let active = false;

export function setMusicEngineActive(value: boolean): void {
  active = Boolean(value);
}

export function isMusicEngineActive(): boolean {
  return active;
}
