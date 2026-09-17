// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  useMusicPlaybackStore,
  type MusicTrackInput,
} from '../../../src/renderer/stores/music-playback-store';

/**
 * 认证头会话透传（QYP3-027）。
 *
 * WebDAV 音频的直链**不带凭据**：Basic 认证头由主进程 stash 在
 * streamHeaders 里，只把不透明的 streamSessionId 交给渲染层。渲染层必须
 * 在 loadfile 时把它原样回传（playerLoadFile 第 5 参），主进程才能 take()
 * 出 headers 交给 mpv。漏传 = 需认证的 WebDAV 音频静默 401（mpv 失败不
 * 上报，连 toast 都没有），所以三处音乐 loadfile 都要钉住。
 */

const api = {
  resolvePlayback: vi.fn(),
  playerLoadFile: vi.fn(() => Promise.resolve()),
  playerControl: vi.fn(() => Promise.resolve({ ok: true })),
  setMusicEngineActive: vi.fn(() => Promise.resolve({ ok: true })),
  getSettings: vi.fn(() => Promise.resolve({ ok: true, data: null })),
  getMusicLyrics: vi.fn(() => Promise.resolve({ ok: true, data: { hasLyrics: false, content: null } })),
  getServerLyrics: vi.fn(() => Promise.resolve({ ok: true, data: { hasLyrics: false, content: null } })),
  pushDeskLyricsState: vi.fn(() => Promise.resolve({ ok: true })),
};

vi.stubGlobal('electronAPI', api);

const SESSION = 'sess-webdav-1';

/** WebDAV 音轨：sourceId 非 0 且无 serverId → 走 mpv + webdav-stream。 */
const webdavTrack = (trackId: number, title: string): MusicTrackInput => ({
  trackId,
  sourceId: 3,
  title,
  artist: '周杰伦',
  albumartist: '周杰伦',
  duration: 269,
  path: `Music/${title}.flac`,
  codec: 'flac',
});

const serverTrack = (itemId: string, title: string): MusicTrackInput => ({
  trackId: 0,
  sourceId: 0,
  serverId: 1,
  provider: 'jellyfin',
  itemId,
  title,
  artist: '周杰伦',
  albumartist: '周杰伦',
  duration: 269,
  path: '',
  codec: null,
});

/** 第 5 参（streamSessionId）位置。 */
const SESSION_ARG = 4;

beforeEach(() => {
  vi.clearAllMocks();
  useMusicPlaybackStore.setState({
    engine: null,
    current: null,
    currentSource: null,
    position: 0,
    duration: 0,
    isPlaying: false,
    queueLength: 0,
    queueIndex: 0,
    errorMessage: null,
    queueSnapshot: [],
    serverQueue: [],
    serverIndex: -1,
  });
});

describe('music loadfile auth session (QYP3-027)', () => {
  it('playQueue hands the webdav stream session back to main', async () => {
    api.resolvePlayback.mockResolvedValue({
      ok: true,
      data: {
        kind: 'webdav-stream',
        url: 'https://dav.example.com/Music/a.flac',
        startPosition: 0,
        streamSessionId: SESSION,
        engine: { engine: 'mpv', reason: 'compat-first' },
        mediaContext: { mediaType: 'webdav', mediaId: '3:Music/a.flac', title: '晴天' },
      },
    });

    await useMusicPlaybackStore.getState().playQueue([webdavTrack(11, '晴天')], 0);

    expect(api.playerLoadFile).toHaveBeenCalledTimes(1);
    const args = api.playerLoadFile.mock.calls[0] as unknown[];
    expect(args[0]).toBe('https://dav.example.com/Music/a.flac');
    expect(args[SESSION_ARG]).toBe(SESSION);
    expect(useMusicPlaybackStore.getState().engine).toBe('mpv');
  });

  it('playServerAt hands the transcode session back to main', async () => {
    useMusicPlaybackStore.setState({
      serverQueue: [serverTrack('t1', '晴天')],
      serverIndex: 0,
    });
    api.resolvePlayback.mockResolvedValue({
      ok: true,
      data: {
        kind: 'online-transcode',
        url: 'http://s:8096/Audio/t1/universal',
        startPosition: 0,
        streamSessionId: SESSION,
        mediaContext: { mediaType: 'jellyfin', mediaId: 't1', serverId: 1 },
      },
    });

    await useMusicPlaybackStore.getState().playServerAt(0);

    expect(api.playerLoadFile).toHaveBeenCalledTimes(1);
    expect((api.playerLoadFile.mock.calls[0] as unknown[])[SESSION_ARG]).toBe(SESSION);
  });

  it('passes undefined when the resolution carries no session (local file)', async () => {
    api.resolvePlayback.mockResolvedValue({
      ok: true,
      data: {
        kind: 'local-file',
        url: '/media/Music/冷门.ape',
        startPosition: 0,
        engine: { engine: 'mpv', reason: 'compat-first' },
        mediaContext: { mediaType: 'local', mediaId: 'Music/冷门.ape', title: '冷门' },
      },
    });

    await useMusicPlaybackStore.getState().playQueue([webdavTrack(12, '冷门')], 0);

    expect((api.playerLoadFile.mock.calls[0] as unknown[])[SESSION_ARG]).toBeUndefined();
  });
});
