import { Tray, Menu, nativeImage, BrowserWindow, app } from 'electron';
import { resolve } from 'path';

let tray: Tray | null = null;

export function resolveTrayIconPath(applicationPath: string): string {
  return resolve(applicationPath, 'resources', 'icon.png');
}

export function createTray(mainWindow: BrowserWindow): Tray | null {
  // app.getAppPath() points at the repository root in development and at
  // app.asar after packaging. __dirname points at out/, so resolving from it
  // used to escape the application directory and always miss this asset.
  const iconPath = resolveTrayIconPath(app.getAppPath());
  const icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) {
    console.error(`[TRAY] Failed to load icon: ${iconPath}`);
    return null;
  }

  const createdTray = new Tray(icon);
  tray = createdTray;
  createdTray.setToolTip('QY Player');

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
    createdTray.setContextMenu(Menu.buildFromTemplate(template));
  };

  updateContextMenu();

  createdTray.on('click', () => {
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
    updateContextMenu();
  });

  return createdTray;
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
