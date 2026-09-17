import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 全局快捷键契约（QYP3-013 / QYP3-013a）：
 * - 音乐（renderer 引擎）激活时媒体键与收藏键转发给 renderer；
 * - 未激活（视频/无播放）时媒体键保持 mpv 语义，收藏键静默无操作。
 */

const registered = new Map<string, () => void>();
const sent: Array<{ channel: string; payload: unknown }> = [];

vi.mock('electron', () => ({
  globalShortcut: {
    register: (accelerator: string, cb: () => void) => {
      registered.set(accelerator, cb);
      return true;
    },
    unregisterAll: () => registered.clear(),
  },
}));

import { registerGlobalShortcuts, unregisterGlobalShortcuts } from '../../../src/main/modules/ui-shell/shortcuts';
import { setMusicEngineActive } from '../../../src/main/modules/playback-engine/music-active';
import { GLOBAL_SHORTCUTS } from '../../../src/shared/shortcut-defs';

const mainWindow = {
  webContents: { send: (channel: string, payload: unknown) => sent.push({ channel, payload }) },
};
const player = {
  isReady: () => true,
  togglePause: vi.fn(() => Promise.resolve()),
  seek: vi.fn(() => Promise.resolve()),
};

beforeEach(() => {
  registered.clear();
  sent.length = 0;
  player.togglePause.mockClear();
  player.seek.mockClear();
});

afterEach(() => {
  setMusicEngineActive(false);
  unregisterGlobalShortcuts();
});

describe('global shortcuts (QYP3-013a)', () => {
  it('registers the favorite action with its default accelerator', () => {
    const failed = registerGlobalShortcuts(mainWindow as never, player as never).failed;
    expect(failed).toEqual([]);
    const def = GLOBAL_SHORTCUTS.find((d) => d.id === 'favoriteCurrent')!;
    expect(registered.has(def.defaultAccelerator)).toBe(true);
  });

  it('forwards the favorite shortcut to the renderer only while music is active', () => {
    registerGlobalShortcuts(mainWindow as never, player as never);
    const def = GLOBAL_SHORTCUTS.find((d) => d.id === 'favoriteCurrent')!;
    const fire = registered.get(def.defaultAccelerator)!;

    fire(); // 音乐未激活 → 静默
    expect(sent).toEqual([]);

    setMusicEngineActive(true);
    fire();
    expect(sent).toEqual([{ channel: 'music:on-command', payload: 'favorite' }]);
  });

  it('keeps mpv semantics for media keys when music is not active', () => {
    registerGlobalShortcuts(mainWindow as never, player as never);
    registered.get('MediaPlayPause')!();
    expect(player.togglePause).toHaveBeenCalled();
    registered.get('MediaNextTrack')!();
    expect(player.seek).toHaveBeenCalledWith(30, 'relative');
  });
});
