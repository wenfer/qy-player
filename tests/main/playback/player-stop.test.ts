import { describe, expect, it, vi } from 'vitest';
import { PlayerCore } from '../../../src/main/modules/player-core';
import type { MpvIpcClient } from '../../../src/main/modules/player-core/mpv-ipc-client';

/**
 * PlayerCore.stop()（QYP3-067）：音乐引擎切换 / 队尾停时 renderer 经
 * PLAYER.CONTROL('stop') 触发。mpv stop 命令卸载当前文件——没有它，
 * 无窗 mpv（vid=no）会继续把上一首放完，与新引擎双响。
 */

function withIpc(player: PlayerCore, command: ReturnType<typeof vi.fn>): void {
  (player as unknown as { ipc: MpvIpcClient | null }).ipc = { command } as unknown as MpvIpcClient;
}

describe('PlayerCore.stop (QYP3-067)', () => {
  it('sends the mpv stop command when a player is connected', async () => {
    const player = new PlayerCore();
    const command = vi.fn().mockResolvedValue(undefined);
    withIpc(player, command);

    await player.stop();

    expect(command).toHaveBeenCalledWith('stop');
  });

  it('is a no-op (never throws) when mpv has not been started', async () => {
    const player = new PlayerCore();

    await expect(player.stop()).resolves.toBeUndefined();
  });
});
