import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MusicSpectrumService } from '../../../src/main/modules/music-spectrum';
import { bandIndexForHz } from '../../../src/main/modules/music-spectrum/pcm-fft';

/**
 * 端到端（QYP3-050，需要本机有 ffmpeg，没有就跳过）：
 * 用 ffmpeg 自己造一段 1kHz 正弦 → 走完整服务（探测真实二进制 → spawn →
 * PCM → FFT → 落盘）→ 断言频谱峰值落在 1kHz 对应的频带。
 *
 * 自带输入、无需二进制夹具；这是"没有音频设备也能验"的最强一条。
 */

const ffmpeg = spawnSync('which', ['ffmpeg']).status === 0;
const suite = ffmpeg ? describe : describe.skip;

let dir = '';
let input = '';

beforeAll(() => {
  if (!ffmpeg) return;
  dir = mkdtempSync(join(tmpdir(), 'qysp-e2e-'));
  input = join(dir, 'sine.wav');
  const made = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=2',
    '-ac', '1', '-ar', '24000', input,
  ]);
  expect(made.status).toBe(0);
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

suite('offline spectrum end to end with real ffmpeg (QYP3-050)', () => {
  it('decodes a 1kHz sine into the 1kHz band and caches it on disk', async () => {
    const onSettled = vi.fn();
    const service = new MusicSpectrumService({
      dir,
      startupDelayMs: 0,
      onSettled,
    });
    service.setCurrent({
      mediaId: 'local:0:sine.wav',
      url: input,
      durationSec: 2,
      fileStamp: `${statSync(input).size}:0`,
    });
    await vi.waitFor(() => expect(onSettled).toHaveBeenCalled(), { timeout: 30_000 });
    expect(onSettled).toHaveBeenCalledWith({ mediaId: 'local:0:sine.wav', status: 'ready' });

    const res = service.get();
    expect(res.status).toBe('ready');
    if (res.status !== 'ready') return;
    expect(res.frameCount).toBe(24); // 2 秒 × 12fps
    expect(res.bands).toBe(48);

    const frame = res.data.subarray(0, res.bands);
    let peak = 0;
    for (let i = 1; i < frame.length; i += 1) if (frame[i] > frame[peak]) peak = i;
    expect(peak).toBe(bandIndexForHz(1000, res.bands));
    // lavfi 的 sine 源本身约 -18dBFS（实测 volumedetect），并非满幅：
    // 满幅正弦在这套量化下约 212，减去 18dB×255/72 ≈ 64 → 约 148
    expect(frame[peak]).toBeGreaterThan(120);

    // 第二遍直接命中落盘缓存（不再走 ffmpeg）
    const again = new MusicSpectrumService({ dir, startupDelayMs: 0, onSettled: vi.fn() });
    again.setCurrent({ mediaId: 'local:0:sine.wav', url: input, durationSec: 2, fileStamp: `${statSync(input).size}:0` });
    expect(again.get().status).toBe('ready');
  });

  it('degrades to unavailable for a bogus binary instead of throwing', async () => {
    const onSettled = vi.fn();
    const service = new MusicSpectrumService({
      dir,
      startupDelayMs: 0,
      locator: { detect: async () => '/nonexistent/ffmpeg', known: () => '/nonexistent/ffmpeg' },
      onSettled,
    });
    service.setCurrent({ mediaId: 'local:0:none', url: input });
    await vi.waitFor(() => expect(onSettled).toHaveBeenCalled(), { timeout: 30_000 });
    expect(service.get().status).toBe('unavailable');
  });
});
