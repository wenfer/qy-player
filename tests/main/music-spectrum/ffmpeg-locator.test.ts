import { describe, expect, it, vi } from 'vitest';
import {
  createFfmpegLocator,
  ffmpegCandidates,
} from '../../../src/main/modules/music-spectrum/ffmpeg-locator';

/**
 * ffmpeg 探测（QYP3-050）：自建目录优先 → PATH；都不可用就返回 null（会话内
 * 否定结果也缓存，避免每次播放都去 spawn 一次）。
 */

describe('ffmpeg locator (QYP3-050)', () => {
  it('prefers the self-built binary under ~/.local/bin', async () => {
    const probe = vi.fn(() => Promise.resolve(true));
    const locator = createFfmpegLocator({
      homeDir: '/home/u',
      exists: () => true,
      probe,
    });
    expect(ffmpegCandidates('/home/u')[0]).toBe('/home/u/.local/bin/ffmpeg');
    await expect(locator.detect()).resolves.toBe('/home/u/.local/bin/ffmpeg');
    expect(probe).toHaveBeenCalledTimes(1);
    expect(locator.known()).toBe('/home/u/.local/bin/ffmpeg');
  });

  it('falls back to PATH when the self-built one is missing or broken', async () => {
    const probe = vi.fn((bin: string) => Promise.resolve(bin === 'ffmpeg'));
    const locator = createFfmpegLocator({ homeDir: '/home/u', exists: () => true, probe });
    await expect(locator.detect()).resolves.toBe('ffmpeg');
    expect(probe).toHaveBeenNthCalledWith(1, '/home/u/.local/bin/ffmpeg');
    expect(probe).toHaveBeenNthCalledWith(2, 'ffmpeg');
  });

  it('skips a non-existent self-built path without probing it', async () => {
    const probe = vi.fn(() => Promise.resolve(false));
    const locator = createFfmpegLocator({ homeDir: '/home/u', exists: () => false, probe });
    await expect(locator.detect()).resolves.toBeNull();
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith('ffmpeg');
  });

  it('caches both positive and negative results for the session', async () => {
    const probe = vi.fn(() => Promise.resolve(false));
    const locator = createFfmpegLocator({ homeDir: '/home/u', exists: () => true, probe });
    await locator.detect();
    await locator.detect();
    expect(probe).toHaveBeenCalledTimes(2); // 每个候选只探一次
  });

  it('shares one in-flight detection between concurrent callers', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const probe = vi.fn(async () => {
      await gate;
      return false;
    });
    // 只留 PATH 一个候选，便于数 probe 次数
    const locator = createFfmpegLocator({ homeDir: '/home/u', exists: () => false, probe });
    const a = locator.detect();
    const b = locator.detect();
    release();
    await expect(Promise.all([a, b])).resolves.toEqual([null, null]);
    expect(probe).toHaveBeenCalledTimes(1);
  });
});
