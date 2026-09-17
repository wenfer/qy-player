/**
 * LRC 解析器（QYP3-018，计划 §7）：纯函数、无 IO。
 *
 * 支持：标准行级时间标签 [mm:ss.xx]、多时间标签（一行多标签）、
 * 增强型逐字标签 <mm:ss.xx>（词内）、偏移量标签 [+/-ms]、元数据
 * （ti/ar/al/offset）、乱序行（输出按时间排序）、容错（坏行跳过）。
 */

export interface LrcLine {
  /** 秒。 */
  time: number;
  /** 行文本（已剥离逐字标签）。 */
  text: string;
  /** 增强型逐字时间点（相对行内字符；无则 undefined）。 */
  words?: Array<{ time: number; text: string }>;
}

export interface LrcMetadata {
  title?: string;
  artist?: string;
  album?: string;
  /** 毫秒偏移（正值=歌词提前）。 */
  offset: number;
}

export interface ParsedLrc {
  lines: LrcLine[];
  meta: LrcMetadata;
  /** 无法解析的行（报告用）。 */
  warnings: string[];
}

const WORD_TAG = /<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>/g;
const META_TAG = /^\[(ti|ar|al|by|offset|re|ve):(.*)\]$/i;

function timeParts(min: string, sec: string, frac: string | undefined): number {
  const f = frac ? Number(`0.${frac}`) : 0;
  return Number(min) * 60 + Number(sec) + f;
}

export function parseLrc(content: string): ParsedLrc {
  const meta: LrcMetadata = { offset: 0 };
  const warnings: string[] = [];
  const rawLines: Array<{ times: number[]; text: string; words?: Array<{ time: number; text: string }> }> = [];

  for (const raw of content.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    const metaMatch = line.match(META_TAG);
    if (metaMatch) {
      const key = metaMatch[1].toLowerCase();
      const value = metaMatch[2].trim();
      if (key === 'ti') meta.title = value;
      else if (key === 'ar') meta.artist = value;
      else if (key === 'al') meta.album = value;
      else if (key === 'offset') {
        const off = Number(value);
        if (Number.isFinite(off)) meta.offset = off;
      }
      continue;
    }

    // 收集行首全部时间标签 [..][..]（多时间标签）
    const times: number[] = [];
    let rest = line;
    for (;;) {
      const m = rest.match(/^\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/);
      if (!m) break;
      times.push(timeParts(m[1], m[2], m[3]));
      rest = rest.slice(m[0].length);
    }
    if (times.length === 0) {
      if (rest) warnings.push(line.slice(0, 60));
      continue;
    }

    // 增强型逐字标签：<mm:ss.xx> = 该标签后词的起点；标签前的文本
    // 不属于任何词（留在行文本里）。wm.index 为绝对位置（global 正则
    // exec 从 lastIndex 起匹配，index 仍是全串坐标）。
    let text = rest;
    let words: Array<{ time: number; text: string }> | undefined;
    if (WORD_TAG.test(rest)) {
      WORD_TAG.lastIndex = 0;
      const tokens: Array<{ time: number; text: string }> = [];
      let cursor = 0;
      for (;;) {
        WORD_TAG.lastIndex = cursor;
        const wm = WORD_TAG.exec(rest);
        if (!wm) break;
        const after = rest.slice(wm.index + wm[0].length);
        const nextTag = after.match(/<\d{1,3}:\d{1,2}/);
        const wordText = nextTag ? after.slice(0, nextTag.index) : after;
        tokens.push({ time: timeParts(wm[1], wm[2], wm[3]), text: wordText });
        cursor = wm.index + wm[0].length;
      }
      if (tokens.length > 0) {
        words = tokens;
        text = rest.replace(WORD_TAG, '');
      }
      WORD_TAG.lastIndex = 0;
    }

    for (const t of times) {
      rawLines.push({ times: [t], text, ...(words && words.length > 0 ? { words } : {}) });
    }
  }

  // 常见约定：正值 offset = 歌词提前显示（time - offset）
  const offsetSec = meta.offset / 1000;
  const lines: LrcLine[] = rawLines
    .map((r) => ({
      time: Math.max(0, r.times[0] - offsetSec),
      text: r.text,
      ...(r.words ? { words: r.words } : {}),
    }))
    .sort((a, b) => a.time - b.time);

  return { lines, meta, warnings };
}

/** 当前应显示的行号（timeupdate 驱动；二分）。 */
export function findCurrentLine(lines: LrcLine[], time: number): number {
  if (lines.length === 0) return -1;
  let lo = 0;
  let hi = lines.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].time <= time) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/** 下一行（面板滚动预告用）。 */
export function findNextLine(lines: LrcLine[], time: number): number {
  const idx = findCurrentLine(lines, time);
  return Math.min(idx + 1, lines.length - 1);
}
