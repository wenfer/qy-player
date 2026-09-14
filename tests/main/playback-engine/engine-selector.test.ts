import { describe, expect, it } from 'vitest';
import {
  DIRECT_CODECS,
  selectAudioEngine,
  isWebAudioEngine,
  type EngineInput,
} from '../../../src/main/modules/playback-engine/engine-selector';

const base: EngineInput = {
  codec: 'mp3',
  sourceKind: 'local',
  preference: 'spectrum-first',
};

describe('engine selector (QYP3-009, ADR-0007)', () => {
  it('server audio always goes to mpv (auth headers / transcode)', () => {
    expect(selectAudioEngine({ ...base, sourceKind: 'server' })).toEqual({
      engine: 'mpv',
      reason: 'server-stream',
    });
    expect(selectAudioEngine({ ...base, sourceKind: 'server', codec: 'flac' })).toEqual({
      engine: 'mpv',
      reason: 'server-stream',
    });
    // 服务端转码强制 mpv，即使本地直连格式
    expect(selectAudioEngine({ ...base, transcode: true })).toEqual({
      engine: 'mpv',
      reason: 'transcode',
    });
  });

  it('cue tracks go to mpv (precise start/end)', () => {
    expect(selectAudioEngine({ ...base, isCueTrack: true })).toEqual({
      engine: 'mpv',
      reason: 'cue-track',
    });
    expect(selectAudioEngine({ ...base, isCueTrack: true, codec: 'flac' }).reason).toBe('cue-track');
  });

  it('compat-first preference forces mpv for everything', () => {
    expect(selectAudioEngine({ ...base, preference: 'compat-first' })).toEqual({
      engine: 'mpv',
      reason: 'compat-first',
    });
    expect(
      selectAudioEngine({ ...base, preference: 'compat-first', codec: 'mp3' }).reason
    ).toBe('compat-first');
  });

  it('spectrum-first: direct codecs go to WebAudio, others to mpv', () => {
    for (const codec of DIRECT_CODECS) {
      expect(selectAudioEngine({ ...base, codec }).engine).toBe('webaudio');
    }
    expect(selectAudioEngine({ ...base, codec: 'ape' }).engine).toBe('mpv');
    expect(selectAudioEngine({ ...base, codec: 'ape' }).reason).toBe('non-direct-codec');
    expect(selectAudioEngine({ ...base, codec: 'wv' }).engine).toBe('mpv');
    expect(selectAudioEngine({ ...base, codec: 'dsf' }).engine).toBe('mpv');
  });

  it('unknown/missing codec degrades to mpv (never misjudged direct)', () => {
    expect(selectAudioEngine({ ...base, codec: null }).engine).toBe('mpv');
    expect(selectAudioEngine({ ...base, codec: 'exotic' }).engine).toBe('mpv');
  });

  it('codec matching is case-insensitive', () => {
    expect(selectAudioEngine({ ...base, codec: 'FLAC' }).engine).toBe('webaudio');
  });

  it('webdav always goes to mpv (direct URL needs auth headers)', () => {
    expect(selectAudioEngine({ ...base, sourceKind: 'webdav', codec: 'flac' })).toEqual({
      engine: 'mpv',
      reason: 'webdav-auth',
    });
    expect(selectAudioEngine({ ...base, sourceKind: 'webdav', codec: 'ape' }).reason).toBe(
      'webdav-auth'
    );
  });

  it('isWebAudioEngine mirrors the decision', () => {
    expect(isWebAudioEngine({ ...base, codec: 'mp3' })).toBe(true);
    expect(isWebAudioEngine({ ...base, codec: 'ape' })).toBe(false);
    expect(isWebAudioEngine({ ...base, sourceKind: 'server' })).toBe(false);
  });
});
