/**
 * 读一项应用配置（QYP3-068v）。
 *
 * **`SETTINGS.GET` 不像其它 IPC 那样返回 `{ ok, data }`，它直接返回解码后的值**
 * （`main/ipc/index.ts`：`return decodeConfigValue(storage.getConfig(key))`）。
 * 所以 `(await getSettings(k))?.data` 恒为 `undefined`——而且 `undefined` 恰好
 * 让所有 `typeof v === 'string'` / `Number.isFinite(Number(v))` 之类的判断
 * 静默走默认值，看起来只是"设置没保存"，不会报任何错。
 *
 * 这个坑已经吃过两次：P2-001 的读写不对称（均衡器/ReplayGain/自定义预设/拾音器
 * 开关四项静默失效），以及 QYP3-068v 的 mpv 起播音效链（`readAudioFxSettings`
 * 读到默认值，起播 af 恒为空，只有拖滑块才生效）。**新代码一律走这里**，
 * 不要自己写 `?.data`。
 */
export function readSetting<T = unknown>(key: string): Promise<T> {
  return window.electronAPI.getSettings(key) as Promise<T>;
}
