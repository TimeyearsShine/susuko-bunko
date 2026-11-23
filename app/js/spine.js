// 书脊：照着日本文库本书脊的结构排——顶上文库小标，竖排书名，卷号，作者，最下面文库名。
// 漫画单行本另有一套：白色书脊、顶上一道封面色的色带和品牌小标、大号彩色卷号、“原作 / 作画”两列、最下面出版社名。
// 文字大小都用书脊自己的宽高（容器单位 cqw / cqh）来算，所以 3D 书架上大小怎么变，比例都一样。
import { h } from './ui.js';
import { logoUrl, isWideMark } from './labels.js';

export const SPINE_RATIO = 7.1; // 书脊高 ÷ 宽（书 1 : 1.42，厚度是宽的 0.2）
const H = SPINE_RATIO * 100; // 书脊高度，单位 cqw（宽度的百分之一）
const GAP = 2.2 * SPINE_RATIO; // 各块之间的空隙（2.2cqh）

// 竖排时英文字母和数字的处理（照日文竖排习惯）：
// 1～3 位的数字横着挤进一格（纵中横），其余字母、数字一个个正着竖排，不再整串躺倒。
const RUN = /[0-9]{1,3}(?![0-9])|[A-Za-z0-9!?#&+.'’-]+/g;
export function vtext(str) {
  const s = String(str || ''), out = [];
  let last = 0;
  for (const m of s.matchAll(RUN)) {
    if (m.index > last) out.push(s.slice(last, m.index));
    const t = m[0];
    const tcy = /^[0-9]{1,3}$/.test(t) && !/[0-9]/.test(s[m.index - 1] || '');
    out.push(h(tcy ? 'span.v-tcy' : 'span.v-up', t));
    last = m.index + t.length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}
// 竖排占多少个字的高度：纵中横算一格，正立的字母约 0.8 格，空格半格
const vlen = (s) => {
  const str = String(s || '');
  let n = 0, last = 0;
  for (const m of str.matchAll(RUN)) {
    n += [...str.slice(last, m.index)].reduce((k, ch) => k + (ch === ' ' ? 0.5 : 1), 0);
    n += /^[0-9]{1,3}$/.test(m[0]) ? 1 : m[0].length * 0.8;
    last = m.index + m[0].length;
  }
  return n + [...str.slice(last)].reduce((k, ch) => k + (ch === ' ' ? 0.5 : 1), 0);
};
const isNum = (v) => /^\d+(\.\d+)?$/.test(v);
// 卷号：数字照旧横排大字；“安可短篇集”“SSS”这类短篇名竖排
function volEl(v, manga) {
  if (!v) return null;
  if (isNum(v)) return h('span.sp-vol' + (manga ? '.is-manga' : '') + (v.length > 2 ? '.is-long' : ''), v);
  return h('span.sp-vol.is-text' + (manga ? '.is-manga' : ''), { style: `--fs:${fitCol(vlen(v), 110, vlen(v) <= 3 ? 36 : manga ? 30 : 26).toFixed(1)}cqw` }, vtext(v));
}
const volH = (v) => (!v ? 0 : isNum(v) ? 48 : vlen(v) * fitCol(vlen(v), 110, vlen(v) <= 3 ? 36 : 26) * 1.06);

// 书名一定要排得下：在剩下的高度里，找出能把整个书名放进去的最大字号（可以分几列竖排）
function titleFit(len, room) {
  for (let fs = 58; fs >= 9; fs -= 0.5) {
    const perCol = Math.floor(room / (fs * 1.02));
    if (perCol < 1) continue;
    const cols = Math.ceil(len / perCol);
    if (cols * fs * 1.1 <= 90) return fs;
  }
  return 9;
}
// 一列竖排的小字：按字数缩小，保证排得下
const fitCol = (len, room, max) => Math.min(max, room / Math.max(1, len * 1.06));

/**
 * spec: { title, volume, author, label, publisher, reading }
 * 返回 { el }。el 带 .sp 类，外面再决定它是 3D 书的侧面还是预览。
 */
export function buildSpine(spec, cls = '') {
  if (spec.kind === 'manga' || spec.label?.manga) return buildMangaSpine(spec, cls);
  const L = spec.label;
  const layout = L?.layout || 'plain';
  const logo = L && logoUrl(L);
  const v = spec.volume != null && spec.volume !== '' ? String(spec.volume) : '';
  const authorText = (spec.author || '').split(/[、,，]/)[0].trim();
  const imprintText = (L?.short || L?.name || spec.publisher || '').replace(/（.*?）/g, '');
  const companyText = L && layout === 'gagaga' && L.company !== imprintText ? L.company : '';

  // 先把书名以外的部分量好，剩下的高度都给书名
  const aFs = authorText ? fitCol(vlen(authorText), 120, 26) : 0;
  const iFs = imprintText ? fitCol(vlen(imprintText), 84, 17) : 0;
  const cFs = companyText ? fitCol(vlen(companyText), 56, 13) : 0;
  const markH = !L ? 36 : !logo ? Math.min(100, vlen(L.short || L.name) * 21 + 16) : { square: 78, wide: 43, light: 57 }[L.mark] || 78;
  const used = [
    layout === 'fantasia' ? 14 + 74 : layout === 'legacy' ? 64 + 21 : markH, // 顶上的小标（Fantasia 的圆标在中间）
    volH(v),
    authorText ? vlen(authorText) * aFs * 1.06 : 0,
    imprintText ? vlen(imprintText) * iFs * 1.12 + 22 : 0,
    companyText ? vlen(companyText) * cFs + 4 : 0,
  ];
  const items = used.filter(Boolean).length + 1;
  const room = H - used.reduce((a, b) => a + b, 0) - GAP * (items + 1) - 24;
  const title = h('span.sp-title', { style: `--fs:${titleFit(vlen(spec.title), Math.max(80, room)).toFixed(1)}cqw` }, vtext(spec.title));
  const vol = volEl(v, false);
  const author = authorText && h('span.sp-author', { style: `--fs:${aFs.toFixed(1)}cqw` }, vtext(authorText));
  const mark = (big) => (logo
    ? h('span.sp-mark.is-' + (L.mark || 'square') + (big ? '.is-big' : ''), h('img', { src: logo, alt: L.name, draggable: false, loading: 'lazy' }))
    : L && h('span.sp-mark.is-text', { style: `--fs:${fitCol(vlen(L.short || L.name), 84, 20).toFixed(1)}cqw` }, vtext(L.short || L.name)));
  const nameBox = imprintText && h('span.sp-imprint', { style: `--fs:${iFs.toFixed(1)}cqw` }, vtext(imprintText));
  const company = companyText && h('span.sp-company', { style: `--fs:${cFs.toFixed(1)}cqw` }, vtext(companyText));

  let parts;
  if (layout === 'gagaga') parts = [mark(), title, vol, author, h('span.sp-gap'), company, nameBox];
  else if (layout === 'fantasia') parts = [h('span.sp-pad'), title, vol, mark(true), author, h('span.sp-gap'), nameBox];
  else if (layout === 'plain') parts = [h('span.sp-band'), title, vol, author, h('span.sp-gap'), nameBox];
  else parts = [mark(), title, vol, author, h('span.sp-gap'), nameBox];
  const el = h('div.sp' + (cls ? '.' + cls : '') + '.is-' + layout, h('div.sp-in', parts.filter(Boolean)), spec.reading && h('span.sp-ribbon'));
  return { el };
}

/** 在书脊真正显示出来以后量一次：找出能把整个书名排进去的最大字号。
 *  字号用的是书脊宽度的百分比，所以量一次以后书架怎么缩放都不用再量。 */
export function fitSpine(el) {
  const inner = el.querySelector('.sp-in'), title = el.querySelector('.sp-title');
  if (!inner || !title || !el.clientHeight || el.dataset.fitted) return;
  // .sp-in 固定按 80px 宽排版（再整体缩放），所以这里量到的尺寸和书脊实际大小无关
  const fits = (fs) => {
    title.style.setProperty('--fs', `${fs}cqw`);
    return inner.scrollHeight <= inner.clientHeight + 1 && title.scrollWidth <= inner.clientWidth * 0.94 && title.scrollHeight <= title.clientHeight + 1;
  };
  let lo = 6, hi = 58;
  if (fits(hi)) lo = hi;
  else {
    for (let k = 0; k < 9; k++) { const mid = (lo + hi) / 2; if (fits(mid)) lo = mid; else hi = mid; }
  }
  title.style.setProperty('--fs', `${lo.toFixed(1)}cqw`);
  el.dataset.fitted = '1';
}

/** 漫画单行本的书脊 */
function buildMangaSpine(spec, cls) {
  const L = spec.label;
  const layout = L?.layout || 'manga';
  const logo = L && logoUrl(L, spec.mark);
  const wide = L && isWideMark(L, spec.mark);
  const v = spec.volume != null && spec.volume !== '' ? String(spec.volume) : '';
  const first = (t) => (t || '').split(/[、,，]/)[0].trim();
  const author = first(spec.author), artist = first(spec.illustrator);
  // 原作和作画是不同的人就排成两列（右边原作、左边作画），否则只写作者
  const creators = artist && artist !== author ? [['原作', author], ['作画', artist]].filter(([, n]) => n) : author ? [['', author]] : [];
  const company = L?.company || spec.publisher || '';
  const brand = L ? L.name.replace(/（.*?）/g, '') : '';

  const cFs = creators.length ? Math.min(...creators.map(([k, n]) => fitCol(vlen(n) + (k ? 2.6 : 0), 150, creators.length > 1 ? 24 : 28))) : 0;
  const mark = L && (logo
    ? h('span.sp-mark.is-manga' + (wide ? '.is-wide' : ''), h('img', { src: logo, alt: brand, draggable: false, loading: 'lazy' }))
    : h('span.sp-mark.is-text.is-manga', { style: `--fs:${fitCol(vlen(brand), 90, 18).toFixed(1)}cqw` }, vtext(brand)));
  const title = h('span.sp-title', { style: '--fs:40cqw' }, vtext(spec.title));
  const vol = volEl(v, true);
  const people = creators.length > 0 && h('span.sp-creators', { style: `--fs:${cFs.toFixed(1)}cqw` },
    creators.map(([k, n]) => h('span.sp-creator', k && h('small', k), vtext(n))));
  const bottom = company && h('span.sp-company.is-manga', { style: `--fs:${fitCol(vlen(company), 70, 15).toFixed(1)}cqw` }, vtext(company));
  const parts = [h('span.sp-cap'), mark || h('span.sp-pad'), title, vol, people, h('span.sp-gap'), bottom];
  const el = h('div.sp.is-manga' + (cls ? '.' + cls : '') + '.is-' + layout, h('div.sp-in', parts.filter(Boolean)), spec.reading && h('span.sp-ribbon'));
  return { el };
}

