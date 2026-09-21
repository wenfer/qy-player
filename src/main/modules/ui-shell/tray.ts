import { Tray, Menu, nativeImage, BrowserWindow, app } from 'electron';
import { resolve, win32 } from 'path';
import { isMac } from '../platform';

let tray: Tray | null = null;

/**
 * 托盘图标（QYP3-063）：macOS 菜单栏用 32px 黑色模板图（随亮暗主题自动
 * 反色，setTemplateImage）；win/linux 共用彩色 PNG（Windows 的 Electron
 * 托盘接受 PNG，无需 ico）。
 */
export function resolveTrayIconPath(
  applicationPath: string,
  platform: NodeJS.Platform = process.platform
): string {
  // 注入非宿主平台时也要有正确的路径语义（POSIX 主机上测 win32 用例）
  const resolveFn = platform === 'win32' ? win32.resolve : resolve;
  if (platform === 'darwin') return resolveFn(applicationPath, 'resources', 'icon-tray-Template.png');
  return resolveFn(applicationPath, 'resources', 'icon.png');
}

export function createTray(mainWindow: BrowserWindow): Tray | null {
  // app.getAppPath() points at the repository root in development and at
  // app.asar after packaging. __dirname points at out/, so resolving from it
  // used to escape the application directory and always miss this asset.
  const iconPath = resolveTrayIconPath(app.getAppPath());
  let icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty() && isMac) {
    // mac 模板图缺失（旧安装包/手工环境）时回退彩色 PNG
    const fallback = resolve(app.getAppPath(), 'resources', 'icon.png');
    if (fallback !== iconPath) icon = nativeImage.createFromPath(fallback);
  }
  if (icon.isEmpty()) {
    console.error(`[TRAY] Failed to load icon: ${iconPath}`);
    return null;
  }
  if (isMac) icon.setTemplateImage(true);

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
