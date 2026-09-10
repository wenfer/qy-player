/**
 * Safe NFO parser (plan §9, QYP2-010).
 *
 * Hand-rolled bounded XML subset instead of a general-purpose parser: the
 * security requirements (no DTD, no external entities, no entity expansion,
 * depth/node caps) are satisfied by construction, and no new dependency is
 * added. Anything outside the subset is rejected, not guessed.
 *
 * Scope: read-only, Kodi-style NFO files (movie / tvshow / season /
 * episodedetails). External URLs in <thumb> are stored as references and
 * never fetched.
 */

import type { NfoActor, NfoMetadata, NfoUniqueId } from './types';

export const MAX_NFO_BYTES = 2 * 1024 * 1024; // 2 MiB (plan §9.1)
const MAX_DEPTH = 32;
const MAX_NODES = 50_000;
const MAX_TEXT_LENGTH = 1_000_000;

export class NfoParseError extends Error {
  constructor(message: string) {
    super(`NFO 解析失败: ${message}`);
    this.name = 'NfoParseError';
  }
}

// ---------------------------------------------------------------------------
// Encoding: BOM detection, UTF-8 / UTF-16LE / UTF-16BE, 2 MiB cap.
// ---------------------------------------------------------------------------

/** Decode a raw NFO buffer honoring BOM; UTF-16BE is byte-swapped to LE. */
export function decodeNfoBuffer(buffer: Buffer): string {
  if (buffer.length > MAX_NFO_BYTES) {
    throw new NfoParseError(`文件超过 ${MAX_NFO_BYTES} 字节大小上限`);
  }
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString('utf8');
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString('utf16le');
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const le = Buffer.from(buffer.subarray(2));
    le.swap16(); // BE → LE in place, then decode as LE
    return le.toString('utf16le');
  }
  return buffer.toString('utf8');
}

/** One-stop parse from raw bytes. */
export function parseNfo(buffer: Buffer): NfoMetadata {
  return parseNfoXml(decodeNfoBuffer(buffer));
}

// ---------------------------------------------------------------------------
// Entity decoding: only the 5 predefined entities and numeric references.
// Named unknown entities are rejected — no expansion, no external lookups.
// ---------------------------------------------------------------------------

function decodeEntities(raw: string): string {
  if (!raw.includes('&')) return raw;
  let out = '';
  let i = 0;
  while (i < raw.length) {
    const amp = raw.indexOf('&', i);
    if (amp === -1) {
      out += raw.slice(i);
      break;
    }
    out += raw.slice(i, amp);
    const semi = raw.indexOf(';', amp + 1);
    if (semi === -1) throw new NfoParseError('实体未闭合');
    const body = raw.slice(amp + 1, semi);
    if (body === 'amp') out += '&';
    else if (body === 'lt') out += '<';
    else if (body === 'gt') out += '>';
    else if (body === 'quot') out += '"';
    else if (body === 'apos') out += "'";
    else if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff || Number.isNaN(code)) {
        throw new NfoParseError('非法数字实体');
      }
      // Reject surrogates / control chars disguised as entities.
      if (code >= 0xd800 && code <= 0xdfff) throw new NfoParseError('非法数字实体（代理区）');
      out += String.fromCodePoint(code);
    } else {
      throw new NfoParseError(`未知实体 &${body};（已禁用自定义实体与 DTD）`);
    }
    i = semi + 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Bounded XML subset parser.
// ---------------------------------------------------------------------------

interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  /** Concatenated direct text (entities decoded, CDATA respected). */
  text: string;
}

interface ParserState {
  nodes: number;
}

const NAME_START = /[A-Za-z_]/;
const NAME_CHAR = /[A-Za-z0-9_.-]/;

/**
 * After the root element only whitespace, comments and processing
 * instructions are tolerated; anything else is a malformed document.
 */
function assertTrailingNoise(remaining: string): void {
  let i = 0;
  while (i < remaining.length) {
    const lt = remaining.indexOf('<', i);
    if (lt === -1) {
      if (remaining.slice(i).trim().length > 0) {
        throw new NfoParseError('根元素闭合后存在多余内容');
      }
      return;
    }
    if (remaining.slice(i, lt).trim().length > 0) {
      throw new NfoParseError('根元素闭合后存在多余内容');
    }
    if (remaining.startsWith('<!--', lt)) {
      const end = remaining.indexOf('-->', lt + 4);
      if (end === -1) throw new NfoParseError('根元素闭合后注释未闭合');
      i = end + 3;
    } else if (remaining.startsWith('<?', lt)) {
      const end = remaining.indexOf('?>', lt + 2);
      if (end === -1) throw new NfoParseError('根元素闭合后处理指令未闭合');
      i = end + 2;
    } else {
      throw new NfoParseError('根元素闭合后存在多余内容');
    }
  }
}

function parseAttributeNameValue(xml: string, pos: number): { name: string; value: string; next: number } {
  let i = pos;
  while (i < xml.length && /\s/.test(xml[i])) i += 1;
  const start = i;
  while (i < xml.length && NAME_CHAR.test(xml[i])) i += 1;
  if (i === start) throw new NfoParseError(`属性名缺失（位置 ${pos}）`);
  const name = xml.slice(start, i);
  while (i < xml.length && /\s/.test(xml[i])) i += 1;
  if (xml[i] !== '=') throw new NfoParseError(`属性缺少 =（位置 ${i}）`);
  i += 1;
  while (i < xml.length && /\s/.test(xml[i])) i += 1;
  const quote = xml[i];
  if (quote !== '"' && quote !== "'") throw new NfoParseError(`属性值缺少引号（位置 ${i}）`);
  const end = xml.indexOf(quote, i + 1);
  if (end === -1) throw new NfoParseError('属性值未闭合');
  return { name, value: decodeEntities(xml.slice(i + 1, end)), next: end + 1 };
}

/** Parse a start tag at `pos` (pointing at '<'); returns node + next index. */
function parseStartTag(xml: string, pos: number, state: ParserState): { node: XmlNode; next: number; selfClosing: boolean } {
  let i = pos + 1;
  if (!NAME_START.test(xml[i] ?? '')) {
    throw new NfoParseError(`非法标签名（位置 ${pos}）`);
  }
  let nameEnd = i + 1;
  while (nameEnd < xml.length && NAME_CHAR.test(xml[nameEnd])) nameEnd += 1;
  const name = xml.slice(i, nameEnd);
  state.nodes += 1;
  const node: XmlNode = { name, attrs: {}, children: [], text: '' };
  if (state.nodes > MAX_NODES) {
    throw new NfoParseError(`节点数超过上限 ${MAX_NODES}`);
  }
  i = nameEnd;
  // Attributes.
  for (;;) {
    while (i < xml.length && /\s/.test(xml[i])) i += 1;
    if (xml[i] === '>' ) return { node, next: i + 1, selfClosing: false };
    if (xml[i] === '/' && xml[i + 1] === '>') return { node, next: i + 2, selfClosing: true };
    const attr = parseAttributeNameValue(xml, i);
    node.attrs[attr.name] = attr.value;
    i = attr.next;
  }
}

/** Core tokenizer: builds the element tree under strict bounds. */
function buildTree(xml: string): XmlNode {
  const stack: XmlNode[] = [];
  let root: XmlNode | null = null;
  let i = 0;
  let textStart = 0;
  const state: ParserState = { nodes: 0 };

  const flushText = (upTo: number): void => {
    if (upTo > textStart) {
      const raw = xml.slice(textStart, upTo);
      const parent = stack[stack.length - 1];
      const decoded = decodeEntities(raw);
      if (parent) {
        parent.text = (parent.text + decoded).slice(0, MAX_TEXT_LENGTH);
      } else if (decoded.trim().length > 0) {
        throw new NfoParseError('根元素之外存在文本内容');
      }
    }
  };

  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    if (lt === -1) {
      flushText(xml.length);
      break;
    }
    flushText(lt);
    i = lt;
    if (xml.startsWith('<!--', i)) {
      const end = xml.indexOf('-->', i + 4);
      if (end === -1) throw new NfoParseError('注释未闭合');
      i = end + 3;
      textStart = i;
      continue;
    }
    if (xml.startsWith('<![CDATA[', i)) {
      const end = xml.indexOf(']]>', i + 9);
      if (end === -1) throw new NfoParseError('CDATA 未闭合');
      const parent = stack[stack.length - 1];
      if (!parent) throw new NfoParseError('CDATA 出现在根元素之外');
      parent.text = (parent.text + xml.slice(i + 9, end)).slice(0, MAX_TEXT_LENGTH);
      i = end + 3;
      textStart = i;
      continue;
    }
    if (xml.startsWith('<?', i)) {
      const end = xml.indexOf('?>', i + 2);
      if (end === -1) throw new NfoParseError('处理指令未闭合');
      i = end + 2;
      textStart = i;
      continue;
    }
    if (xml.startsWith('<!', i)) {
      // DOCTYPE / any other declaration: rejected outright.
      throw new NfoParseError('检测到 <!...> 声明（DOCTYPE 与 DTD 已禁用）');
    }
    if (xml.startsWith('</', i)) {
      const end = xml.indexOf('>', i + 2);
      if (end === -1) throw new NfoParseError('结束标签未闭合');
      const name = xml.slice(i + 2, end).trim();
      const top = stack.pop();
      if (!top || top.name !== name) {
        throw new NfoParseError(`结束标签 </${name}> 与 <${top?.name ?? '无'}> 不匹配`);
      }
      if (stack.length === 0) {
        root = top;
        assertTrailingNoise(xml.slice(end + 1));
        return root;
      }
      stack[stack.length - 1].children.push(top);
      i = end + 1;
      textStart = i;
      continue;
    }
    // Start tag.
    if (stack.length >= MAX_DEPTH) {
      throw new NfoParseError(`嵌套深度超过上限 ${MAX_DEPTH}`);
    }
    const parsed = parseStartTag(xml, i, state);
    if (parsed.selfClosing) {
      if (stack.length === 0) {
        root = parsed.node;
        assertTrailingNoise(xml.slice(parsed.next));
        return root;
      }
      stack[stack.length - 1].children.push(parsed.node);
    } else {
      stack.push(parsed.node);
    }
    i = parsed.next;
    textStart = i;
  }
  if (stack.length > 0) throw new NfoParseError('文档提前结束（存在未闭合标签）');
  throw new NfoParseError('未找到根元素');
}

// ---------------------------------------------------------------------------
// NFO field extraction.
// ---------------------------------------------------------------------------

const NFO_ROOT_KINDS: Record<string, NfoMetadata['kind']> = {
  movie: 'movie',
  tvshow: 'tvshow',
  season: 'season',
  episodedetails: 'episode',
};

function textOf(node: XmlNode, tag: string): string | undefined {
  for (const child of node.children) {
    if (child.name === tag) {
      const value = child.text.trim();
      if (value) return value;
    }
  }
  return undefined;
}

function textListOf(node: XmlNode, tag: string): string[] {
  const out: string[] = [];
  for (const child of node.children) {
    if (child.name === tag) {
      const value = child.text.trim();
      if (value) out.push(value);
    }
  }
  return out;
}

function intOf(node: XmlNode, tag: string): number | undefined {
  const raw = textOf(node, tag);
  if (raw === undefined) return undefined;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : undefined;
}

function floatOf(node: XmlNode, tag: string): number | undefined {
  const raw = textOf(node, tag);
  if (raw === undefined) return undefined;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : undefined;
}

function actorsOf(node: XmlNode): NfoActor[] {
  return node.children
    .filter((child) => child.name === 'actor')
    .map((actor) => ({
      name: textOf(actor, 'name') ?? '',
      ...(textOf(actor, 'role') ? { role: textOf(actor, 'role') } : {}),
      ...(textOf(actor, 'thumb') ? { thumb: textOf(actor, 'thumb') } : {}),
    }))
    .filter((actor) => actor.name);
}

function uniqueIdsOf(node: XmlNode): NfoUniqueId[] {
  return node.children
    .filter((child) => child.name === 'uniqueid')
    .map((uid) => ({
      provider: uid.attrs.type ?? '',
      id: uid.text.trim(),
      ...(uid.attrs.default === 'true' ? { isDefault: true } : {}),
    }))
    .filter((uid) => uid.provider && uid.id);
}

function setOf(node: XmlNode): string | undefined {
  const setNode = node.children.find((child) => child.name === 'set');
  if (!setNode) return textOf(node, 'set');
  // <set><name>X</name></set> is the Kodi form; <set>X</set> is tolerated.
  return textOf(setNode, 'name') ?? (setNode.text.trim() || undefined);
}

/** Parse NFO XML text into a normalized metadata payload. */
export function parseNfoXml(xml: string): NfoMetadata {
  if (xml.length > MAX_NFO_BYTES) {
    throw new NfoParseError(`内容超过 ${MAX_NFO_BYTES} 字节大小上限`);
  }
  const root = buildTree(xml);
  const kind = NFO_ROOT_KINDS[root.name];
  if (!kind) throw new NfoParseError(`未知根元素 <${root.name}>`);

  return {
    kind,
    ...(textOf(root, 'title') ? { title: textOf(root, 'title') } : {}),
    ...(textOf(root, 'originaltitle') ? { originalTitle: textOf(root, 'originaltitle') } : {}),
    ...(textOf(root, 'sorttitle') ? { sortTitle: textOf(root, 'sorttitle') } : {}),
    ...(intOf(root, 'year') !== undefined ? { year: intOf(root, 'year') } : {}),
    ...(textOf(root, 'premiered') ? { premiered: textOf(root, 'premiered') } : {}),
    ...(textOf(root, 'plot') ? { plot: textOf(root, 'plot') } : {}),
    ...(textOf(root, 'tagline') ? { tagline: textOf(root, 'tagline') } : {}),
    ...(intOf(root, 'runtime') !== undefined ? { runtime: intOf(root, 'runtime') } : {}),
    ...(floatOf(root, 'rating') !== undefined ? { rating: floatOf(root, 'rating') } : {}),
    // Kodi uses <mpaa>; some files use <contentrating>.
    ...(textOf(root, 'mpaa') ? { contentRating: textOf(root, 'mpaa') } : {}),
    ...(textOf(root, 'contentrating') ? { contentRating: textOf(root, 'contentrating') } : {}),
    genres: textListOf(root, 'genre'),
    studios: textListOf(root, 'studio'),
    countries: textListOf(root, 'country'),
    actors: actorsOf(root),
    directors: textListOf(root, 'director'),
    ...(intOf(root, 'season') !== undefined ? { season: intOf(root, 'season') } : {}),
    ...(intOf(root, 'episode') !== undefined ? { episode: intOf(root, 'episode') } : {}),
    uniqueIds: uniqueIdsOf(root),
    thumbs: textListOf(root, 'thumb'),
    ...(setOf(root) ? { set: setOf(root) } : {}),
  };
}

// ---------------------------------------------------------------------------
// Sidecar image discovery (poster/fanart/<name>), path logic only.
// ---------------------------------------------------------------------------

const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.tbn', '.webp'];

/**
 * Sidecar image candidates inside one directory listing (file names only).
 * Kodi conventions: `poster.*`, `fanart.*`, `<video-basename>-poster.*`,
 * `<video-basename>-fanart.*`, and `<video-basename>.*` itself.
 */
export function listSidecarCandidates(dirFileNames: ReadonlyArray<string>, videoBaseName: string): string[] {
  const out: string[] = [];
  const baseStem = videoBaseName.replace(/\.[^.]+$/, '');
  for (const name of dirFileNames) {
    const dot = name.lastIndexOf('.');
    if (dot === -1) continue;
    const ext = name.slice(dot).toLowerCase();
    if (!IMAGE_EXTENSIONS.includes(ext)) continue;
    const stem = name.slice(0, dot).toLowerCase();
    // poster/fanart per plan §9.1; banner/logo are the same sidecar
    // mechanism and cost nothing — QYP2-011's UI consumes them.
    if (stem === 'poster' || stem === 'fanart' || stem === 'banner' || stem === 'logo') {
      out.push(name);
      continue;
    }
    if (baseStem && (name.toLowerCase().startsWith(`${baseStem.toLowerCase()}-`))) {
      out.push(name);
      continue;
    }
    if (baseStem && name.toLowerCase() === `${baseStem.toLowerCase()}${ext}`) {
      out.push(name);
    }
  }
  return out;
}
