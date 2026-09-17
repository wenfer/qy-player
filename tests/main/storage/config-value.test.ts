import { describe, expect, it } from 'vitest';
import { decodeConfigValue, encodeConfigValue } from '../../../src/main/modules/storage/config-value';

/**
 * app_config 存取契约（P2 修复）：`SETTINGS.SET` 写 JSON，`SETTINGS.GET`
 * 必须解析回来。此前 GET 返回裸字符串，导致"保存成功但读不出来"——
 * EQ 增益数组、ReplayGain 模式、自定义预设、拾音器模式全部失效。
 */

describe('app_config value contract', () => {
  it('round-trips every JSON-representable value', () => {
    for (const value of ['track', '', 0, 1.5, true, false, null]) {
      expect(decodeConfigValue(encodeConfigValue(value))).toBe(value);
    }
    const arr = [6, 5, 3, 1, 0, 0, 0, 0, 0, 0];
    const decoded = decodeConfigValue(encodeConfigValue(arr));
    expect(Array.isArray(decoded)).toBe(true);
    expect(decoded).toEqual(arr);

    const obj = { 下一曲: 'MediaNextTrack' };
    expect(decodeConfigValue(encodeConfigValue(obj))).toEqual(obj);
  });

  it('keeps a stored string as the string, not a quoted blob', () => {
    // 这是原 bug 的具体形态：写 "track" 读回 '"track"'
    const raw = encodeConfigValue('track');
    expect(raw).toBe('"track"');
    expect(decodeConfigValue(raw)).toBe('track');
  });

  it('falls back to the raw string for legacy plain values', () => {
    // 主进程专用键直连 storage.setConfig 写裸串（playback.autoNext）
    expect(decodeConfigValue('true')).toBe(true); // JSON 可解析 → 布尔
    expect(decodeConfigValue('spectrum-first')).toBe('spectrum-first');
    expect(decodeConfigValue('28')).toBe(28);
  });

  it('returns undefined for a missing key', () => {
    expect(decodeConfigValue(undefined)).toBeUndefined();
  });
});
