/**
 * app_config 值存取契约。
 *
 * `SETTINGS.SET` 统一 `JSON.stringify` 写入，`SETTINGS.GET` 必须对称地
 * 解析回来——否则界面上"保存成功"的设置永远读不出来（历史 bug：EQ 增益、
 * ReplayGain、自定义预设、拾音器模式全部写进去了但读回的是带引号的字符串，
 * 导致数组判空、字符串比较失败，功能整体失效）。
 *
 * 主进程专用键（如 `playback.autoNext`）直连 `storage.getConfig` 写入裸
 * 字符串，不走这里；为兼容这类历史行，解析失败时原样返回字符串。
 */

export function encodeConfigValue(value: unknown): string {
  return JSON.stringify(value);
}

export function decodeConfigValue(raw: string | undefined): unknown {
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
