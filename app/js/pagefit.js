// 漫画扫图的“版面”识别：
// · 封面是整张书衣（封底 + 书脊 + 封面，常常还带两侧折口）时，只裁出正面；
// · 内页是两页拼在一张图里的跨页扫图时，拆成两页（日漫先右后左）。
// 版面记成一串字符，一页一个：p 普通单页，w 两页拼在一起，c 整张书衣（只会出现在第一页）。

const WRAP_RATIO = 1.2;   // 第一页宽高比超过这个，就当成整张书衣
const SPREAD_RATIO = 1.05; // 内页宽高比超过这个，就当成两页拼图

/** 只读图片文件头拿宽高（JPEG / PNG / WebP / GIF / BMP），读不出返回 null */
export function sizeFromHead(b) {
  if (!b || b.length < 24) return null;
  const u16 = (o) => (b[o] << 8) | b[o + 1], le16 = (o) => b[o] | (b[o + 1] << 8);
  const le32 = (o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  if (b[0] === 0x89 && b[1] === 0x50) return { w: (u16(16) << 16) | u16(18), h: (u16(20) << 16) | u16(22) };
  if (b[0] === 0x47 && b[1] === 0x49) return { w: le16(6), h: le16(8) };
  if (b[0] === 0x42 && b[1] === 0x4d) return { w: le32(18), h: Math.abs(le32(22) | 0) };
  if (b[0] === 0x52 && b[8] === 0x57 && b[9] === 0x45) { // RIFF....WEBP
    const tag = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (tag === 'VP8 ') return { w: le16(26) & 0x3fff, h: le16(28) & 0x3fff };
    if (tag === 'VP8L') { const v = le32(21); return { w: (v & 0x3fff) + 1, h: ((v >> 14) & 0x3fff) + 1 }; }
    if (tag === 'VP8X') return { w: (b[24] | (b[25] << 8) | (b[26] << 16)) + 1, h: (b[27] | (b[28] << 8) | (b[29] << 16)) + 1 };
    return null;
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let o = 2;
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) { o++; continue; }
      const m = b[o + 1];
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7) || m === 0xff) { o += m === 0xff ? 1 : 2; continue; }
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { w: u16(o + 7), h: u16(o + 5) };
      o += 2 + u16(o + 2);
    }
  }
  return null;
}

/** 根据每页宽高算出版面串 */
export function layoutOf(sizes) {
  return sizes.map((s, i) => {
    if (!s || !s.w || !s.h) return 'p';
    const r = s.w / s.h;
    if (i === 0) return r > WRAP_RATIO ? 'c' : 'p';
    return r > SPREAD_RATIO ? 'w' : 'p';
  }).join('');
}

/** 读出整本的版面：zip 要有 head(entry)（只取文件开头几 KB） */
export async function probeLayout(zip, entries, onStep) {
  const sizes = [];
  for (let i = 0; i < entries.length; i++) {
    let s = null;
    try { s = sizeFromHead(await zip.head(entries[i])); } catch { /* 读不出当单页 */ }
    sizes.push(s);
    if (onStep && i % 20 === 0) onStep(i, entries.length);
  }
  return layoutOf(sizes);
}

/**
 * 整张书衣里正面的位置（像素矩形）。rtl：从右往左读的书（日漫、繁中漫画）正面在左半边。
 * 做法：书脊在正中，先在中间一带找书脊两侧的竖直分界线；找不到就按书脊约占 5% 算。
 * 正面宽度取“半边减去书脊”和“按常见开本 0.72 宽高比”中较小的那个，这样两侧带折口的扫图也能裁对。
 */
export function frontRect(bmp, rtl = true) {
  const W = bmp.width, H = bmp.height;
  let half = W * 0.025;
  try {
    const sw = Math.min(600, W), sh = Math.max(1, Math.round(H * sw / W));
    const cv = new OffscreenCanvas(sw, sh);
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0, sw, sh);
    const px = ctx.getImageData(0, 0, sw, sh).data;
    const lum = (x, y) => { const i = (y * sw + x) * 4; return px[i] * 0.3 + px[i + 1] * 0.59 + px[i + 2] * 0.11; };
    // 每一列：上下有多少行在这里出现明显的左右明暗跳变（真正的分界线会贯穿大半个高度）
    const score = new Float32Array(sw);
    for (let x = 2; x < sw - 2; x++) {
      let n = 0;
      for (let y = 0; y < sh; y += 2) if (Math.abs(lum(x + 1, y) - lum(x - 2, y)) > 22) n++;
      score[x] = n / Math.ceil(sh / 2);
    }
    const c = sw / 2, lo = Math.round(sw * 0.008), hi = Math.round(sw * 0.07);
    const peak = (dir) => {
      let best = 0, at = -1;
      for (let d = lo; d <= hi; d++) { const x = Math.round(c + dir * d); if (score[x] > best) { best = score[x]; at = d; } }
      return { best, at };
    };
    const band = [...score.slice(Math.round(sw * 0.3), Math.round(sw * 0.7))].sort((a, b) => a - b);
    const median = band[band.length >> 1] || 0;
    const L = peak(-1), R = peak(1);
    // 两侧都要有一条比周围明显得多的线，否则当没找到
    if (L.at > 0 && R.at > 0 && L.best > Math.max(0.25, median * 2.5) && R.best > Math.max(0.25, median * 2.5) && Math.abs(L.at - R.at) < sw * 0.02) {
      half = Math.max(L.at, R.at) * (W / sw) + W * 0.003;
    }
  } catch { /* 用默认值 */ }
  const inner = Math.max(1, Math.round(W / 2 - half));
  const w = Math.min(inner, Math.round(H * 0.72));
  return rtl ? { x: inner - w, y: 0, w, h: H } : { x: W - inner, y: 0, w, h: H };
}

/** 跨页拼图的半边：side 'R' 右半，'L' 左半 */
export const halfRect = (bmp, side) => {
  const m = Math.floor(bmp.width / 2);
  return side === 'L' ? { x: 0, y: 0, w: m, h: bmp.height } : { x: m, y: 0, w: bmp.width - m, h: bmp.height };
};

/** 把一张图裁成矩形，返回新 Blob（JPEG 质量 0.95，肉眼看不出差别，比 PNG 小很多） */
export async function cropBlob(blob, rectOf, type = 'image/jpeg') {
  const bmp = await createImageBitmap(blob);
  try {
    const r = rectOf(bmp);
    const cv = new OffscreenCanvas(r.w, r.h);
    cv.getContext('2d').drawImage(bmp, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
    return await cv.convertToBlob({ type, quality: 0.95 });
  } finally { bmp.close?.(); }
}
