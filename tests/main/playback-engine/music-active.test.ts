import { afterEach, describe, expect, it } from 'vitest';
import {
  clearMusicSession,
  isMpvMusicActive,
  isMusicEngineActive,
  isMusicSessionActive,
  setMpvMusicActive,
  setMusicEngineActive,
} from '../../../src/main/modules/playback-engine/music-active';

/**
 * 音乐会话标志（QYP3-013 / QYP3-026）：
 * - renderer 引擎由 SET_ENGINE_ACTIVE 上报；
 * - mpv 引擎由 LOAD_FILE 是否带 audioChain 判定；
 * - 任一为真即"音乐会话进行中"，视频加载由 LOAD_FILE 结束会话。
 */

afterEach(() => clearMusicSession());

describe('music session flags (QYP3-026)', () => {
  it('starts inactive', () => {
    expect(isMusicEngineActive()).toBe(false);
    expect(isMpvMusicActive()).toBe(false);
    expect(isMusicSessionActive()).toBe(false);
  });

  it('treats either engine as an active music session', () => {
    setMusicEngineActive(true);
    expect(isMusicSessionActive()).toBe(true);
    expect(isMpvMusicActive()).toBe(false);

    setMusicEngineActive(false);
    expect(isMusicSessionActive()).toBe(false);

    setMpvMusicActive(true);
    expect(isMusicSessionActive()).toBe(true);
    expect(isMpvMusicActive()).toBe(true);
  });

  it('clearMusicSession ends both engines at once', () => {
    setMusicEngineActive(true);
    setMpvMusicActive(true);
    clearMusicSession();
    expect(isMusicEngineActive()).toBe(false);
    expect(isMpvMusicActive()).toBe(false);
    expect(isMusicSessionActive()).toBe(false);
  });

  it('coerces truthy values like the IPC boundary does', () => {
    setMusicEngineActive(1 as unknown as boolean);
    setMpvMusicActive('yes' as unknown as boolean);
    expect(isMusicSessionActive()).toBe(true);
  });
});
