/**
 * 平台基础模块（QYP3-061）：跨平台改造的公共判定与工具。
 *
 * 纪律：所有平台分支必须收敛到这里或本目录的子模块，业务代码禁止散落
 * `process.platform === 'xxx'` 判断（desk-lyrics 的历史分支除外）。
 * Linux 是第一目标平台：任何改动不得改变 Linux 上的既有行为。
 */

export const isMac = process.platform === 'darwin';
export const isWin = process.platform === 'win32';
export const isLinux = process.platform === 'linux';
