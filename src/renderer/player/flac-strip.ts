/**
 * 剥离 FLAC 内嵌封面（METADATA_BLOCK_PICTURE，type=6）以救被 Chromium
 * 拒绝解码的非法封面块（如 picture.type=-1 / 0xFFFFFFFF）。
 *
 * 背景（QYP3-033）：某些 FLAC 的封面块本身损坏，Chromium 的 ffmpeg demuxer
 * 会整个文件 DEMUXER_ERROR_COULD_NOT_OPEN，导致本地 FLAC 走不了内置引擎
 * （Web Audio）——既无真频谱/真波形，又会被兜底到 mpv 弹黑窗。mpv 0.32 对
 * 同样的块只 warning，所以剥离封面后 Web Audio 就能正常解码。
 *
 * 关键：只移除 type=6 的封面块，STREAMINFO 与其余元数据、音频帧原样保留，
 * 无损。封面展示走 `covers` 缓存分区（`qy-file://covers/<trackId>.*`），
 * 与播放流里内嵌的封面无关，剥离不影响封面显示。
 */

/** 本地 webaudio 音轨的播放 URL 才是可剥离对象（WebDAV/服务器走 mpv）。 */
export function isLocalFlacUrl(url: string): boolean {
  if (!url.startsWith('qy-file://audio/')) return false;
  const last = url.split('/').pop() ?? '';
  let name = last;
  try {
    name = decodeURIComponent(last);
  } catch {
    // 解码失败用原始串（含 % 也无妨，结尾判定仍可靠）
  }
  return name.toLowerCase().endsWith('.flac');
}

/**
 * 纯函数：从 FLAC 字节中剥离所有 PICTURE(type=6) 元数据块。
 * 无可剥离封面 / 解析失败返回 null（调用方据此不重封装、走原兜底）。
 */
export function stripFlacPictureBytes(input: Uint8Array): Uint8Array | null {
  // 'fLaC' magic
  if (
    input.length < 4 ||
    input[0] !== 0x66 ||
    input[1] !== 0x4c ||
    input[2] !== 0x61 ||
    input[3] !== 0x43
  ) {
    return null;
  }
  const blocks: Uint8Array[] = [];
  let offset = 4;
  let removed = false;
  while (offset + 4 <= input.length) {
    const header = input[offset];
    const last = (header & 0x80) !== 0;
    const type = header & 0x7f;
    const length =
      (input[offset + 1] << 16) | (input[offset + 2] << 8) | input[offset + 3];
    const blockEnd = offset + 4 + length;
    if (blockEnd > input.length) return null; // 长度越界 → 损坏，放弃重封装
    if (type === 6) {
      removed = true; // 丢弃内嵌封面
    } else {
      // 保留块（含原 header；末块标志稍后统一重算）
      blocks.push(input.subarray(offset, blockEnd));
    }
    offset = blockEnd;
    if (last) break;
  }
  if (!removed) return null; // 没有可剥离的封面 → 不重封装
  const audioFrames = input.subarray(offset);
  const total = 4 + blocks.reduce((s, b) => s + b.length, 0) + audioFrames.length;
  const out = new Uint8Array(total);
  out[0] = 0x66;
  out[1] = 0x4c;
  out[2] = 0x61;
  out[3] = 0x43;
  let pos = 4;
  blocks.forEach((b, i) => {
    // 清除末块位，仅在最后一块置位（数组视图直接改底层 buffer，随后拷进 out）
    const h = b[0] & 0x7f;
    b[0] = i === blocks.length - 1 ? (h | 0x80) : h;
    out.set(b, pos);
    pos += b.length;
  });
  out.set(audioFrames, pos);
  return out;
}

/**
 * 拉取本地 FLAC → 剥离封面 → 返回 blob URL（可直接作 `<audio>.src`）。
 * 任何失败（网络/解析/无可剥离）返回 null。
 */
export function stripFlacPicture(flacUrl: string): Promise<string | null> {
  return fetch(flacUrl)
    .then((res) => (res.ok ? res.arrayBuffer() : null))
    .then((buf) => {
      if (!buf) return null;
      const out = stripFlacPictureBytes(new Uint8Array(buf));
      if (!out) return null;
      return URL.createObjectURL(new Blob([out], { type: 'audio/flac' }));
    })
    .catch(() => null);
}
