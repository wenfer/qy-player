/**
 * CUE 分轨解析（QYP3-006，计划 §5）。
 *
 * strict 契约：CUE 引用的音频文件必须在同一扫描批次的已知文件集合里
 * （由调用方传入），否则整张不入库并报告 —— 绝不产生指向不存在文件的
 * 幽灵分轨。解析是纯函数；时间换算 MM:SS:FF（75 帧/秒，视频标准帧率
 * 25 时 FF 为帧内第几个 1/75 秒）→ 秒。
 */

export interface CueEntry {
  position: number;
  title: string;
  /** 秒。 */
  start: number;
  /** 秒；最后一条为 null（播放到文件末尾）。 */
  end: number | null;
  /** 引用的音频文件（TRACK FILE 指向，通常是父 cue 同名文件）。 */
  audioFile: string;
}

export interface ParsedCue {
  entries: CueEntry[];
  /** 无法解析的行（报告用，不中断）。 */
  warnings: string[];
}

/** MM:SS:FF → 秒（75 fps 约定；FF 超 74 按分钟进位容错）。 */
export function cueTimeToSeconds(time: string): number | undefined {
  const m = time.match(/^(\d{1,3}):([0-5]\d):([0-5]\d)$/);
  if (!m) return undefined;
  return Number(m[1]) * 60 + Number(m[2]) + Number(m[3]) / 75;
}

export function parseCue(content: string): ParsedCue {
  const entries: CueEntry[] = [];
  const warnings: string[] = [];
  // FILE 行（取最后一个 FILE 指向的分轨宿主；BIN/CUE 混编按 spec 只认音频 FILE）
  let currentAudio = '';
  let currentTitle = '';
  let currentStart: number | undefined;
  let position = 0;
  // 只有真的处于 TRACK 内才把缺 INDEX 记为告警（专辑级 TITLE 不算）
  let inTrack = false;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(';')) continue;
    let m = line.match(/^FILE\s+"(.+?)"\s+\w+/i) ?? line.match(/^FILE\s+(\S+)\s+\w+/i);
    if (m) {
      flush();
      currentAudio = m[1];
      continue;
    }
    m = line.match(/^TRACK\s+(\d+)\s+AUDIO/i);
    if (m) {
      flush();
      inTrack = true;
      continue;
    }
    m = line.match(/^TITLE\s+"(.*)"/i) ?? line.match(/^TITLE\s+(.+)/i);
    if (m) {
      currentTitle = m[1].trim().replace(/^"|"$/g, '');
      continue;
    }
    m = line.match(/^INDEX\s+01\s+(\d{1,3}:[0-5]\d:[0-5]\d)/i);
    if (m) {
      const sec = cueTimeToSeconds(m[1]);
      if (sec !== undefined) {
        currentStart = sec;
      } else {
        warnings.push(`无法解析 INDEX 时间: ${m[1]}`);
      }
      continue;
    }
  }
  flush();
  function flush(): void {
    if (currentStart === undefined) {
      // 无 INDEX 01 的 TRACK 不可播：跳过（不产生幽灵分轨）
      if (inTrack) warnings.push(`TRACK 缺少 INDEX 01，已跳过: ${currentTitle}`);
      currentTitle = '';
      inTrack = false;
      return;
    }
    entries.push({
      position,
      title: currentTitle || `Track ${position + 1}`,
      start: currentStart,
      end: null,
      audioFile: currentAudio,
    });
    currentTitle = '';
    currentStart = undefined;
    inTrack = false;
    position += 1;
  }
  // 相邻条目闭合区间；最后一条 end=null（播到文件末尾）
  for (let i = 0; i < entries.length - 1; i++) {
    entries[i].end = entries[i + 1].start;
  }
  // 排序容错：乱序 INDEX（有的抓轨器不按 TRACK 顺序写 TITLE）
  entries.sort((a, b) => a.start - b.start);
  entries.forEach((e, i) => {
    e.position = i;
  });
  return { entries, warnings };
}

/**
 * strict 校验：entries 引用的音频文件必须全部在 knownFiles（相对路径，
 * 小写化匹配）。返回缺失文件集合；非空 = 整张不入库。
 */
export function validateCueAudioFiles(cue: ParsedCue, knownFiles: ReadonlySet<string>): string[] {
  const missing = new Set<string>();
  for (const entry of cue.entries) {
    const key = entry.audioFile.toLowerCase();
    if (!knownFiles.has(key)) missing.add(entry.audioFile);
  }
  return [...missing];
}
