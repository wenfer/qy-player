import { globalShortcut, BrowserWindow } from 'electron';
import { PlayerCore } from '../player-core';

const ASPECT_RATIOS = [
  { value: 'auto', label: '自动' },
  { value: '16:9', label: '16:9' },
  { value: '4:3', label: '4:3' },
  { value: '2.35:1', label: '2.35:1 宽银幕' },
  { value: '1:1', label: '1:1' },
];

export function registerGlobalShortcuts(mainWindow: BrowserWindow, player: PlayerCore): void {
  // MediaPlayPause - toggle play/pause
  globalShortcut.register('MediaPlayPause', () => {
    if (player.isReady()) {
      player.togglePause().catch(() => {
        // Ignore errors when no media loaded
      });
    }
  });

  // MediaNextTrack - next episode (placeholder, would need playlist logic)
  globalShortcut.register('MediaNextTrack', () => {
    if (player.isReady()) {
      // For now just seek forward 30s
      player.seek(30, 'relative').catch(() => {});
    }
  });

  // MediaPreviousTrack - previous / seek back
  globalShortcut.register('MediaPreviousTrack', () => {
    if (player.isReady()) {
      player.seek(-30, 'relative').catch(() => {});
    }
  });

  // Ctrl+Shift+Q - show/hide main window
  globalShortcut.register('CommandOrControl+Shift+Q', () => {
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  // Ctrl+Shift+A - cycle display aspect ratio (works while MPV is playing)
  let aspectIndex = 0;
  globalShortcut.register('CommandOrControl+Shift+A', () => {
    if (!player.isReady()) return;
    aspectIndex = (aspectIndex + 1) % ASPECT_RATIOS.length;
    const ratio = ASPECT_RATIOS[aspectIndex];
    player
      .setAspectRatio(ratio.value)
      .then(() => player.showText(`画面比例: ${ratio.label}`))
      .catch(() => {});
  });
}

export function unregisterGlobalShortcuts(): void {
  globalShortcut.unregisterAll();
}
