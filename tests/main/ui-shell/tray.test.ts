import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {},
  Menu: {},
  nativeImage: {},
  Tray: class {},
}));

import { resolveTrayIconPath } from '../../../src/main/modules/ui-shell/tray';

describe('resolveTrayIconPath', () => {
  it('loads the bundled icon from the application root in development', () => {
    expect(resolveTrayIconPath('/workspace/qy-player')).toBe('/workspace/qy-player/resources/icon.png');
  });

  it('loads the bundled icon from inside app.asar after packaging', () => {
    expect(resolveTrayIconPath('/opt/QY Player/resources/app.asar')).toBe(
      '/opt/QY Player/resources/app.asar/resources/icon.png'
    );
  });

  it('uses the monochrome template image on macOS (QYP3-063)', () => {
    expect(resolveTrayIconPath('/workspace/qy-player', 'darwin')).toBe(
      '/workspace/qy-player/resources/icon-tray-Template.png'
    );
  });

  it('windows keeps the colored png (tray accepts png, no ico needed)', () => {
    expect(resolveTrayIconPath('C:\\app', 'win32')).toBe('C:\\app\\resources\\icon.png');
  });
});
