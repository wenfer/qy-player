import { globalShortcut, BrowserWindow } from 'electron';
import { isMusicEngineActive } from '../playback-engine/music-active';
import { IPC_CHANNELS } from '../../../shared/ipc-channels';
import { PlayerCore } from '../player-core';
import { GLOBAL_SHORTCUTS, type ShortcutDef } from '../../../shared/shortcut-defs';

const ASPECT_RATIOS = [
  { value: 'auto', label: '自动' },
  { value: '16:9', label: '16:9' },
  { value: '4:3', label: '4:3' },
  { value: '2.35:1', label: '2.35:1 宽银幕' },
  { value: '1:1', label: '1:1' },
];

/** actionId -> accelerator, persisted in app_config under the "shortcuts" key. */
export interface ShortcutOverrides {
  [id: string]: string;
}

export function registerGlobalShortcuts(
  mainWindow: BrowserWindow,
  player: PlayerCore,
  overrides: ShortcutOverrides = {}
): { failed: string[] } {
  let aspectIndex = 0;

  const handlers: Record<string, () => void> = {
    // 媒体键双用途（QYP3-013）：音乐（renderer 引擎）激活时转发给
    // renderer（store 单点处理），否则走 mpv 视频/音频语义。
    togglePause: () => {
      if (isMusicEngineActive()) {
        mainWindow.webContents.send(IPC_CHANNELS.MUSIC.ON_COMMAND, 'toggle');
        return;
      }
      if (player.isReady()) player.togglePause().catch(() => {});
    },
    seekForward: () => {
      if (isMusicEngineActive()) {
        mainWindow.webContents.send(IPC_CHANNELS.MUSIC.ON_COMMAND, 'next');
        return;
      }
      if (player.isReady()) player.seek(30, 'relative').catch(() => {});
    },
    seekBack: () => {
      if (isMusicEngineActive()) {
        mainWindow.webContents.send(IPC_CHANNELS.MUSIC.ON_COMMAND, 'prev');
        return;
      }
      if (player.isReady()) player.seek(-30, 'relative').catch(() => {});
    },
    // 收藏当前曲目（QYP3-013a）：只对音乐生效（renderer 引擎激活时），
    // 视频播放没有"曲目"概念，静默无操作。
    favoriteCurrent: () => {
      if (isMusicEngineActive()) {
        mainWindow.webContents.send(IPC_CHANNELS.MUSIC.ON_COMMAND, 'favorite');
      }
    },
    // 手动切集（QYP3-068q）："下一集是哪一集"只有 renderer 知道（剧集列表 +
    // 主进程的纯选择器），这里只把方向转过去；音乐会话激活时不抢键。
    prevEpisode: () => {
      if (isMusicEngineActive()) return;
      mainWindow.webContents.send(IPC_CHANNELS.AUTO_NEXT.ON_COMMAND, 'prev');
    },
    nextEpisode: () => {
      if (isMusicEngineActive()) return;
      mainWindow.webContents.send(IPC_CHANNELS.AUTO_NEXT.ON_COMMAND, 'next');
    },
    toggleWindow: () => {
      if (mainWindow.isVisible()) mainWindow.hide();
      else {
        mainWindow.show();
        mainWindow.focus();
      }
    },
    cycleAspect: () => {
      if (!player.isReady()) return;
      aspectIndex = (aspectIndex + 1) % ASPECT_RATIOS.length;
      const ratio = ASPECT_RATIOS[aspectIndex];
      player
        .setAspectRatio(ratio.value)
        .then(() => player.showText(`画面比例: ${ratio.label}`))
        .catch(() => {});
    },
  };

  const failed: string[] = [];
  for (const def of GLOBAL_SHORTCUTS as ShortcutDef[]) {
    const accelerator = overrides[def.id] || def.defaultAccelerator;
    const action = handlers[def.id];
    if (!action) continue;
    const ok = globalShortcut.register(accelerator, action);
    if (!ok) failed.push(def.id);
  }
  return { failed };
}

export function unregisterGlobalShortcuts(): void {
  globalShortcut.unregisterAll();
}
