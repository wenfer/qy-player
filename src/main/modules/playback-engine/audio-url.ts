/**
 * qy-file://audio 协议的来源解析桥（QYP3-010，ADR-0007）。
 *
 * 主进程 index.ts 注册协议时需要一个「sourceId → 包含校验的本地适配器」
 * 解析器；实际来源表在 ipc/index.ts 里初始化，这里用注册函数解耦，
 * 避免主进程入口与 IPC 模块循环依赖。
 *
 * 安全面：只接受 local 来源；containment 由 LocalSourceAdapter.
 * resolveInside 提供（字符串级 + realpath TOCTOU 双层，QYP2-009）。
 * WebDAV/服务器音频不走 renderer 引擎（ADR-0007），永不在此解析。
 */

export interface ProtocolSource {
  kind: string;
  resolveInside: (relativePath: string) => string;
}

let provider: ((sourceId: number) => ProtocolSource | undefined) | null = null;

export function registerAudioSourceProvider(
  fn: (sourceId: number) => ProtocolSource | undefined
): void {
  provider = fn;
}

/** 协议处理器调用；返回绝对路径或 undefined（拒绝）。 */
export function resolveAudioUrlSource(sourceId: number, relativePath: string): string | undefined {
  if (!provider) return undefined;
  let source: ProtocolSource | undefined;
  try {
    source = provider(sourceId);
  } catch {
    return undefined;
  }
  if (!source || source.kind !== 'local') return undefined;
  try {
    return source.resolveInside(relativePath);
  } catch {
    return undefined;
  }
}
