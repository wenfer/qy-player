import { Tray, Menu, nativeImage, type NativeImage, BrowserWindow, app } from 'electron';
import { resolve } from 'path';
import { existsSync } from 'fs';

let tray: Tray | null = null;

function createFallbackIcon(): NativeImage {
  // Create a simple blue square icon using a minimal PNG buffer (1x1 blue pixel scaled)
  // PNG signature + IHDR + IDAT + IEND for a 16x16 blue square
  const base64Icon = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABGdBTUEAALGPC/xhBQAAACBjSFJNAAB6JgAAgIQAAPoAAACA6AAAdTAAAOpgAAA6mAAAF3CculE8AAAABmJLR0QA/wD/AP+gvaeTAAAACXBIWXMAAAsTAAALEwEAmpwYAAAAB3RJTUUH6QkHERwQf3f1cgAAAB1pVFh0Q29tbWVudAAAAAAAQ3JlYXRlZCB3aXRoIEdJTVBkLmUHAAAAf0lEQVQ4y2NgoBXY////fwYsgBWIfwDxfyT+Dy6G04C1QPyfAfNA6h6Qm0D8H4j/I/EZcBrACcT/gfg/Ev+DHIw2gA+I/wPxfxgcBmCzAKQApBikAGyA4X8g/g/E/3EYwAzE/4H4PwyO04D/QPwfiP8zwAB8QPwfiP8zwAAAmGEz0ZdNpU4AAAAldEVYdGRhdGU6Y3JlYXRlADIwMjUtMDktMDdUMDc6Mjg6NTMrMDA6MDCK+5flAAAAJXRFWHRkYXRlOm1vZGlmeQAyMDI1LTA5LTA3VDA3OjI4OjUzKzAwOjAw16L5yQAAAABJRU5ErkJggg==';
  return nativeImage.createFromDataURL(`data:image/png;base64,${base64Icon}`);
}

export function createTray(mainWindow: BrowserWindow): Tray {
  const iconPath = resolve(__dirname, '../../../resources/icon.png');
  let icon: NativeImage;

  if (existsSync(iconPath)) {
    icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) {
      icon = createFallbackIcon();
    }
  } else {
    icon = createFallbackIcon();
  }

  tray = new Tray(icon);
  tray.setToolTip('QY Player');

  const updateContextMenu = () => {
    const template: Electron.MenuItemConstructorOptions[] = [
      {
        label: mainWindow.isVisible() ? '隐藏窗口' : '显示窗口',
        click: () => {
          if (mainWindow.isVisible()) {
            mainWindow.hide();
          } else {
            mainWindow.show();
            mainWindow.focus();
          }
          updateContextMenu();
        },
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          app.quit();
        },
      },
    ];
    tray!.setContextMenu(Menu.buildFromTemplate(template));
  };

  updateContextMenu();

  tray.on('click', () => {
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
    updateContextMenu();
  });

  return tray;
}

export function getTray(): Tray | null {
  return tray;
}

export function destroyTray(): void {
  if (tray) {
    tray.destroy();
    tray = null;
  }
}
