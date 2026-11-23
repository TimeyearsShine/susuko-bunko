// 极简 ZIP 读取器：按需从 Blob 里解出单个文件，不整包载入内存。
// 支持 stored(0) 与 deflate(8)，够用于 EPUB / CBZ。

const u16 = (v, o) => v.getUint16(o, true);
const u32 = (v, o) => v.getUint32(o, true);

function decodeName(bytes, utf8Flag) {
  if (utf8Flag) return new TextDecoder('utf-8').decode(bytes);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { /* 非 UTF-8 */ }
  for (const enc of ['gbk', 'shift_jis']) {
    try { return new TextDecoder(enc, { fatal: true }).decode(bytes); } catch { /* 换下一个 */ }
  }
  return new TextDecoder('utf-8').decode(bytes);
}

/** 数据源：{ size, read(start, end) -> Promise<ArrayBuffer> }。Blob 会被自动包一层。 */
export const blobSource = (blob) => ({ size: blob.size, read: (start, end) => blob.slice(start, end).arrayBuffer() });

export class ZipReader {
  constructor(source) { this.src = source; this.entries = []; this.byName = new Map(); }

  static async open(blobOrSource) {
    const z = new ZipReader(typeof blobOrSource.read === 'function' ? blobOrSource : blobSource(blobOrSource));
    await z._readDirectory();
    return z;
  }

  async _slice(start, end) {
    return new DataView(await this.src.read(start, end));
  }

  async _readDirectory() {
    const size = this.src.size;
    const tailLen = Math.min(size, 65557);
    const tail = await this._slice(size - tailLen, size);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) {
      if (u32(tail, i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('不是有效的 ZIP 文件');
    const count = u16(tail, eocd + 10);
    const cdSize = u32(tail, eocd + 12);
    const cdOffset = u32(tail, eocd + 16);
    if (cdOffset === 0xffffffff) throw new Error('暂不支持超过 4GB 的 ZIP64 文件');

    const cd = await this._slice(cdOffset, cdOffset + cdSize);
    const raw = new Uint8Array(cd.buffer);
    let p = 0;
    for (let i = 0; i < count && p + 46 <= cd.byteLength; i++) {
      if (u32(cd, p) !== 0x02014b50) break;
      const flags = u16(cd, p + 8);
      const nameLen = u16(cd, p + 28), extraLen = u16(cd, p + 30), commentLen = u16(cd, p + 32);
      const name = decodeName(raw.subarray(p + 46, p + 46 + nameLen), !!(flags & 0x800));
      const entry = {
        name, method: u16(cd, p + 10), compSize: u32(cd, p + 20), size: u32(cd, p + 24),
        offset: u32(cd, p + 42), isDir: name.endsWith('/'), encrypted: !!(flags & 1),
      };
      this.entries.push(entry);
      this.byName.set(name, entry);
      p += 46 + nameLen + extraLen + commentLen;
    }
  }

  get(name) { return this.byName.get(name) || null; }

  async bytes(entryOrName) {
    const e = typeof entryOrName === 'string' ? this.get(entryOrName) : entryOrName;
    if (!e) throw new Error(`压缩包内找不到 ${entryOrName}`);
    if (e.encrypted) throw new Error('不支持加密的压缩包');
    const head = await this._slice(e.offset, e.offset + 30);
    if (u32(head, 0) !== 0x04034b50) throw new Error('ZIP 文件损坏');
    const start = e.offset + 30 + u16(head, 26) + u16(head, 28);
    const data = await this.src.read(start, start + e.compSize);
    if (e.method === 0) return new Uint8Array(data);
    if (e.method !== 8) throw new Error(`不支持的压缩方式 ${e.method}`);
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  /** 只取文件开头约 n 字节（读图片宽高用），不解整份文件 */
  async head(entryOrName, n = 16384) {
    const e = typeof entryOrName === 'string' ? this.get(entryOrName) : entryOrName;
    if (!e || e.encrypted) return null;
    const buf = await this.src.read(e.offset, Math.min(this.src.size, e.offset + 30 + 1024 + n));
    const v = new DataView(buf);
    if (v.byteLength < 30 || u32(v, 0) !== 0x04034b50) return null;
    const skip = 30 + u16(v, 26) + u16(v, 28);
    const data = new Uint8Array(buf, Math.min(skip, buf.byteLength), Math.max(0, Math.min(e.compSize, buf.byteLength - skip)));
    if (e.method === 0) return data.slice(0, n);
    if (e.method !== 8) return null;
    // 只解前面一截：数据不完整，流最后会报错，报错前已经解出来的部分照样能用
    const out = [];
    let got = 0;
    try {
      const reader = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
      while (got < n) {
        const { value, done } = await reader.read();
        if (done) break;
        out.push(value); got += value.length;
      }
      reader.cancel().catch(() => {});
    } catch { /* 截断的流 */ }
    const all = new Uint8Array(got);
    let o = 0;
    for (const c of out) { all.set(c, o); o += c.length; }
    return all;
  }

  async text(entryOrName) {
    const b = await this.bytes(entryOrName);
    // 少数老书是 UTF-16
    if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b);
    if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b);
    return new TextDecoder('utf-8').decode(b);
  }

  async blobOf(entryOrName, type = '') {
    return new Blob([await this.bytes(entryOrName)], { type });
  }
}

const IMAGE_TYPES = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml',
};
export function mimeOf(name) {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  return IMAGE_TYPES[ext] || {
    css: 'text/css', ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2',
    xhtml: 'application/xhtml+xml', html: 'text/html', htm: 'text/html',
  }[ext] || 'application/octet-stream';
}
export const isImageName = (name) => /\.(jpe?g|png|gif|webp|avif|bmp)$/i.test(name) && !/(^|\/)(__MACOSX\/|\._)/.test(name);
