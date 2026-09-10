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
});
