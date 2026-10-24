import { app } from 'electron';
import { existsSync } from 'fs';
import { join } from 'path';

export interface ResourcePathDeps {
  resourcesPath?: string;
  appPath?: string;
  cwd?: string;
  exists?: (p: string) => boolean;
}

/**
 * Resolve external resource file paths on the real filesystem.
 *
 * MPV and external tools CANNOT read files from inside Electron's app.asar archive.
 * Any external configuration, fonts, and Lua scripts must reside on the actual filesystem.
 *
 * When packaged (app.isPackaged):
 *   Files shipped via extraResources are placed at process.resourcesPath/resources/...
 *
 * In development / test:
 *   Files reside at <project_root>/resources/...
 */
export function resolveResourcePath(deps: ResourcePathDeps, ...segments: string[]): string;
export function resolveResourcePath(...segments: string[]): string;
export function resolveResourcePath(
  depsOrFirstSegment?: ResourcePathDeps | string,
  ...remainingSegments: string[]
): string {
  let deps: ResourcePathDeps | undefined;
  let segments: string[];

  if (typeof depsOrFirstSegment === 'object' && depsOrFirstSegment !== null) {
    deps = depsOrFirstSegment;
    segments = remainingSegments;
  } else if (typeof depsOrFirstSegment === 'string') {
    segments = [depsOrFirstSegment, ...remainingSegments];
  } else {
    segments = remainingSegments;
  }

  const exists = deps?.exists ?? existsSync;

  // 1. Packaged extraResources location (highest priority when packaged)
  const resourcesPath =
    deps?.resourcesPath !== undefined
      ? deps.resourcesPath
      : typeof process !== 'undefined' && (process as { resourcesPath?: string }).resourcesPath;

  if (resourcesPath) {
    const packagedPath = join(resourcesPath, 'resources', ...segments);
    if (exists(packagedPath)) return packagedPath;
    const directPath = join(resourcesPath, ...segments);
    if (exists(directPath)) return directPath;
  }

  // 2. Dev mode: check project root via app.getAppPath()
  let appPath = deps?.appPath;
  if (!appPath && typeof app !== 'undefined' && typeof app.getAppPath === 'function') {
    try {
      appPath = app.getAppPath();
    } catch {
      // app not ready or running in pure node
    }
  }
  if (appPath) {
    const devPath = join(appPath, 'resources', ...segments);
    if (exists(devPath)) return devPath;
  }

  // 3. Fallback: process.cwd()/resources
  const cwd = deps?.cwd ?? (typeof process !== 'undefined' ? process.cwd() : '');
  if (cwd) {
    const cwdPath = join(cwd, 'resources', ...segments);
    if (exists(cwdPath)) return cwdPath;
  }

  // 4. Fallback relative to __dirname (when built into out/main.cjs -> out/../resources)
  if (typeof __dirname !== 'undefined') {
    const relPath = join(__dirname, '..', 'resources', ...segments);
    if (exists(relPath)) return relPath;
  }

  return cwd ? join(cwd, 'resources', ...segments) : join(...segments);
}
