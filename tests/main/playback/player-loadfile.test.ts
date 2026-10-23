import { describe, expect, it, vi } from 'vitest';
import { PlayerCore, formatMediaTitle } from '../../../src/main/modules/player-core';
import type { MpvIpcClient } from '../../../src/main/modules/player-core/mpv-ipc-client';

function withIpc(
  player: PlayerCore,
  command: ReturnType<typeof vi.fn>,
  setProperty: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(undefined)
): void {
  (player as unknown as { ipc: MpvIpcClient | null }).ipc = {
    command,
    setProperty,
  } as unknown as MpvIpcClient;
}

describe('PlayerCore.loadFile command compatibility', () => {
  it('calls loadfile with path and replace when startPosition is not set', async () => {
    const player = new PlayerCore();
    const command = vi.fn().mockResolvedValue(undefined);
    withIpc(player, command);

    await player.loadFile('https://example.com/video.mp4');

    expect(command).toHaveBeenCalledTimes(1);
    expect(command).toHaveBeenCalledWith('loadfile', 'https://example.com/video.mp4', 'replace');
  });

  it('calls loadfile with 3 args on mpv <= 0.32 when startPosition is provided', async () => {
    const player = new PlayerCore();
    const command = vi.fn().mockResolvedValue(undefined);
    withIpc(player, command);

    await player.loadFile('https://example.com/video.mp4', 123.4);

    expect(command).toHaveBeenCalledTimes(1);
    expect(command).toHaveBeenCalledWith('loadfile', 'https://example.com/video.mp4', 'replace', 'start=123');
  });

  it('falls back to 4 args (with index -1) on mpv >= 0.33 when 3-arg loadfile fails', async () => {
    const player = new PlayerCore();
    const command = vi.fn()
      .mockRejectedValueOnce(new Error('invalid parameter'))
      .mockResolvedValueOnce(undefined);
    withIpc(player, command);

    await player.loadFile('https://example.com/video.mp4', 45.9);

    expect(command).toHaveBeenCalledTimes(2);
    expect(command).toHaveBeenNthCalledWith(1, 'loadfile', 'https://example.com/video.mp4', 'replace', 'start=45');
    expect(command).toHaveBeenNthCalledWith(2, 'loadfile', 'https://example.com/video.mp4', 'replace', -1, 'start=45');
  });

  it('sets http-header-fields property when headers are provided', async () => {
    const player = new PlayerCore();
    const command = vi.fn().mockResolvedValue(undefined);
    const setProperty = vi.fn().mockResolvedValue(undefined);
    withIpc(player, command, setProperty);

    await player.loadFile('https://example.com/video.mp4', 0, 'Authorization: Bearer test-token');

    expect(setProperty).toHaveBeenCalledWith(
      'http-header-fields',
      'Authorization: Bearer test-token'
    );
    expect(command).toHaveBeenCalledWith('loadfile', 'https://example.com/video.mp4', 'replace');
  });

  it('sets force-media-title and title properties when title is provided', async () => {
    const player = new PlayerCore();
    const command = vi.fn().mockResolvedValue(undefined);
    const setProperty = vi.fn().mockResolvedValue(undefined);
    withIpc(player, command, setProperty);

    await player.loadFile(
      'https://example.com/video.mp4',
      0,
      undefined,
      '西部世界 - S01E03 - 迷宫'
    );

    expect(setProperty).toHaveBeenCalledWith('force-media-title', '西部世界 - S01E03 - 迷宫');
    expect(setProperty).toHaveBeenCalledWith('title', '西部世界 - S01E03 - 迷宫');
  });

  it('setTitle updates both force-media-title and title properties', async () => {
    const player = new PlayerCore();
    const command = vi.fn().mockResolvedValue(undefined);
    const setProperty = vi.fn().mockResolvedValue(undefined);
    withIpc(player, command, setProperty);

    await player.setTitle('10间敢死队');

    expect(setProperty).toHaveBeenCalledWith('force-media-title', '10间敢死队');
    expect(setProperty).toHaveBeenCalledWith('title', '10间敢死队');
  });
});

describe('formatMediaTitle (QYP3-069)', () => {
  it('formats full series episode with season, episode and title', () => {
    const title = formatMediaTitle({
      seriesName: '权力的游戏',
      seasonNumber: 1,
      episodeNumber: 5,
      title: '狮子与玫瑰',
    });
    expect(title).toBe('权力的游戏 - S01E05 - 狮子与玫瑰');
  });

  it('drops episode title if identical to seriesName or code', () => {
    const title1 = formatMediaTitle({
      seriesName: '权力的游戏',
      seasonNumber: 1,
      episodeNumber: 5,
      title: '权力的游戏',
    });
    expect(title1).toBe('权力的游戏 - S01E05');

    const title2 = formatMediaTitle({
      seriesName: '权力的游戏',
      seasonNumber: 1,
      episodeNumber: 5,
      title: 'S01E05',
    });
    expect(title2).toBe('权力的游戏 - S01E05');
  });

  it('formats series with season/episode but no episode title', () => {
    const title = formatMediaTitle({
      seriesName: '权力的游戏',
      seasonNumber: 2,
      episodeNumber: 1,
    });
    expect(title).toBe('权力的游戏 - S02E01');
  });

  it('formats series without season/episode', () => {
    const title = formatMediaTitle({
      seriesName: '特别短剧',
      title: '番外篇',
    });
    expect(title).toBe('特别短剧 - 番外篇');
  });

  it('formats movie with title', () => {
    const title = formatMediaTitle({
      title: '10间敢死队',
    });
    expect(title).toBe('10间敢死队');
  });

  it('falls back to clean filename from local path', () => {
    const title = formatMediaTitle(undefined, '/home/user/Movies/Inception.2010.1080p.mkv');
    expect(title).toBe('Inception.2010.1080p');
  });

  it('strips query parameters from stream url in fallback', () => {
    const title = formatMediaTitle(undefined, 'https://example.com/videos/stream.mp4?Static=true&token=abc');
    expect(title).toBe('stream');
  });
});

