import { describe, expect, it, vi } from 'vitest';
import { PlayerCore } from '../../../src/main/modules/player-core';
import type { MpvIpcClient } from '../../../src/main/modules/player-core/mpv-ipc-client';
import { AUDIO_FX_DEFAULT, mpvAudioChainFromFx, sanitizeAudioFx } from '../../../src/main/modules/playback-engine/audio-fx';

/**
 * 音效链下发到 mpv（QYP3-068v）。
 *
 * 这里钉的是**下发给 mpv 的属性序列**，因为整条链路的失败都是静默的
 * （player-core 里 set_property 一律 catch 掉），只有断言"到底发了什么"
 * 才能抓到"链没挂上"或"顺手把 ReplayGain 关了"这类问题。
 */

function withIpc(player: PlayerCore): {
  command: ReturnType<typeof vi.fn>;
  setProperty: ReturnType<typeof vi.fn>;
} {
  const command = vi.fn().mockResolvedValue(undefined);
  const setProperty = vi.fn().mockResolvedValue(undefined);
  (player as unknown as { ipc: MpvIpcClient | null }).ipc = { command, setProperty } as unknown as MpvIpcClient;
  return { command, setProperty };
}

describe('applyMusicAudioChain (QYP3-068v)', () => {
  it('sets af and leaves ReplayGain untouched when told to keep it', async () => {
    const player = new PlayerCore();
    const { setProperty } = withIpc(player);

    await player.applyMusicAudioChain('lavfi=[bass=f=60:t=q:w=0.7:g=6]', {
      mode: 'track',
      preamp: 3,
      fallback: -2,
      clip: true,
    });

    expect(setProperty.mock.calls.map((c) => c[0])).toEqual([
      'af',
      'replaygain',
      'replaygain-preamp',
      'replaygain-fallback',
      'replaygain-clip',
    ]);
    expect(setProperty.mock.calls[0][1]).toBe('lavfi=[bass=f=60:t=q:w=0.7:g=6]');
    expect(setProperty.mock.calls[1][1]).toBe('track');
  });

  it('passing null for ReplayGain turns it off — the trap the hot path must avoid', async () => {
    const player = new PlayerCore();
    const { setProperty } = withIpc(player);

    await player.applyMusicAudioChain('lavfi=[equalizer=f=1000:t=q:w=0.7:g=4]', null);

    // 这正是热更新不能传 null 的原因：它会顺手把用户的 ReplayGain 关掉
    expect(setProperty.mock.calls.map((c) => c[0])).toEqual(['af', 'replaygain']);
    expect(setProperty.mock.calls[1][1]).toBe('no');
  });

  it('is a silent no-op when mpv has not started', async () => {
    const player = new PlayerCore();
    await expect(player.applyMusicAudioChain('lavfi=[volume=3dB]', null)).resolves.toBeUndefined();
  });
});

describe('audio fx → mpv chain (QYP3-068v)', () => {
  it('untouched settings produce an empty chain (no filter loaded at all)', () => {
    // 全直通必须真的不挂滤镜：常挂一条空转的链对老机是白给的 CPU
    expect(mpvAudioChainFromFx(sanitizeAudioFx(AUDIO_FX_DEFAULT))).toBeUndefined();
  });

  it('a dialed-in EQ produces a chain this project has verified against target mpv', () => {
    const fx = sanitizeAudioFx({
      eq: { enabled: true, preamp: 0, bands: [{ freq: 1000, gain: 6, q: 1, type: 'peaking' }] },
      limiter: { enabled: true, ceiling: -1 },
    });
    expect(mpvAudioChainFromFx(fx)).toBe(
      'lavfi=[equalizer=f=1000:t=q:w=1:g=6,alimiter=limit=0.8913]'
    );
  });

  it('never leaves a dangling `lavfi=[]` for mpv', () => {
    // 空的 lavfi=[] 会被 mpv 判为非法，而失败是静默的
    const cases = [AUDIO_FX_DEFAULT, { ...AUDIO_FX_DEFAULT, enabled: false }];
    for (const c of cases) expect(mpvAudioChainFromFx(c)).toBeUndefined();
  });
});
