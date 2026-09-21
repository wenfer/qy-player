import { describe, expect, it } from 'vitest';
import { parseQyFileUrl } from '../../../src/main/modules/platform/qy-file-url';

/**
 * qy-file:// 请求解析（QYP3-062）：匹配语义与原 handler 一致，另对
 * Windows 形态（前导斜杠 / 盘符规范化 / query 残留 / 反斜杠）做防御性归一。
 */
describe('parseQyFileUrl (QYP3-062)', () => {
  it('parses the canonical linux forms unchanged', () => {
    expect(parseQyFileUrl('qy-file://covers/12.jpg')).toEqual({ kind: 'covers', name: '12.jpg' });
    expect(parseQyFileUrl('qy-file://audio/5/%E9%9F%B3%E4%B9%90/%E6%99%B4%E5%A4%A9.mp3')).toEqual({
      kind: 'audio',
      sourceId: 5,
      relPath: '音乐/晴天.mp3',
    });
  });

  it('normalizes leading slashes added by standard-scheme canonicalization', () => {
    expect(parseQyFileUrl('qy-file:///covers/12.jpg')).toEqual({ kind: 'covers', name: '12.jpg' });
    expect(parseQyFileUrl('qy-file:///audio/1/%E6%99%B4%E5%A4%A9.mp3')).toEqual({
      kind: 'audio',
      sourceId: 1,
      relPath: '晴天.mp3',
    });
  });

  it('strips query/hash fragments before matching', () => {
    expect(parseQyFileUrl('qy-file://covers/12.jpg?x=1')).toEqual({ kind: 'covers', name: '12.jpg' });
    expect(parseQyFileUrl('qy-file://audio/1/a.mp3#frag')).toEqual({
      kind: 'audio',
      sourceId: 1,
      relPath: 'a.mp3',
    });
  });

  it('unifies backslash separators in the audio relative path', () => {
    expect(parseQyFileUrl('qy-file://audio/1/%E9%9F%B3%E4%B9%90%5C%E6%99%B4%E5%A4%A9.mp3')).toEqual({
      kind: 'audio',
      sourceId: 1,
      relPath: '音乐/晴天.mp3',
    });
  });

  it('still rejects traversal-shaped covers names and unknown paths', () => {
    // 原实现的 covers 白名单是 [\w.-]+，.. 单独成段不含 / 时会命中正则——
    // 真正的目录穿越防护在 handler 的包含校验（coversRoot + sep 前缀），此处
    // 只钉住解析层不放宽
    expect(parseQyFileUrl('qy-file://covers/..%2Fsecret.png')).toBeNull();
    expect(parseQyFileUrl('qy-file://something/else')).toBeNull();
    expect(parseQyFileUrl('qy-file://audio/abc/x.mp3')).toBeNull();
    expect(parseQyFileUrl('qy-file://audio/1/')).toBeNull();
  });
});
