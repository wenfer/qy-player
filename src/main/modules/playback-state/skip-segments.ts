/**
 * 剧集跳过片头/片尾（segments 来源：Jellyfin 10.9+ MediaSegments API）。
 *
 * 设计约束（§16.4/§12 一脉相承）：
 * - 分段获取失败永不影响播放（fire-and-forget，catch 归空）；
 * - 仅剧集（MediaContext 带 seriesName）启用；
 * - 触发逻辑为纯函数，控制器只做一次性触发与状态保持；
 * - 片尾跳转贴近文件末尾时落到 duration-0.8s，让自然 EOF 先行——
 *   最终保存与自动连播的次序仍由 eof 保存链保证（QYP2-035）。
 */
export interface SkipSegment {
  type: 'intro' | 'outro';
  start: number;
  end: number;
}

/** MediaSegments 的 100ns tick → 秒。非法（负数/倒挂）丢弃。 */
function ticksToSeconds(ticks: unknown): number | null {
  if (typeof ticks !== 'number' || !Number.isFinite(ticks) || ticks < 0) return null;
  return ticks / 10_000_000;
}

/**
 * 解析 Jellyfin GET /MediaSegments/{itemId} 响应：
 * { items: [{ Type, StartTicks, EndTicks }] }。
 * Intro→intro；Credits/Outro→outro；其余类型（Preview/Recap/Commercial/
 * 未知）丢弃。结构不符返回空数组（fail-open：无分段=不跳过，不报错）。
 */
export function parseMediaSegments(payload: unknown): SkipSegment[] {
  if (typeof payload !== 'object' || payload === null) return [];
  const items = (payload as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];
  const out: SkipSegment[] = [];
  for (const item of items) {
    if (typeof item !== 'object' || item === null) continue;
    const type = (item as { Type?: unknown }).Type;
    const mapped: SkipSegment['type'] | null =
      type === 'Intro' ? 'intro' : type === 'Credits' || type === 'Outro' ? 'outro' : null;
    if (!mapped) continue;
    const start = ticksToSeconds((item as { StartTicks?: unknown }).StartTicks);
    const end = ticksToSeconds((item as { EndTicks?: unknown }).EndTicks);
    if (start === null || end === null || end - start < 3) continue;
    out.push({ type: mapped, start, end });
  }
  // 同类多段（分集内多段 Intro 罕见但合法）：保留服务端顺序，跳过第一个命中即可。
  return out;
}

export interface SkipAction {
  type: 'intro' | 'outro';
  seekTo: number;
}

const EDGE_MARGIN = 0.5; // 已进入段尾 0.5s 内不再跳（避免 seek 打转）

/** 纯函数：给定分段与当前位置，返回应执行的跳过动作（或 null）。 */
export function resolveSkipAction(
  segments: SkipSegment[],
  position: number,
  duration: number | undefined
): SkipAction | null {
  for (const seg of segments) {
    if (seg.type === 'intro') {
      // resume 0 秒时第一次 time-pos 就在段内 → 立即跳到片头结束
      if (position >= seg.start && position < seg.end - EDGE_MARGIN) {
        return { type: 'intro', seekTo: seg.end };
      }
    } else {
      if (position >= seg.start && position < seg.end - EDGE_MARGIN) {
        // 片尾段贴近文件末尾 → 直接落到 duration-0.8s 触发自然 EOF
        //（保存先于连播倒计时的既有顺序不变）。
        const nearEnd = duration !== undefined && seg.end >= duration - 1.5;
        const seekTo = nearEnd ? Math.max(duration - 0.8, seg.start + 1) : seg.end - EDGE_MARGIN;
        return { type: 'outro', seekTo };
      }
    }
  }
  return null;
}

export type SkipEnabledFn = (type: 'intro' | 'outro') => boolean;

/**
 * 控制器：一次性触发 + 按 mediaId 存分段。LOAD_FILE 换媒体时调
 * begin(mediaId) 重置；time-pos 事件驱动 onTime。
 */
export class SkipController {
  private activeKey: string | null = null;
  private store = new Map<string, SkipSegment[]>();
  private fired = new Set<string>();

  constructor(
    private opts: {
      isEnabled: SkipEnabledFn;
      onSkip: (action: SkipAction) => void;
    }
  ) {}

  setSegments(mediaKey: string, segments: SkipSegment[]): void {
    if (segments.length === 0) return;
    // fetch 在 resolve 时已发起，LOAD_FILE 的 begin() 晚于网络完成——
    // 所以 begin 不清缓存，这里用最近容量剪枝（防累积）。
    this.store.set(mediaKey, segments);
    if (this.store.size > 8) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined && oldest !== this.activeKey) this.store.delete(oldest);
    }
  }

  /** 换媒体：切活动键并重置一次性标记（分段缓存保留，等异步 fetch 补齐）。 */
  begin(mediaKey: string | null): void {
    this.activeKey = mediaKey;
    this.fired.clear();
  }

  /** 返回命中的类型（供 OSD/测试断言）；无命中或已禁用返回 null。 */
  onTime(position: number, duration?: number): SkipAction | null {
    if (this.activeKey === null) return null;
    const segments = this.store.get(this.activeKey);
    if (!segments) return null;
    const action = resolveSkipAction(segments, position, duration);
    if (!action) return null;
    if (this.fired.has(action.type)) return null;
    if (!this.opts.isEnabled(action.type)) return null;
    this.fired.add(action.type);
    this.opts.onSkip(action);
    return action;
  }
}
