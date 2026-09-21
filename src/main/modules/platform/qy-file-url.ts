/**
 * qy-file:// 请求解析（QYP3-062）：从 `src/main/index.ts` 的协议 handler
 * 里抽出的纯函数，便于对 Windows 形态的 URL 做单测。
 *
 * Windows 风险：`qy-file` 是 standard scheme，Chromium 的 URL 规范化在
 * 盘符/空 host 场景可能引入额外的前导斜杠或 query 分隔——这里做防御性
 * 归一（剥前导斜杠、剥 ?/#、解码），**匹配语义与原实现一致**：
 * - covers：`covers/<name>`，name 限 `[\w.-]+`（目录穿越进不来）
 * - audio：`audio/<sourceId>/<encodedRelPath>`
 */

export type QyFileRequest =
  | { kind: 'covers'; name: string }
  | { kind: 'audio'; sourceId: number; relPath: string }
  | null;

export function parseQyFileUrl(url: string): QyFileRequest {
  let raw = url.replace(/^qy-file:\/\//, '');
  // standard scheme 规范化可能引入前导斜杠（空 host / 盘符场景）
  raw = raw.replace(/^\/+/, '');
  // fetch/规范化残留的 query 与 hash 不属于资源路径
  const cut = raw.search(/[?#]/);
  if (cut >= 0) raw = raw.slice(0, cut);

  const coversMatch = raw.match(/^covers\/([\w.-]+)$/);
  if (coversMatch) {
    return { kind: 'covers', name: coversMatch[1] };
  }

  const audioMatch = raw.match(/^audio\/(\d+)\/(.+)$/);
  if (audioMatch) {
    // 存储的相对路径永远以 / 分隔（local-source 契约）；历史渲染层若有
    // \ 形态，统一转回 / 再交给包含校验
    const relPath = decodeURIComponent(audioMatch[2]).replace(/\\/g, '/');
    if (!relPath) return null;
    return { kind: 'audio', sourceId: Number(audioMatch[1]), relPath };
  }
  return null;
}
