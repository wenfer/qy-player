/**
 * mpv af 热更新的"什么时候真的发给 mpv"决策（QYP3-068v）。
 *
 * 为什么需要它：mpv 每改一次 `af` 都会**重建整条滤镜链并 flush 缓冲**，拖动
 * 滑块时每秒几十次就是连续爆音。所以两条规则必须同时成立：
 *   ① 链字符串没变 → 一条命令都不发（省掉无谓重建）；
 *   ② 变了 → 等 `debounceMs` 的静默期再发（trailing 防抖）。
 *
 * 代价是 mpv 引擎下效果实际是"松手生效"，UI 上如实标注（renderer 内置引擎
 * 不走这里，它直接改 AudioParam，是真实的实时）。
 *
 * 抽成独立单元是因为这段状态机有两条**很隐蔽的错误分支**，而它们原先埋在
 * `ipc/index.ts` 的 handler 闭包里根本没法写用例：
 *   - "相同就返回"时若**不撤销待发请求**，用户拖到 A 又拖回 B（B = 当前已生效
 *     的链）之后，120ms 前排队的那条 A 仍会落地 → 界面显示 B、mpv 却是 A；
 *   - 判定必须拿"已生效的链"而不是"最近一次请求的链"做基准，否则连拖两下
 *     同一档位会被误判成"没变"。
 *
 * 不变式：`current` = **本模块已经下发给 mpv 的那条链**（null = 本次会话还没
 * 下发过，或被 `reset()` 清空）。任何绕过 `request`/`applyNow` 直接改 mpv
 * `af` 的地方（如切视频时清链），都必须跟一次 `reset()`——否则残留的
 * `current` 会让之后的"请求同一条链"被误判成没变。
 */

export type AfRequestResult =
  /** 与已生效的链一致：没发命令，且已撤销待发请求。 */
  | 'unchanged'
  /** 已排队，`debounceMs` 后应用（期间再来一条会顶掉它）。 */
  | 'debounced';

export interface AfHotUpdate {
  /** 立即应用并记为当前值（loadfile 用：起播不能等防抖）。 */
  applyNow(chain: string): void;
  /** 会话中改音效：与当前值相同则忽略，不同则防抖后应用。 */
  request(chain: string): AfRequestResult;
  /**
   * 撤销待发请求并**忘掉已生效的值**（切视频时 mpv 的 af 被清成空链，
   * 两边必须一起归零；留着旧值会让之后的"请求同一条链"被误判成没变）。
   */
  reset(): void;
}

export function createAfHotUpdate(debounceMs: number, apply: (chain: string) => void): AfHotUpdate {
  /** 已经真正应用到 mpv 的那条链（null = 本会话还没设过）。 */
  let current: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const dropPending = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return {
    applyNow(chain: string): void {
      dropPending();
      current = chain;
      apply(chain);
    },

    request(chain: string): AfRequestResult {
      if (chain === current) {
        // 回到"当前已生效的那条"→ 排队的请求已经过期，必须撤掉
        dropPending();
        return 'unchanged';
      }
      dropPending();
      timer = setTimeout(() => {
        timer = null;
        current = chain;
        apply(chain);
      }, debounceMs);
      return 'debounced';
    },

    reset(): void {
      dropPending();
      current = null;
    },
  };
}
