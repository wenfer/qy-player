import { describe, expect, it } from 'vitest';
import { resolveResourcePath } from '../../../src/main/modules/platform/resource-path';
import { join } from 'path';

describe('resolveResourcePath', () => {
  it('locates resources in packaged mode under resourcesPath/resources', () => {
    const fakeExists = (p: string) => p === join('/app/resources', 'resources', 'uosc');
    const result = resolveResourcePath(
      {
        resourcesPath: '/app/resources',
        exists: fakeExists,
      },
      'uosc'
    );
    expect(result).toBe(join('/app/resources', 'resources', 'uosc'));
  });

  it('locates resources in packaged mode directly under resourcesPath fallback', () => {
    const fakeExists = (p: string) => p === join('/app/resources', 'uosc');
    const result = resolveResourcePath(
      {
        resourcesPath: '/app/resources',
        exists: fakeExists,
      },
      'uosc'
    );
    expect(result).toBe(join('/app/resources', 'uosc'));
  });

  it('locates resources in dev mode under appPath/resources', () => {
    const fakeExists = (p: string) => p === join('/home/user/project', 'resources', 'mpv-config');
    const result = resolveResourcePath(
      {
        resourcesPath: '',
        appPath: '/home/user/project',
        exists: fakeExists,
      },
      'mpv-config'
    );
    expect(result).toBe(join('/home/user/project', 'resources', 'mpv-config'));
  });

  it('falls back to cwd/resources in unit test / local env', () => {
    const fakeExists = (p: string) => p === join('/work', 'resources', 'uosc');
    const result = resolveResourcePath(
      {
        resourcesPath: '',
        appPath: '',
        cwd: '/work',
        exists: fakeExists,
      },
      'uosc'
    );
    expect(result).toBe(join('/work', 'resources', 'uosc'));
  });

  it('joins sub-segments correctly', () => {
    const fakeExists = (p: string) => p === join('/work', 'resources', 'mpv-config', 'fonts', 'uosc_icons.otf');
    const result = resolveResourcePath(
      {
        resourcesPath: '',
        appPath: '',
        cwd: '/work',
        exists: fakeExists,
      },
      'mpv-config',
      'fonts',
      'uosc_icons.otf'
    );
    expect(result).toBe(join('/work', 'resources', 'mpv-config', 'fonts', 'uosc_icons.otf'));
  });
});
