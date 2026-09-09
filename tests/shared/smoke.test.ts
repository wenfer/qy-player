import { describe, expect, it } from 'vitest';
import { IPC_CHANNELS } from '@shared/ipc-channels';

describe('shared tests discovery (QYP2-001)', () => {
  it('resolves the @shared alias and imports channel constants', () => {
    expect(IPC_CHANNELS.PLAYER.LOAD_FILE).toBe('player:load-file');
  });
});
