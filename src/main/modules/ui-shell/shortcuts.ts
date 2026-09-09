import { globalShortcut, BrowserWindow } from 'electron';
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
    togglePause: () => {
      if (player.isReady()) player.togglePause().catch(() => {});
    },
    seekForward: () => {
      if (player.isReady()) player.seek(30, 'relative').catch(() => {});
    },
    seekBack: () => {
      if (player.isReady()) player.seek(-30, 'relative').catch(() => {});
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
