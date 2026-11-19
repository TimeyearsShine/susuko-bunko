// EPUB 阅读器。横排可左右翻页（CSS 多栏分页，宽屏双页）或上下滚动；竖排为从右往左翻页。
// 长按文字可以选字：复制、划线、批注、查词、翻译、朗读。也可以从当前页开始听书。
import { routeChip } from './cloud-direct.js';
import { createCurl } from './pagecurl.js';
import { Epub } from './epub.js';
import { prefs, setProgress, saveMark, removeMark, marksOf, onChange, touchActivity } from './store.js';
import { h, icon, toast, dialog, menuButton, imageViewer, statusClock, fmtPercent } from './ui.js';
import * as ai from './ai.js';

// 纸张纹理：细颗粒 + 横向的纸纤维（SVG 噪点），浅色纸和深色纸各一套
const GRAIN = (r, g, b, a1, a2) => [
  `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='240' height='240'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='3' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 ${r} 0 0 0 0 ${g} 0 0 0 0 ${b} 0 0 0 ${a1} 0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`,
  `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='600' height='600'%3E%3Cfilter id='f'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.012 .18' numOctaves='2' seed='7'/%3E%3CfeColorMatrix values='0 0 0 0 ${r} 0 0 0 0 ${g} 0 0 0 0 ${b} 0 0 0 ${a2} 0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23f)'/%3E%3C/svg%3E")`,
].join(',');
export const GRAIN_LIGHT = GRAIN(0.42, 0.36, 0.27, 0.22, 0.12);
export const GRAIN_DARK = GRAIN(1, 1, 1, 0.05, 0.03);

export const PAPERS = {
  white: { name: '奶白', bg: '#FBFAF5', fg: '#22252E', accent: '#C2255C', dark: false },
  paper: { name: '羊皮纸', bg: '#F3EAD6', fg: '#3A3226', accent: '#A8324F', dark: false },
  moss: { name: '浅苔', bg: '#E3EDE1', fg: '#26302A', accent: '#B02A5B', dark: false },
  night: { name: '夜读', bg: '#15171C', fg: '#B9BFCC', accent: '#F283A8', dark: true },
};
export const HL_COLORS = { blue: '#7FB3E6', pink: '#F49AB5', yellow: '#F2CF5B', green: '#8FD19E' };
const HL_NAMES = { blue: '蓝', pink: '粉', yellow: '黄', green: '绿' };
const FONTS = {
  book: { name: '原书', css: null },
  hei: { name: '黑体', css: '"PingFang SC","HarmonyOS Sans SC","Microsoft YaHei UI","Microsoft YaHei","Noto Sans CJK SC","Noto Sans SC",sans-serif' },
  ming: { name: '宋体', css: '"Source Han Serif SC","Noto Serif CJK SC","Noto Serif SC","Songti SC","Yu Mincho","SimSun",serif' },
};
const DEFAULTS = {
  fontSize: 18, lineHeight: 1.8, marginPx: 24, para: 0, font: 'book', paper: 'auto',
  spread: true, flow: 'paged', writing: 'h', turn: 'rise', volumeKeys: true, hlColor: 'blue',
  hlStyle: 'line', tapMode: 'lr', turnSpeed: 1, selUnit: 'word', autoSec: 30, book: false,
};
export function readerSettings() {
  const saved = prefs.get('reader', {});
  const s = { ...DEFAULTS, ...saved };
  if (saved.marginPx == null && saved.margin != null) s.marginPx = [14, 24, 38][saved.margin] ?? 24; // 旧版的三档页边距
  if ((saved.animV || 0) < 2) { if (!saved.turn || saved.turn === 'float') s.turn = 'rise'; s.animV = 2; } // 0.7 起默认“逐段浮现”
  if (saved.haptic == null) s.haptic = !!window.matchMedia?.('(pointer: coarse)').matches; // 手机、平板默认翻页轻震
  if (!['line', 'wave', 'marker'].includes(s.hlStyle)) s.hlStyle = 'line';
  if (s.paper !== 'auto' && !PAPERS[s.paper]) s.paper = 'white';
  if (!HL_COLORS[s.hlColor]) s.hlColor = 'blue';
  return s;
}
const SVG_NS = 'http://www.w3.org/2000/svg';
const TEXT_SKIP = 'rt, rp, .shiori-nav, style, script, title';

export async function open({ host, book, title = book.title, source, progress, onExit, flash }) {
  const epub = await Epub.open(source);
  const settings = readerSettings();
  let index = 0, page = 0, pages = 1, W = 0, H = 0, loadToken = 0, destroyed = false, busy = false;
  let spreadCols = 1, layoutGen = 0;
  const isVertical = () => settings.writing === 'v';
  const isScroll = () => settings.flow === 'scroll' && !isVertical();
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const turnStyle = () => (calm ? 'none' : settings.turn === 'curl' && (isVertical() || isScroll()) ? 'slide' : settings.turn);
  const paper = () => {
    if (settings.paper === 'auto') return document.documentElement.dataset.theme === 'dark' ? PAPERS.night : PAPERS.white;
    return PAPERS[settings.paper] || PAPERS.white;
  };

  // ---------- 结构 ----------
  const frame = h('iframe.reader-frame', { sandbox: 'allow-same-origin', title, tabIndex: -1 });
  // 仿真翻页用的“幽灵页”：和书页内容一样，翻页时显示正在翻起来的那张纸
  const ghost = h('iframe.reader-frame.reader-ghost', { sandbox: 'allow-same-origin', tabIndex: -1, 'aria-hidden': 'true', title: '' });
  // 双页时翻起来那张纸的背面（就是下一页），单独一份，翻页时随折痕旋转
  const backPage = h('iframe.reader-frame.reader-ghost.reader-back', { sandbox: 'allow-same-origin', tabIndex: -1, 'aria-hidden': 'true', title: '' });
  // 纸质书效果：纸张纹理、双页中间的书缝、两侧一页页叠起来的书边
  const bookFx = h('div.book-fx', { 'aria-hidden': 'true' }, h('i.bf-edge.is-l'), h('i.bf-edge.is-r'));
  const touch = h('div.reader-touch');
  const selLayer = h('div.sel-layer', { hidden: true }); // 选字的两个拖柄和菜单
  const pageMark = h('span.page-mark', { hidden: true, 'aria-hidden': 'true' });
  const clock = statusClock();
  const footCenter = h('span.foot-chapter');
  const footRight = h('span.foot-page');
  const slider = h('input.reader-slider', { type: 'range', min: 0, max: 1000, step: 1, 'aria-label': '全书进度' });
  const dockChapter = h('span.dock-chapter');
  const dockPercent = h('span.dock-percent');
  const topSub = h('span.reader-sub');
  const tocList = h('div.toc-list');
  const sheet = h('div.reader-sheet', { hidden: true });
  const aiPanel = h('div.reader-sheet.ai-sheet', { hidden: true });
  const toc = h('aside.reader-toc', { hidden: true }, h('h2', '目录'), tocList);
  const scrim = h('div.reader-scrim', { hidden: true, onclick: closePanels });
  const player = h('div.tts-pill', { hidden: true, role: 'region', 'aria-label': '听书' });
  const searchPanel = h('div.reader-sheet.search-sheet', { hidden: true, role: 'dialog', 'aria-label': '全书搜索' });
  const autoPill = h('div.auto-pill', { hidden: true, role: 'status' });
  const markBtn = h('button.icon-btn', { type: 'button', onclick: toggleBookmark });
  const nightBtn = menuButton('moon', '夜间', toggleNight);
  const root = h('div.reader',
    h('div.reader-stage', frame, ghost, backPage, touch, selLayer, pageMark),
    h('footer.reader-foot', clock.el, footCenter, footRight),
    bookFx,
    h('header.reader-top',
      h('button.icon-btn', { type: 'button', 'aria-label': '返回书架', onclick: onExit }, icon('back')),
      h('div.reader-heading', h('span.reader-title', title), topSub, routeChip(book) || ''),
      markBtn,
      h('button.icon-btn', { type: 'button', 'aria-label': '阅读设置', title: '阅读设置', onclick: () => openSheet('type') }, icon('type'))),
    h('div.reader-bottom',
      h('div.dock-info', dockChapter, dockPercent),
      h('div.bottom-row',
        h('button.icon-btn', { type: 'button', 'aria-label': '上一章', title: '上一章', onclick: () => { if (index > 0) load(index - 1, {}, true, -1); } }, icon('prev')),
        slider,
        h('button.icon-btn', { type: 'button', 'aria-label': '下一章', title: '下一章', onclick: () => { if (index < epub.spine.length - 1) load(index + 1, {}, true, 1); } }, icon('next'))),
      h('div.bottom-actions',
        menuButton('list', '目录', () => openPanel(toc)),
        menuButton('bookmark', '书签', () => openSheet('marks')),
        menuButton('search', '搜索', openSearch),
        menuButton('headphones', '听书', () => { toggleChrome(false); startTts(); }),
        nightBtn,
        menuButton('type', '设置', () => openSheet('type')))),
    player, autoPill, scrim, toc, sheet, aiPanel, searchPanel);
  host.replaceChildren(root);
  const curl = createCurl({ ghost, back: backPage, look: () => ({ paper: paper().bg, dark: paper().dark }) });
  applyPaper();

  function applyPaper() {
    const p = paper();
    root.style.setProperty('--paper', p.bg);
    root.style.setProperty('--paper-ink', p.fg);
    root.style.setProperty('--paper-accent', p.accent);
    root.dataset.dark = String(p.dark);
    root.classList.toggle('is-scroll', isScroll());
    root.classList.toggle('is-book', !!settings.book && !isScroll());
    root.style.setProperty('--grain', p.dark ? GRAIN_DARK : GRAIN_LIGHT);
    nightBtn.replaceChildren(icon(p.dark ? 'sun' : 'moon', 22), h('span', p.dark ? '日间' : '夜间'));
  }
  function toggleNight() {
    if (paper().dark) change({ paper: settings.dayPaper && settings.dayPaper !== 'night' ? settings.dayPaper : 'white' });
    else change({ dayPaper: settings.paper === 'auto' ? 'white' : settings.paper, paper: 'night' });
  }

  // ---------- 排版 ----------
  function buildCss() {
    const stage = frame.parentElement;
    W = Math.max(200, Math.floor(stage.clientWidth));
    H = Math.max(200, Math.floor(stage.clientHeight));
    const wide = W >= 700;
    const cols = !isScroll() && !isVertical() && settings.spread && W >= 1000 && W > H * 1.15 ? 2 : 1;
    spreadCols = cols;
    root?.classList.toggle('is-spread', cols === 2);
    let padH = Math.round(settings.marginPx * (wide ? 2 : 1));
    if (cols === 1 && !isVertical()) padH = Math.max(padH, Math.round((W - 780) / 2));
    const gap = padH * 2;
    const colW = (W - padH * 2 - (cols - 1) * gap) / cols;
    const padV = wide ? 36 : 22;
    const p = paper();
    const font = FONTS[settings.font] || FONTS.book;
    const root0 = `margin:0!important;padding:0!important;background:${p.bg}!important;font-size:${settings.fontSize}px!important;-webkit-text-size-adjust:100%!important;transition:background-color .35s ease`;
    const text = `background:transparent!important;color:${p.fg}!important;font-size:1rem!important;line-height:${settings.lineHeight}!important;font-family:${FONTS.hei.css};
text-align:justify;overflow-wrap:break-word;line-break:strict;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;transition:color .35s ease`;
    let layout;
    if (isVertical()) { // 竖排：一页就是一“栏”，栏沿着文字方向（向下）排，所以翻页是纵向滚一屏
      layout = `
html{${root0};width:${W}px!important;height:${H}px!important;overflow:hidden!important;writing-mode:vertical-rl!important}
body{margin:0!important;padding:${padV}px ${padH}px!important;box-sizing:border-box!important;width:${W}px!important;height:${H}px!important;max-width:none!important;min-width:0!important;writing-mode:vertical-rl!important;
column-width:${H - padV * 2}px!important;column-gap:${padV * 2}px!important;column-fill:auto!important;column-rule:none!important;overflow:visible!important;
${text};text-orientation:mixed}
img,svg,video{max-width:${W - padH * 2}px!important;max-height:${H - padV * 2}px!important;object-fit:contain;break-inside:avoid!important}
.shiori-nav{display:none!important}`;
    } else if (isScroll()) {
      layout = `
html{${root0};width:auto!important;height:auto!important;overflow-x:hidden!important;overflow-y:auto!important;scrollbar-width:thin}
body{margin:0!important;padding:${padV}px ${padH}px 48px!important;box-sizing:border-box!important;width:auto!important;height:auto!important;max-width:none!important;min-width:0!important;columns:auto!important;overflow:visible!important;
${text}}
img,svg,video{max-width:100%!important;max-height:${H}px!important;height:auto;object-fit:contain}
.shiori-nav{display:block;margin:2.2em 0 .6em;padding:15px;border-radius:14px;text-align:center;text-indent:0;font-size:14px;line-height:1.4;cursor:pointer;background:color-mix(in srgb,${p.fg} 8%,transparent)}
.shiori-nav[data-shiori-nav="prev"]{margin:0 0 1.6em}`;
    } else {
      layout = `
html{${root0};width:${W}px!important;height:${H}px!important;overflow:hidden!important}
body{margin:0!important;padding:${padV}px ${padH}px!important;box-sizing:border-box!important;width:${W}px!important;height:${H}px!important;max-width:none!important;min-width:0!important;
column-width:${colW}px!important;column-gap:${gap}px!important;column-fill:auto!important;column-rule:none!important;overflow:visible!important;
${text}}
img,svg,video{max-width:100%!important;max-height:${H - padV * 2}px!important;object-fit:contain;break-inside:avoid!important}
.shiori-nav{display:none!important}`;
    }
    // 纸质书效果画在书页自己的背景上（固定在视口），翻页时纸纹和书缝跟着那张纸一起转，光影才对
    let bookBg = '';
    if (settings.book && !isScroll()) {
      const k = p.dark ? 0.6 : 1, a = (x) => `rgba(0,0,0,${(x * k).toFixed(3)})`;
      const gutter = cols === 2
        ? `linear-gradient(90deg,transparent calc(50% - 80px),${a(0.03)} calc(50% - 40px),${a(0.1)} calc(50% - 14px),${a(0.26)} calc(50% - 1px),rgba(255,255,255,${p.dark ? 0.04 : 0.12}) 50%,${a(0.26)} calc(50% + 1px),${a(0.1)} calc(50% + 14px),${a(0.03)} calc(50% + 40px),transparent calc(50% + 80px))`
        : `linear-gradient(90deg,${a(0.1)},${a(0.03)} 14px,transparent 36px)`;
      const vignette = `radial-gradient(130% 100% at 50% 50%,transparent 60%,${p.dark ? 'rgba(0,0,0,.18)' : 'rgba(70,45,10,.07)'} 100%)`;
      bookBg = `html{background-image:${gutter},${vignette},${p.dark ? GRAIN_DARK : GRAIN_LIGHT}!important;background-attachment:fixed!important;background-size:100% 100%,100% 100%,240px 240px,600px 600px!important;background-repeat:no-repeat,no-repeat,repeat,repeat!important}`;
    }
    const custom = settings.paper === 'auto' ? p !== PAPERS.white : settings.paper !== 'white';
    const a = p.dark ? 0.32 : 0.42;
    const marker = settings.hlStyle === 'marker', wave = settings.hlStyle === 'wave';
    const ink = (c) => (p.dark ? c : `color-mix(in srgb,${c} 78%,#1d2433)`); // 浅色纸上线条稍微压深一点，才看得清
    const hl = Object.entries(HL_COLORS).map(([k, c]) => (marker
      ? `::highlight(shl-${k}){background-color:color-mix(in srgb,${c} ${a * 100}%,transparent)}`
      : `::highlight(shl-${k}){text-decoration:underline ${wave ? 'wavy' : 'solid'} ${ink(c)};text-decoration-thickness:${wave ? 1.5 : 2.5}px;text-underline-offset:${wave ? 4 : 5}px;text-decoration-skip-ink:none}`)).join('\n');
    const noteCss = marker
      ? `text-decoration:underline dotted ${p.accent};text-decoration-thickness:2px;text-underline-offset:4px`
      : `background-color:color-mix(in srgb,${p.accent} ${p.dark ? 16 : 10}%,transparent)`;
    return `${layout}
${bookBg}
${isVertical() ? '' : '*{writing-mode:horizontal-tb!important;text-combine-upright:none!important}'}
p,li,dd,blockquote{line-height:inherit!important;orphans:1;widows:1}
${settings.para > 0 ? `p{margin-block:0 ${settings.para}px!important}` : ''}
a{color:${p.accent}!important;text-decoration:none!important}
${custom ? `body *{color:inherit!important;background-color:transparent!important;border-color:currentColor!important}body a{color:${p.accent}!important}` : ''}
${font.css ? `body,body *{font-family:${font.css}!important}` : ''}
${hl}
::highlight(shl-note){${noteCss}}
::highlight(shl-sel){background-color:color-mix(in srgb,${p.accent} 26%,transparent)}
::highlight(shl-tts){background-color:color-mix(in srgb,${p.accent} 16%,transparent);text-decoration:underline ${p.accent};text-decoration-thickness:2px;text-underline-offset:5px}
::highlight(shl-flash){background-color:color-mix(in srgb,#F5A524 60%,transparent)}`;
  }

  const frameDoc = () => frame.contentDocument;
  const frameWin = () => frame.contentWindow;
  const scroller = () => frameDoc()?.documentElement;
  function measure() {
    const el = scroller(), doc = frameDoc();
    if (!el || isScroll()) return;
    for (const f of doc.querySelectorAll('.shiori-fill')) f.remove();
    const size = () => (isVertical() ? el.scrollHeight : el.scrollWidth);
    const step = isVertical() ? H : W;
    pages = Math.max(1, Math.ceil((size() - 2) / step));
    // 多栏排版时，浏览器算滚动范围不含最后一栏右边的页边距，最后一页滚不到整页的位置，字会整体歪到一边。
    // 在最后一页的末尾放一个看不见的 1px 小块，把滚动范围撑到整页。
    if (doc.body) {
      const f = doc.createElement('div');
      f.className = 'shiori-fill'; f.setAttribute('aria-hidden', 'true');
      f.style.cssText = `position:absolute;width:1px;height:1px;pointer-events:none;${isVertical() ? `left:0;top:${pages * step - 1}px` : `top:0;left:${pages * step - 1}px`}`;
      doc.body.append(f);
    }
  }
  /** 本章内的位置 0~1（页或滚动位置的起点） */
  function fractionNow() {
    if (!isScroll()) return page / pages;
    const el = scroller();
    return el && el.scrollHeight > 0 ? el.scrollTop / el.scrollHeight : 0;
  }
  /** 当前画面覆盖本章的哪一段 [起, 止) */
  function spanNow() {
    if (!isScroll()) return [page / pages, (page + 1) / pages];
    const el = scroller();
    if (!el || !el.scrollHeight) return [0, 1];
    return [el.scrollTop / el.scrollHeight, Math.min(1, (el.scrollTop + el.clientHeight) / el.scrollHeight)];
  }
  let lastPercent = 0;
  function refresh(save = true) { // 更新页脚、进度条、书签标记，并记录进度
    const end = spanNow()[1];
    const percent = lastPercent = epub.percentAt(index, end);
    root.style.setProperty('--read', percent.toFixed(3));
    const pct = `${Math.round(percent * 100)}%`;
    const where = isScroll() ? `本章 ${Math.round(end * 100)}%` : `${page + 1} / ${pages}`;
    footCenter.textContent = chapterTitle();
    footRight.textContent = isScroll() ? pct : `${where}　${pct}`;
    slider.value = Math.round(percent * 1000);
    slider.style.setProperty('--v', `${percent * 100}%`);
    dockChapter.textContent = chapterTitle();
    dockPercent.textContent = pct;
    topSub.textContent = isScroll() ? where : `第 ${page + 1} / ${pages} 页`;
    drawBookmarkState();
    if (save) setProgress(book.id, { index, fraction: fractionNow() }, percent);
  }

  // ---------- 翻页动画 ----------
  // 浮现：文字从轻微模糊中浮现出来；滑动：整页滑过去；淡入；无
  let slideToken = 0;
  function slideTo(x) {
    const win = frameWin(), from = win.scrollX, token = ++slideToken;
    const dist = x - from;
    if (!dist) return;
    const dur = Math.min(320, 160 + Math.abs(dist) / 6) * speed(), t0 = performance.now();
    const step = (now) => {
      if (token !== slideToken || destroyed) return;
      const t = Math.min(1, (now - t0) / dur), ease = 1 - (1 - t) ** 3;
      win.scrollTo(from + dist * ease, 0);
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  const speed = () => Number(settings.turnSpeed) || 1;
  function floatIn(dir, strength = 1) {
    frame.animate([
      { opacity: 0, filter: `blur(${5 * strength}px)`, transform: `translate(${dir * 14 * strength}px, ${4 * strength}px)` },
      { opacity: 1, filter: 'blur(0)', transform: 'none' },
    ], { duration: 300 * speed(), easing: 'cubic-bezier(.2,.7,.2,1)' });
  }
  function fadeIn() { frame.animate([{ opacity: 0.15 }, { opacity: 1 }], { duration: 200 * speed(), easing: 'ease-out' }); }
  // 逐段浮现：这一页上的段落一段接一段地浮上来
  let riseAnims = [];
  const RISE = 'p, h1, h2, h3, h4, h5, h6, li, blockquote, figure, dt, dd, img, svg, table, hr';
  function riseIn(dir) {
    for (const a of riseAnims) a.finish();
    riseAnims = [];
    const doc = frameDoc();
    if (!doc?.body) return;
    const vw = frameWin().innerWidth, vh = frameWin().innerHeight;
    const seen = [];
    for (const el of doc.body.querySelectorAll(RISE)) {
      if (el.parentElement?.closest(RISE)) continue; // 只动最外层的块，避免嵌套的一起抖
      const r = el.getBoundingClientRect();
      if (r.width && r.height && r.right > 0 && r.left < vw && r.bottom > 0 && r.top < vh) seen.push(el);
      if (seen.length >= 28) break;
    }
    if (!seen.length) { floatIn(dir); return; }
    if (isVertical()) seen.sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right);
    const k = speed(), shift = isVertical() ? 'translateX(-10px)' : `translate(${dir * 6}px, 10px)`;
    seen.forEach((el, i) => riseAnims.push(el.animate([{ opacity: 0, transform: shift }, { opacity: 1, transform: 'none' }],
      { duration: 340 * k, delay: Math.min(i, 12) * 32 * k, easing: 'cubic-bezier(.2,.7,.2,1)', fill: 'backwards' })));
  }
  // ---------- 仿真翻页 ----------
  // 幽灵页是当前这一章的一份拷贝（含排版样式），换章、重排、窗口大小变了都要重新拷一次
  const ghostState = { key: '', ready: '', backReady: '', url: null };
  const curlWanted = () => turnStyle() === 'curl' && !isScroll() && !isVertical();
  const ghostKeyNow = () => `${index}|${W}x${H}|${layoutGen}`;
  const ghostReady = () => curlWanted() && ghostState.ready === ghostKeyNow() && !curl.active;
  function prepareGhost() {
    if (!curlWanted() || busy || destroyed || curl.active) return;
    const key = ghostKeyNow();
    if (ghostState.key === key) return;
    const doc = frameDoc();
    if (!doc?.documentElement) return;
    ghostState.key = key; ghostState.ready = '';
    const xml = doc.contentType === 'application/xhtml+xml';
    const text = xml ? new XMLSerializer().serializeToString(doc) : '<!DOCTYPE html>' + doc.documentElement.outerHTML;
    if (ghostState.url) URL.revokeObjectURL(ghostState.url);
    const url = ghostState.url = URL.createObjectURL(new Blob([text], { type: xml ? 'application/xhtml+xml' : 'text/html' }));
    const into = (el, flag) => {
      el.onload = async () => {
        try { await el.contentDocument?.fonts?.ready; } catch { /* 忽略 */ }
        if (ghostState.key === key && url === ghostState.url) ghostState[flag] = key;
      };
      if (el.contentWindow && el.src) el.contentWindow.location.replace(url); else el.src = url;
    };
    into(ghost, 'ready');
    if (spreadCols === 2) into(backPage, 'backReady'); else ghostState.backReady = '';
  }
  const scheduleGhost = () => { if (curlWanted()) (window.requestIdleCallback || setTimeout)(() => prepareGhost(), { timeout: 600 }); };
  const ghostTo = (p) => ghost.contentWindow?.scrollTo(p * W, 0);
  const backTo = (p) => backPage.contentWindow?.scrollTo(p * W, 0);
  const backReady = () => spreadCols === 2 && ghostState.backReady === ghostKeyNow();
  /** 正在翻的那张纸：单页时整页（书脊在左）；双页往后翻是右半边，往前翻是左半边（镜像） */
  function curlGeom(forward, to, sameChapter = true) {
    if (spreadCols === 2) {
      const useBack = sameChapter && backReady();
      if (useBack) backTo(to);
      return forward
        ? { spineX: W / 2, s: 1, w: W / 2, other: [0, W / 2], backPaper: false, useBack }
        : { spineX: W / 2, s: -1, w: W / 2, other: [W / 2, W], backPaper: false, useBack };
    }
    return { spineX: 0, s: 1, w: W, other: null, backPaper: true };
  }
  const curlMs = () => 520 * speed();
  /** 点按、键盘、音量键翻页：自动翻过去。单页往前翻是把上一页“盖回来”，所以幽灵页显示目标页 */
  let curlSeq = 0;
  async function curlTurn(from, to) {
    const seq = ++curlSeq;
    const forward = to > from, reverse = !forward && spreadCols === 1;
    if (reverse) { ghostTo(to); frameWin()?.scrollTo(from * W, 0); } else { ghostTo(from); frameWin()?.scrollTo(to * W, 0); }
    curl.begin(W, H, curlGeom(forward, to), { fromDone: reverse });
    const done = await curl.play(reverse ? 'back' : 'done', curlMs());
    if (seq !== curlSeq) return; // 被下一次翻页打断了，后面的事交给下一次
    if (reverse) frameWin()?.scrollTo(page * W, 0);
    curl.end();
  }
  /** 拖动翻页：dir = 1 往后、-1 往前；返回 false 表示这次不能用仿真翻页 */
  function curlDragBegin(dir, x, y) {
    if (!ghostReady()) return false;
    const to = page + dir;
    if (to < 0 || to > pages - 1) return false;
    const reverse = dir < 0 && spreadCols === 1;
    if (reverse) ghostTo(to); else { ghostTo(page); frameWin()?.scrollTo(to * W, 0); }
    curl.begin(W, H, curlGeom(dir > 0, to), { top: y < H * 0.4, fromDone: reverse });
    curl.dragStart(x, y, reverse ? 1.6 : 1.35);
    curlDrag = { dir, to, reverse };
    return true;
  }
  let curlDrag = null;
  async function curlDragEnd(fling) {
    const d = curlDrag; curlDrag = null;
    if (!d) return;
    const turned = curl.turned();
    // 单页往前翻是从“已翻过去”往回盖，所以判断要反过来
    const commit = d.reverse ? (turned < 0.78 || fling) : (turned > 0.18 || fling);
    const ok = await curl.play(d.reverse ? (commit ? 'back' : 'done') : (commit ? 'done' : 'back'), curlMs() * 0.8);
    curl.end();
    if (commit && ok) { buzz(); show(d.to, true, false); }
    else frameWin()?.scrollTo(page * W, 0);
    scheduleGhost();
  }

  function buzz() { if (settings.haptic) try { navigator.vibrate?.(7); } catch { /* 不支持就算了 */ } }
  function show(p, save = true, animate = false) {
    const before = page;
    page = Math.min(pages - 1, Math.max(0, p));
    const style = animate && page !== before ? turnStyle() : 'none';
    const dir = page > before ? 1 : -1;
    if (animate && page !== before) buzz();
    if (style === 'curl' && curl.active && !curlDrag) { curlSeq++; curl.end(); } // 上一次还没翻完就又翻：直接翻完
    if (style === 'curl' && Math.abs(page - before) === 1 && ghostReady()) {
      slideToken++;
      curlTurn(before, page);
    } else if (isVertical()) {
      frameWin()?.scrollTo(0, page * H);
      if (style === 'rise') riseIn(-dir);
      else if (style === 'slide' || style === 'float') floatIn(-dir); // 竖排从右往左翻：下一页从左边进来
      else if (style === 'fade') fadeIn();
    } else if (style === 'slide') slideTo(page * W);
    else {
      slideToken++;
      frameWin()?.scrollTo(page * W, 0);
      if (style === 'rise') riseIn(dir);
      else if (style === 'float') floatIn(dir);
      else if (style === 'fade') fadeIn();
    }
    clearSelection();
    refresh(save);
  }
  function goFraction(f, save = false) {
    if (isScroll()) { const el = scroller(); frameWin()?.scrollTo(0, f * el.scrollHeight); refresh(save); }
    else show(Math.min(pages - 1, Math.floor(f * pages + 0.0001)), save);
  }
  function chapterTitle() {
    const n = tocIndex();
    return n < 0 ? title : epub.toc[n].label;
  }
  function tocIndex(at = index) { // 某一章对应的目录项：同一章有多个锚点时取第一个
    const exact = epub.toc.findIndex((t) => t.index === at);
    if (exact >= 0) return exact;
    let n = -1;
    epub.toc.forEach((t, k) => { if (t.index < at) n = k; });
    return n;
  }

  async function settle(doc) {
    const imgs = [...doc.querySelectorAll('img')].map((img) => (img.complete ? null : new Promise((r) => {
      img.addEventListener('load', r, { once: true }); img.addEventListener('error', r, { once: true });
    })));
    const fonts = doc.fonts?.ready || Promise.resolve();
    await Promise.race([Promise.all([...imgs, fonts]), new Promise((r) => setTimeout(r, 2500))]);
  }

  // ---------- 文字位置 ----------
  // 本章正文按顺序拼成一串（跳过注音假名和我们自己加的按钮），用“第几个字”来记录划线位置，
  // 这样换字号、换设备都能准确找回同一句话。
  let tmap = { nodes: [], text: '', total: 0, breaks: [] };
  const BLOCKS = 'p, div, h1, h2, h3, h4, h5, h6, li, blockquote, section, dd, dt, tr, figcaption, aside';
  function buildMap() {
    const doc = frameDoc();
    const nodes = [], parts = [], breaks = []; // breaks：每个段落开头是第几个字，朗读和取上下文时按段落断开
    let pos = 0, block = null;
    if (doc?.body) {
      const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
        acceptNode: (n) => (n.parentElement?.closest(TEXT_SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
      });
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const b = n.parentElement?.closest(BLOCKS);
        if (b !== block) { block = b; if (pos) breaks.push(pos); }
        nodes.push({ node: n, start: pos, end: pos + n.data.length });
        parts.push(n.data); pos += n.data.length;
      }
    }
    tmap = { nodes, text: parts.join(''), total: pos, breaks };
  }
  function entryAt(off) { // 包含第 off 个字的文本节点
    const ns = tmap.nodes;
    let lo = 0, hi = ns.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (ns[m].end <= off) lo = m + 1; else hi = m; }
    return ns[lo];
  }
  function offsetOf(node, offset) {
    const hit = tmap.nodes.find((e) => e.node === node);
    if (hit) return hit.start + Math.min(offset, hit.end - hit.start);
    // 落在元素上或注音里：找它后面第一个正文文字
    const doc = frameDoc();
    const point = doc.createRange();
    try { point.setStart(node, offset); } catch { return null; }
    const probe = doc.createRange();
    for (const e of tmap.nodes) {
      probe.setStart(e.node, 0);
      if (point.compareBoundaryPoints(Range.START_TO_START, probe) <= 0) return e.start;
    }
    return tmap.total;
  }
  function rangeOf(start, end) {
    if (!tmap.nodes.length || end <= start) return null;
    start = Math.max(0, start); end = Math.min(tmap.total, end);
    const a = entryAt(start), b = entryAt(end - 1);
    if (!a || !b) return null;
    const r = frameDoc().createRange();
    r.setStart(a.node, start - a.start);
    r.setEnd(b.node, end - b.start);
    return r;
  }
  function caretAt(x, y) { // 书页里某一点对应的字（x、y 是相对书页的坐标）
    const doc = frameDoc();
    if (!doc) return null;
    let node, off;
    if (doc.caretPositionFromPoint) { const p = doc.caretPositionFromPoint(x, y); if (!p) return null; node = p.offsetNode; off = p.offset; }
    else { const r = doc.caretRangeFromPoint?.(x, y); if (!r) return null; node = r.startContainer; off = r.startOffset; }
    if (node.parentElement?.closest('.shiori-nav')) return null;
    const at = offsetOf(node, off);
    // 浏览器给的是“最近的字缝”：点在一个字的右半边时会落到下一个字上，这里纠正回被点中的那个字
    if (at > 0) {
      const b = rangeOf(at - 1, at)?.getBoundingClientRect();
      if (b && x >= b.left && x <= b.right && y >= b.top && y <= b.bottom) return at - 1;
    }
    return at;
  }
  /** 这一点是否真的落在文字上（而不是页边空白） */
  function onText(x, y, off) {
    if (off == null || off >= tmap.total) return false;
    const r = rangeOf(off, off + 1);
    if (!r) return false;
    return [...r.getClientRects()].some((b) => x >= b.left - 8 && x <= b.right + 8 && y >= b.top - 6 && y <= b.bottom + 6);
  }
  const segLocale = () => (/[぀-ヿ]/.test(tmap.text.slice(0, 2000)) ? 'ja' : 'zh');
  function wordAt(off) { // 按词选：日文、中文都用浏览器自带的分词
    const from = Math.max(0, off - 40), slice = tmap.text.slice(from, off + 40);
    if (typeof Intl !== 'undefined' && Intl.Segmenter) {
      for (const s of new Intl.Segmenter(segLocale(), { granularity: 'word' }).segment(slice)) {
        const a = from + s.index, b = a + s.segment.length;
        if (off >= a && off < b) return s.isWordLike && s.segment.trim() ? [a, b] : [off, off + 1];
      }
    }
    return [off, off + 1];
  }
  function sentenceBounds(start, end, limit = 160) {
    const t = tmap.text, brk = new Set(tmap.breaks);
    let a = start, b = end;
    while (a > 0 && start - a < limit && !brk.has(a) && !/[。！？!?\n]/.test(t[a - 1])) a--;
    while (b < t.length && b - end < limit && !brk.has(b) && !/[。！？!?\n]/.test(t[b])) b++;
    while (b < t.length && !brk.has(b) && /[。！？!?…」』）)”’]/.test(t[b])) b++; // 把句号和收尾的引号一起带上
    return trimBounds(a, b);
  }
  function paraBounds(off) {
    let a = 0, b = tmap.total;
    for (const k of tmap.breaks) { if (k <= off) a = k; else { b = k; break; } }
    return trimBounds(a, b);
  }
  function trimBounds(a, b) {
    const t = tmap.text;
    while (a < b && /\s|\u3000/.test(t[a])) a++;
    while (b > a && /\s|\u3000/.test(t[b - 1])) b--;
    return [a, Math.max(a + 1, b)];
  }
  function unitBounds(off, unit = settings.selUnit) {
    if (unit === 'sentence') return sentenceBounds(off, off + 1);
    if (unit === 'para') return paraBounds(off);
    return wordAt(off);
  }
  function sentenceAround(start, end) { // 选中文字所在的整句，查词时给模型当上下文
    const [a, b] = sentenceBounds(start, end);
    return tmap.text.slice(a, b).replace(/\s+/g, ' ').trim();
  }
  /** 当前画面里第一个字的位置 */
  function firstVisibleOffset() {
    const doc = frameDoc();
    if (!doc?.body) return 0;
    const cs = doc.defaultView.getComputedStyle(doc.body);
    const pl = parseFloat(cs.paddingLeft), pt = parseFloat(cs.paddingTop), pr = parseFloat(cs.paddingRight);
    const tries = isVertical() ? [[W - pr - 4, pt + 4], [W - pr - 30, pt + 30]] : [[pl + 4, pt + 4], [pl + 20, pt + 30], [pl + 4, H / 3]];
    for (const [x, y] of tries) { const off = caretAt(x, y); if (off != null) return off; }
    return 0;
  }
  function pageOfOffset(off) {
    const r = rangeOf(off, Math.min(tmap.total, off + 1));
    const b = r?.getClientRects()[0];
    if (!b) return page;
    const win = frameWin();
    if (isVertical()) return Math.max(0, Math.min(pages - 1, Math.floor((b.top + win.scrollY) / H)));
    return Math.max(0, Math.min(pages - 1, Math.floor((b.left + win.scrollX) / W)));
  }
  /** 让第 off 个字出现在画面里 */
  function revealOffset(off, animate = false) {
    if (isScroll()) {
      const b = rangeOf(off, Math.min(tmap.total, off + 1))?.getClientRects()[0];
      if (b && (b.top < 40 || b.bottom > H - 40)) frameWin().scrollBy({ top: b.top - H * 0.3, behavior: animate && !calm ? 'smooth' : 'auto' });
      return;
    }
    const p = pageOfOffset(off);
    if (p !== page) show(p, true, animate);
  }

  // ---------- 划线（用浏览器的自定义高亮，不改动书的内容） ----------
  const highlightsHere = () => marksOf(book.id).filter((m) => m.type === 'highlight' && m.loc?.index === index && m.loc.end > m.loc.start);
  function paintHighlights() {
    const win = frameWin();
    if (!win?.CSS?.highlights || !win.Highlight) return;
    const byColor = Object.fromEntries(Object.keys(HL_COLORS).map((c) => [c, new win.Highlight()]));
    const noted = new win.Highlight();
    for (const m of highlightsHere()) {
      const r = rangeOf(m.loc.start, m.loc.end);
      if (!r) continue;
      (byColor[m.color] || byColor.blue).add(r);
      if (m.text) noted.add(r);
    }
    for (const [c, hl] of Object.entries(byColor)) win.CSS.highlights.set('shl-' + c, hl);
    win.CSS.highlights.set('shl-note', noted);
  }
  function setTempHighlight(name, range) {
    const win = frameWin();
    if (!win?.CSS?.highlights || !win.Highlight) return;
    if (range) win.CSS.highlights.set(name, new win.Highlight(range)); else win.CSS.highlights.delete(name);
  }
  function flashMark(m) {
    const r = m?.loc && rangeOf(m.loc.start, m.loc.end);
    if (!r) return;
    setTempHighlight('shl-flash', r);
    setTimeout(() => { if (!destroyed) setTempHighlight('shl-flash', null); }, 1600);
  }

  /** 给刚载入的章节接上事件，并在首尾放上“上一章 / 下一章”（只在上下滚动时显示） */
  function wire(doc, i) {
    const make = (dir, text) => {
      const el = doc.createElementNS(doc.documentElement.namespaceURI || 'http://www.w3.org/1999/xhtml', 'div');
      el.setAttribute('class', 'shiori-nav'); el.setAttribute('data-shiori-nav', dir); el.textContent = text;
      return el;
    };
    const label = (at) => { const n = tocIndex(at); return n < 0 || epub.toc[n].index !== at ? '' : `：${epub.toc[n].label}`; };
    if (doc.body) {
      if (i > 0) doc.body.insertBefore(make('prev', `上一章${label(i - 1)}`), doc.body.firstChild);
      doc.body.appendChild(make('next', i < epub.spine.length - 1 ? `下一章${label(i + 1)}` : '全书完'));
    }
    doc.addEventListener('keydown', onKey);
    doc.addEventListener('contextmenu', (e) => e.preventDefault());
    // 上下滚动时书页自己接收点按
    doc.addEventListener('pointerdown', onDocDown);
    doc.addEventListener('pointermove', onDocMove);
    doc.addEventListener('pointerup', onDocUp);
    doc.addEventListener('pointercancel', () => { clearTimeout(docPress); docDown = null; });
    doc.addEventListener('click', (e) => { if (isScroll()) e.preventDefault(); });
    frameWin().addEventListener('scroll', onDocScroll, { passive: true });
  }

  /** where: { fraction } | { hash } | { offset } | { last: true }；dir 是换章方向，决定动画从哪边进来 */
  async function load(i, where = {}, save = true, dir = 0, quiet = false) {
    const token = ++loadToken;
    busy = true;
    clearSelection();
    if (!quiet) frame.style.visibility = 'hidden'; // 仿真翻页换章时，上面盖着幽灵页，书页不用藏
    layoutGen++;
    try {
      const url = await epub.chapter(i, buildCss());
      if (token !== loadToken || destroyed) return;
      await new Promise((resolve) => {
        frame.onload = resolve;
        // 用 replace 换章，避免 iframe 往浏览器历史里塞记录（否则“返回”会退回上一章而不是书架）
        if (frameWin() && frame.src) frameWin().location.replace(url); else frame.src = url;
      });
      if (token !== loadToken || destroyed) return;
      const doc = frameDoc();
      wire(doc, i);
      await settle(doc);
      if (token !== loadToken || destroyed) return;
      index = i;
      buildMap();
      measure();
      if (isScroll()) {
        const el = scroller();
        let y = 0;
        if (where.last) y = el.scrollHeight;
        else if (where.hash) y = anchorOffset(where.hash);
        else if (where.offset != null) { const b = rangeOf(where.offset, where.offset + 1)?.getClientRects()[0]; y = b ? b.top - H * 0.3 : 0; }
        else if (where.fraction) y = where.fraction * el.scrollHeight;
        frameWin().scrollTo(0, y);
        refresh(save);
      } else {
        let target = 0;
        if (where.last) target = pages - 1;
        else if (where.hash) target = anchorPage(where.hash);
        else if (where.offset != null) target = pageOfOffset(where.offset);
        else if (where.fraction) target = Math.min(pages - 1, Math.floor(where.fraction * pages + 0.0001));
        show(target, save);
      }
      paintHighlights();
      markToc();
    } catch (e) {
      console.error(e);
      toast(`这一章打不开：${e.message}`, { error: true });
    } finally {
      if (token === loadToken) {
        frame.style.visibility = ''; busy = false;
        const style = quiet ? 'none' : turnStyle() === 'curl' ? 'fade' : turnStyle();
        if (dir) buzz();
        scheduleGhost();
        if (style === 'rise') riseIn(isScroll() ? 0 : dir * (isVertical() ? -1 : 1));
        else if (style === 'float') floatIn(isScroll() ? 0 : dir * (isVertical() ? -1 : 1), 1.4);
        else if (style !== 'none') {
          const shift = style === 'slide' && !isScroll() ? dir * 48 * (isVertical() ? -1 : 1) : 0;
          frame.animate([{ opacity: 0, transform: `translateX(${shift}px)` }, { opacity: 1, transform: 'none' }], { duration: 220 * speed(), easing: 'ease-out' });
        }
      }
    }
  }
  /** 锚点在本章里的偏移（沿翻页 / 滚动方向） */
  function anchorOffset(hash) {
    const doc = frameDoc();
    let el = doc.getElementById(hash);
    if (!el) { try { el = doc.querySelector(`[name="${CSS.escape(hash)}"]`); } catch { /* 忽略 */ } }
    if (!el) return 0;
    const r = el.getBoundingClientRect(), win = frameWin();
    if (isScroll()) return Math.max(0, r.top + win.scrollY - 12);
    return isVertical() ? r.top + win.scrollY : r.left + win.scrollX;
  }
  const anchorPage = (hash) => Math.floor((anchorOffset(hash) + 1) / (isVertical() ? H : W));
  function goAnchor(hash) {
    if (isScroll()) { frameWin().scrollTo(0, anchorOffset(hash)); refresh(); }
    else show(anchorPage(hash), true, true);
  }

  /** 改了排版：文字先轻轻淡开，重排后再浮现回来 */
  let relayoutAnim = null;
  function relayout(animated = true) {
    const doc = frameDoc();
    const style = doc?.getElementById('shiori-style');
    if (!style) return;
    const anchor = isScroll() ? null : firstVisibleOffset();
    const fraction = fractionNow();
    const apply = () => {
      style.textContent = buildCss();
      layoutGen++;
      frameWin().scrollTo(0, 0);
      measure();
      if (anchor != null && tmap.total) show(pageOfOffset(anchor), false); else goFraction(fraction);
      paintHighlights();
      scheduleGhost();
    };
    if (!animated || calm) { apply(); return; }
    // 只用透明度过渡：给整页加模糊滤镜很吃性能，换字体这种要整章重排的操作会因此卡一下
    // 注意：淡出动画用了 fill:'forwards'，结束后必须取消掉，否则它会一直把页面压在 20% 透明度（以前换字体后字变淡就是这个原因）
    relayoutAnim?.cancel();
    for (const an of frame.getAnimations()) an.cancel();
    const out = frame.animate([{ opacity: 1 }, { opacity: 0.2 }], { duration: 100, easing: 'ease-in', fill: 'forwards' });
    relayoutAnim = out;
    out.onfinish = () => {
      apply();
      out.cancel();
      relayoutAnim = frame.animate([{ opacity: 0.2, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { duration: 260, easing: 'cubic-bezier(.2,.7,.2,1)' });
    };
  }

  function next() {
    if (busy) return;
    if (isScroll()) {
      const el = scroller();
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 2) {
        if (index < epub.spine.length - 1) load(index + 1, {}, true, 1); else toast('已经是最后一页了');
      } else frameWin().scrollBy({ top: el.clientHeight * 0.88, behavior: calm ? 'auto' : 'smooth' });
      return;
    }
    if (page < pages - 1) show(page + 1, true, true);
    else if (index < epub.spine.length - 1) {
      if (turnStyle() === 'curl' && ghostReady()) curlIntoNext(); else load(index + 1, {}, true, 1);
    } else { show(page, false); toast('已经是最后一页了'); }
  }
  /** 翻到下一章：先让幽灵页盖住这一页，下面悄悄换章，换好了再把这张纸翻过去 */
  async function curlIntoNext() {
    const seq = ++curlSeq;
    ghostTo(page);
    curl.begin(W, H, curlGeom(true, 0, false));
    await load(index + 1, {}, true, 0, true);
    if (seq !== curlSeq || destroyed) { if (curl.active && seq === curlSeq) curl.end(); return; }
    buzz();
    await curl.play('done', curlMs());
    if (seq === curlSeq) curl.end();
    scheduleGhost();
  }
  function prev() {
    if (busy) return;
    if (isScroll()) {
      const el = scroller();
      if (el.scrollTop <= 2) { if (index > 0) load(index - 1, { last: true }, true, -1); }
      else frameWin().scrollBy({ top: -el.clientHeight * 0.88, behavior: calm ? 'auto' : 'smooth' });
      return;
    }
    if (page > 0) show(page - 1, true, true);
    else if (index > 0) load(index - 1, { last: true }, true, -1);
    else show(page, false);
  }
  // 屏幕左 / 右对应的翻页方向：竖排是从右往左读，所以左边是“下一页”
  const leftward = () => (isVertical() ? next() : prev());
  const rightward = () => (isVertical() ? prev() : next());

  // ---------- 面板 ----------
  const chromeOpen = () => root.classList.contains('is-chrome');
  function toggleChrome(on = !chromeOpen()) { root.classList.toggle('is-chrome', on); if (on) clearSelection(); }
  // 第一次用某个中文字体时，系统要把很大的字体文件读进来，正好赶上整章重排就会卡住。
  // 打开设置时先在看不见的地方用这几种字体各排一小段本章的字，换字体时就快了。
  let fontsWarm = false;
  function warmFonts() {
    const doc = frameDoc();
    if (fontsWarm || !doc?.body) return;
    fontsWarm = true;
    const sample = (tmap.text || '').slice(0, 800) || '的一是在不了有和人这中大为上个国我以要他时来用们生到作地于出就分对成会可主发年动同工也能下过子说产种面而方后多定行学法所民得经十三之进着等部度家电力里如水化高自二理起小物现实加量都两体制机当使点从业本去把性好应开它合还因由其些然前外天政四日那社义事平形相全表间样与关各重新线内数正心反你明看原又么利比或但质气第向道命此变条只没结解问意建月公无系军很情者最立代想已通并提直题党程展五果料象员革位入常文总次品式活设及管特件长求老头基资边流路级少图山统接知较将组见计别她手角期根论运农指几九区强放决西被干做必战先回则任取据处府';
    const box = doc.createElement('div');
    box.setAttribute('aria-hidden', 'true');
    box.style.cssText = 'position:absolute;left:-99999px;top:0;width:600px;visibility:hidden;pointer-events:none';
    for (const f of Object.values(FONTS)) if (f.css) { const sp = doc.createElement('p'); sp.style.cssText = `font-family:${f.css}!important;margin:0`; sp.textContent = sample; box.append(sp); }
    doc.body.append(box);
    box.offsetHeight; // 立刻排一次，让浏览器去加载字体
    setTimeout(() => box.remove(), 1500);
  }
  function openPanel(panel) {
    if (panel === sheet) (window.requestIdleCallback || setTimeout)(warmFonts);
    toggleChrome(false);
    clearSelection();
    for (const p of [toc, sheet, aiPanel, searchPanel]) p.hidden = p !== panel;
    scrim.hidden = false;
    if (panel === toc) tocList.querySelector('.is-current')?.scrollIntoView({ block: 'center' });
  }
  function closePanels() {
    toc.hidden = true; sheet.hidden = true; scrim.hidden = true; searchPanel.hidden = true;
    if (!aiPanel.hidden) { aiPanel.hidden = true; aiAbort?.abort(); }
  }
  const panelOpen = () => !scrim.hidden;

  /** 找出某个元素对应的插画地址（<img> 或 SVG 里的 <image>） */
  function imageOf(el) {
    const img = el?.closest?.('img');
    if (img) return img.currentSrc || img.getAttribute('src');
    const svg = el?.closest?.('svg');
    const inner = el?.localName === 'image' ? el : svg?.querySelector('image');
    return inner ? inner.getAttribute('href') || inner.getAttributeNS('http://www.w3.org/1999/xlink', 'href') : null;
  }
  const local = (x, y) => { const r = frame.getBoundingClientRect(); return [x - r.left, y - r.top]; };
  const hitAt = (x, y) => frameDoc()?.elementFromPoint(...local(x, y));
  function followLink(el) {
    const link = el?.closest?.('a[href]');
    const to = link && epub.resolveLink(index, link.getAttribute('href'));
    if (!to) return false;
    if (to.index === index) { if (to.hash) goAnchor(to.hash); } else load(to.index, { hash: to.hash }, true, Math.sign(to.index - index));
    return true;
  }
  /** 点到了已有的划线上：返回那条划线 */
  function highlightAt(lx, ly) {
    const off = caretAt(lx, ly);
    if (!onText(lx, ly, off)) return null;
    return highlightsHere().find((m) => off >= m.loc.start && off < m.loc.end) || null;
  }
  /** 单击：链接 → 划线 → 左右翻页 / 中间呼出菜单。x、y 为相对书页的坐标 */
  function tapAt(lx, ly, target) {
    if (autoTimer) { stopAuto(); toast('已停止自动翻页'); return; }
    if (chromeOpen()) { toggleChrome(false); return; }
    if (sel) { clearSelection(); return; }
    if (followLink(target)) return;
    const m = highlightAt(lx, ly);
    if (m) { selectHighlight(m); return; }
    if (isScroll()) {
      const nav = target?.closest?.('[data-shiori-nav]')?.getAttribute('data-shiori-nav');
      if (nav === 'prev') { load(index - 1, { last: true }, true, -1); return; }
      if (nav === 'next') { if (index < epub.spine.length - 1) load(index + 1, {}, true, 1); return; }
      const src = imageOf(target);
      if (src) { imageViewer(src); return; }
      toggleChrome(true);
      return;
    }
    const x = lx / W;
    if (x >= 0.3 && x <= 0.7) toggleChrome(true);
    else if (settings.tapMode === 'next') next(); // 两侧都是下一页：单手拿手机时更顺手
    else if (x < 0.3) leftward(); else rightward();
  }

  // ---------- 选字 ----------
  let sel = null; // { start, end, mark? }
  const selMenu = h('div.sel-menu', { role: 'toolbar', 'aria-label': '选中文字的操作' });
  const knobA = h('span.sel-knob.is-start', { 'aria-hidden': 'true' });
  const knobB = h('span.sel-knob.is-end', { 'aria-hidden': 'true' });
  selLayer.append(knobA, knobB, selMenu);
  function visibleRects(range) {
    return [...range.getClientRects()].filter((b) => b.width > 0 && b.right > 0 && b.left < W && b.bottom > 0 && b.top < H);
  }
  function selectRange(start, end, mark = null) {
    if (end < start) [start, end] = [end, start];
    end = Math.max(end, start + 1);
    sel = { start, end, mark };
    drawSelection();
  }
  function drawSelection(showMenu = true) {
    if (!sel) return;
    const r = rangeOf(sel.start, sel.end);
    if (!r) { clearSelection(); return; }
    setTempHighlight('shl-sel', sel.mark ? null : r);
    const rects = visibleRects(r);
    if (!rects.length) { selLayer.hidden = true; return; }
    selLayer.hidden = false;
    const first = rects[0], last = rects[rects.length - 1];
    knobA.hidden = knobB.hidden = !!sel.mark;
    if (isVertical()) {
      Object.assign(knobA.style, { left: `${first.right}px`, top: `${first.top}px` });
      Object.assign(knobB.style, { left: `${last.left}px`, top: `${last.bottom}px` });
    } else {
      Object.assign(knobA.style, { left: `${first.left}px`, top: `${first.top}px` });
      Object.assign(knobB.style, { left: `${last.right}px`, top: `${last.bottom}px` });
    }
    selMenu.hidden = !showMenu;
    if (!showMenu) return;
    drawMenu();
    const top = Math.min(...rects.map((b) => b.top)), bottom = Math.max(...rects.map((b) => b.bottom));
    const left = Math.min(...rects.map((b) => b.left)), right = Math.max(...rects.map((b) => b.right));
    const mw = selMenu.offsetWidth || 320, mh = selMenu.offsetHeight || 48;
    const x = Math.min(W - mw - 8, Math.max(8, (left + right) / 2 - mw / 2));
    const y = top - mh - 14 > 8 ? top - mh - 14 : Math.min(H - mh - 8, bottom + 18);
    Object.assign(selMenu.style, { left: `${x}px`, top: `${y}px` });
  }
  function clearSelection() {
    if (!sel) return;
    sel = null;
    selLayer.hidden = true;
    setTempHighlight('shl-sel', null);
  }
  const selText = () => (sel ? tmap.text.slice(sel.start, sel.end) : '');
  function selectHighlight(m) { selectRange(m.loc.start, m.loc.end, m); }

  function drawMenu() {
    const m = sel.mark;
    const act = (ic, label, fn) => h('button.sel-act', { type: 'button', onclick: (e) => { e.stopPropagation(); fn(); } }, icon(ic, 18), h('span', label));
    const colors = h('div.sel-colors', Object.entries(HL_COLORS).map(([k, c]) => h('button.sel-color' + ((m ? m.color : settings.hlColor) === k ? '.is-on' : ''), {
      type: 'button', 'aria-label': `${HL_NAMES[k]}色划线`, style: `--c:${c}`,
      onclick: (e) => { e.stopPropagation(); change({ hlColor: k }, false); if (m) { saveMark(book.id, { ...m, color: k }); sel.mark = { ...m, color: k }; paintHighlights(); drawMenu(); } else addHighlight(); },
    })));
    if (m) {
      selMenu.replaceChildren(colors, h('span.sel-sep'),
        act('pen', m.text ? '改批注' : '批注', () => annotate(m)),
        act('copy', '复制', () => copySel()),
        act('dict', '查词', () => askAi('lookup')),
        act('translate', '翻译', () => askAi('translate')),
        act('trash', '删除', () => { removeMark(book.id, m.id); clearSelection(); paintHighlights(); toast('已删除划线'); }));
    } else {
      const origin = sel.origin ?? sel.start;
      const units = !sel.anchor && h('div.sel-units', { role: 'group', 'aria-label': '选取范围' }, [['word', '词'], ['sentence', '句'], ['para', '段']].map(([k, t]) => h('button' + (settings.selUnit === k ? '.is-on' : ''), {
        type: 'button', 'aria-pressed': String(settings.selUnit === k),
        onclick: (e) => { e.stopPropagation(); change({ selUnit: k }, false); const [a, b] = unitBounds(origin, k); selectRange(a, b); if (sel) sel.origin = origin; },
      }, t)));
      selMenu.replaceChildren(
        units || '', units ? h('span.sel-sep') : '',
        act('copy', '复制', () => copySel()),
        act('highlighter', '划线', () => addHighlight()),
        act('pen', '批注', () => annotateSelection()),
        act('dict', '查词', () => askAi('lookup')),
        act('translate', '翻译', () => askAi('translate')),
        act('sparkle', '问助手', () => askAi('ask')),
        act('headphones', '朗读', () => { const from = sel.start; clearSelection(); startTts(from); }));
    }
  }
  async function copySel() {
    const t = selText();
    clearSelection();
    try { await navigator.clipboard.writeText(t); toast('已复制'); } catch { toast('复制失败', { error: true }); }
  }
  const excerptOf = (start, end) => tmap.text.slice(start, end).replace(/\s+/g, ' ').trim().slice(0, 2000);
  function createHighlight(start, end, text = '') {
    return saveMark(book.id, {
      type: 'highlight', color: settings.hlColor,
      loc: { index, start, end, fraction: fractionNow() },
      percent: epub.percentAt(index, start / Math.max(1, tmap.total)),
      chapter: chapterTitle(), excerpt: excerptOf(start, end), ...(text ? { text } : {}),
    });
  }
  function addHighlight(announce = true) {
    if (!sel) return null;
    const mark = createHighlight(sel.start, sel.end);
    clearSelection();
    paintHighlights();
    if (announce) toast('已划线，点划线可以改颜色或写批注');
    return mark;
  }
  function annotateSelection() {
    if (!sel) return;
    const { start, end } = sel;
    const chapterAt = index;
    annotate({ excerpt: excerptOf(start, end) }, (text) => {
      if (index !== chapterAt) return; // 写批注的时候换了章，位置就对不上了
      createHighlight(start, end, text);
    });
  }
  function annotate(mark, create) {
    if (!mark) return;
    clearSelection();
    return dialog(mark.text ? '修改批注' : '写批注', (close) => {
      const area = h('textarea.field.is-area', { value: mark.text || '', rows: 5, maxLength: 5000, placeholder: '写下你的想法…' });
      setTimeout(() => area.focus(), 40);
      return h('form.dialog-body', {
        onsubmit: (e) => {
          e.preventDefault();
          const text = area.value.trim();
          if (create) { if (!text) { close(); return; } create(text); } else saveMark(book.id, { ...mark, text });
          paintHighlights(); close(); toast('批注已保存');
        },
      },
      h('blockquote.note-quote', mark.excerpt),
      area,
      h('div.dialog-actions',
        h('button.btn', { type: 'button', onclick: () => close() }, '取消'),
        h('button.btn.is-primary', { type: 'submit' }, '保存')));
    });
  }

  // ---------- 查词 / 翻译 / 问助手 ----------
  let aiAbort = null;
  function md(text) { // 很小的 Markdown：段落、**粗体**、【小标题】
    const frag = document.createDocumentFragment();
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      const p = h('p');
      for (const part of line.replace(/^#+\s*/, '').split(/(\*\*[^*]+\*\*|【[^】]+】)/)) {
        if (/^\*\*.+\*\*$/.test(part)) p.append(h('strong', part.slice(2, -2)));
        else if (/^【.+】$/.test(part)) p.append(h('strong.ai-tag', part));
        else if (part) p.append(part);
      }
      frag.append(p);
    }
    return frag;
  }
  function askAi(kind) {
    const text = (sel ? selText() : '').trim();
    if (!text) return;
    const context = sel ? sentenceAround(sel.start, sel.end) : text;
    const mark = sel?.mark;
    const span = sel && { start: sel.start, end: sel.end };
    clearSelection();
    openAiPanel(kind, text, context, mark, span);
  }
  function openAiPanel(kind, text, context, mark, span) {
    const out = h('div.ai-out', { 'aria-live': 'polite' });
    const question = h('input.field.is-pill', { type: 'text', placeholder: '接着问点什么…', 'aria-label': '向助手提问' });
    let answer = '';
    const tabs = [['lookup', '查词'], ['translate', '翻译'], ['ask', '问助手']];
    const run = async (k, q) => {
      kind = k;
      tabEl.replaceChildren(...tabs.map(([v, t]) => h('button' + (kind === v ? '.is-on' : ''), { type: 'button', onclick: () => run(v) }, t)));
      aiAbort?.abort();
      if (!ai.aiReady() || !ai.aiSettings().key && /openai\.com/.test(ai.aiSettings().base)) {
        out.replaceChildren(h('p', '还没有设置阅读助手的接口。'), h('button.btn.is-soft', { type: 'button', onclick: () => { onExit(); setTimeout(() => window.dispatchEvent(new CustomEvent('open-settings', { detail: 'ai' })), 50); } }, '去设置'));
        return;
      }
      if (k === 'ask' && !q) { out.replaceChildren(h('p.ai-hint', '在下面输入问题，助手会结合选中的这段文字回答。')); question.focus(); return; }
      const messages = k === 'lookup' ? ai.lookupMessages(text, context, title) : k === 'translate' ? ai.translateMessages(text) : ai.askMessages(q, context.includes(text) ? context : text, title);
      const ctrl = aiAbort = new AbortController();
      out.replaceChildren(h('p.ai-hint.is-loading', '正在思考…'));
      try {
        answer = await ai.chat(messages, { signal: ctrl.signal, onDelta: (t) => { answer = t; out.replaceChildren(md(t)); } });
        if (!answer) out.replaceChildren(h('p.ai-hint', '没有得到回答，换个说法试试。'));
      } catch (e) {
        if (e.name !== 'AbortError') out.replaceChildren(h('p.form-error', e.message));
      }
    };
    const tabEl = h('div.sheet-tabs');
    aiPanel.replaceChildren(
      h('div.sheet-head', h('h2', '阅读助手'), h('button.icon-btn', { type: 'button', 'aria-label': '关闭', onclick: closePanels }, icon('close'))),
      tabEl,
      h('div.sheet-body',
        h('blockquote.ai-quote', text.length > 160 ? text.slice(0, 160) + '…' : text),
        out,
        h('form.ai-ask', { onsubmit: (e) => { e.preventDefault(); const q = question.value.trim(); if (q) { run('ask', q); question.value = ''; } } },
          question, h('button.icon-btn', { type: 'submit', 'aria-label': '发送' }, icon('next'))),
        h('div.ai-actions',
          h('button.btn.is-soft-sm', { type: 'button', onclick: async () => { try { await navigator.clipboard.writeText(answer); toast('已复制'); } catch { toast('复制失败', { error: true }); } } }, icon('copy', 16), '复制回答'),
          h('button.btn.is-soft-sm', { type: 'button', onclick: () => {
            if (!answer) return;
            const target = mark || (span && (() => { sel = { ...span }; return addHighlight(false); })());
            if (!target) { toast('找不到这段文字的位置', { error: true }); return; }
            saveMark(book.id, { ...target, text: [target.text, answer].filter(Boolean).join('\n\n') });
            paintHighlights(); toast('已存为批注');
          } }, icon('pen', 16), '存为批注'))));
    openPanel(aiPanel);
    run(kind);
  }

  // ---------- 听书 ----------
  let tts = null; // { sentences, i, playing, token }
  function sentencesOf() { // 按段落、再按句号切成一句一句
    const out = [];
    const edges = [0, ...tmap.breaks, tmap.total];
    for (let k = 0; k < edges.length - 1; k++) {
      const from = edges[k], para = tmap.text.slice(from, edges[k + 1]);
      const re = /[^。！？!?…\n]+[。！？!?…」』）)"”]*/g;
      for (let m = re.exec(para); m; m = re.exec(para)) {
        const s = m[0];
        if (s.trim().length && /[\p{L}\p{N}]/u.test(s)) out.push({ start: from + m.index, end: from + m.index + s.length, text: s.trim() });
      }
    }
    return out;
  }
  // ---------- 全书搜索 ----------
  const textCache = new Map();
  const search = { q: '', results: [], done: 0, token: 0, input: null, list: null, status: null };
  function openSearch() {
    openPanel(searchPanel);
    if (!search.input) {
      search.input = h('input.field', { type: 'search', placeholder: '在这本书里搜索…', enterkeyhint: 'search', 'aria-label': '搜索内容' });
      let t = null;
      search.input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => runSearch(search.input.value), 350); });
      search.input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(t); runSearch(search.input.value); } });
      search.status = h('p.search-status');
      search.list = h('div.search-list');
      searchPanel.replaceChildren(
        h('div.sheet-head', h('h2', '全书搜索'), h('button.icon-btn', { type: 'button', 'aria-label': '关闭', onclick: closePanels }, icon('close'))),
        h('div.search-box', icon('search', 18), search.input),
        search.status, search.list);
    }
    setTimeout(() => { search.input.focus(); search.input.select(); }, 60);
  }
  async function chapterText(i) {
    if (i === index && tmap.total) return tmap.text;
    if (!textCache.has(i)) textCache.set(i, await epub.plainText(i, TEXT_SKIP).catch(() => ''));
    return textCache.get(i);
  }
  async function runSearch(raw) {
    const q = raw.trim();
    const token = ++search.token;
    search.q = q; search.results = [];
    search.list.replaceChildren();
    if (!q) { search.status.textContent = ''; return; }
    const needle = q.toLowerCase();
    const n = epub.spine.length;
    let shown = 0;
    for (let i = 0; i < n && search.results.length < 500; i++) {
      search.status.textContent = `正在搜索… ${i + 1} / ${n} 章`;
      const text = await chapterText(i);
      if (token !== search.token || destroyed) return;
      const low = text.toLowerCase();
      for (let at = low.indexOf(needle); at >= 0 && search.results.length < 500; at = low.indexOf(needle, at + needle.length)) {
        search.results.push({ index: i, start: at, end: at + q.length, before: text.slice(Math.max(0, at - 26), at), hit: text.slice(at, at + q.length), after: text.slice(at + q.length, at + q.length + 40) });
      }
      // 每搜完一章就把新结果画出来，长书也不用干等
      const frag = document.createDocumentFragment();
      let lastChapter = shown ? search.results[shown - 1].index : -1;
      for (; shown < search.results.length; shown++) {
        const r = search.results[shown];
        if (r.index !== lastChapter) { lastChapter = r.index; const k = tocIndex(r.index); frag.append(h('div.search-chapter', k < 0 ? `第 ${r.index + 1} 部分` : epub.toc[k].label)); }
        frag.append(h('button.search-hit', { type: 'button', onclick: () => jumpTo(r) }, h('span',
          r.before.replace(/\s+/g, ' ').trimStart(), h('mark', r.hit), r.after.replace(/\s+/g, ' '))));
      }
      search.list.append(frag);
      if (i % 4 === 3) await new Promise((res) => setTimeout(res)); // 让界面喘口气
    }
    if (token !== search.token) return;
    search.status.textContent = search.results.length ? `找到 ${search.results.length >= 500 ? '500+' : search.results.length} 处` : '没有找到';
  }
  async function jumpTo(r) {
    closePanels();
    if (r.index !== index) await load(r.index, { offset: r.start }, true, Math.sign(r.index - index));
    if (destroyed) return;
    let { start, end } = r;
    const q = r.hit.toLowerCase();
    if (tmap.text.slice(start, end).toLowerCase() !== q) { // 万一偏了几个字，就在附近找一下
      const near = tmap.text.toLowerCase().indexOf(q, Math.max(0, start - 200));
      if (near < 0) return;
      start = near; end = near + q.length;
    }
    revealOffset(start, true);
    const range = rangeOf(start, end);
    setTempHighlight('shl-flash', range);
    setTimeout(() => { if (!destroyed) setTempHighlight('shl-flash', null); }, 1800);
  }

  // ---------- 自动翻页 ----------
  let autoTimer = null;
  function startAuto() {
    stopAuto();
    closePanels(); toggleChrome(false);
    const sec = Number(settings.autoSec) || 30;
    autoTimer = setInterval(() => {
      if (destroyed) return stopAuto();
      if (panelOpen() || sel || busy || document.hidden) return;
      if (!isScroll() && page >= pages - 1 && index >= epub.spine.length - 1) { stopAuto(); toast('已经读到最后了'); return; }
      next();
      touchActivity();
    }, sec * 1000);
    autoPill.hidden = false;
    autoPill.replaceChildren(icon('clock', 16), h('span', `自动翻页 · 每 ${sec} 秒`),
      h('button', { type: 'button', onclick: (e) => { e.stopPropagation(); stopAuto(); } }, '停止'));
  }
  function stopAuto() { clearInterval(autoTimer); autoTimer = null; autoPill.hidden = true; }

  function drawPlayer() {
    player.hidden = !tts;
    if (!tts) return;
    const cur = tts.sentences[tts.i];
    const rate = ai.ttsSettings().rate;
    player.replaceChildren(
      h('button.icon-btn', { type: 'button', 'aria-label': '停止听书', onclick: stopTts }, icon('stop', 18)),
      h('button.tts-main', { type: 'button', 'aria-label': tts.playing ? '暂停' : '继续', onclick: () => (tts.playing ? pauseTts() : resumeTts()) }, icon(tts.playing ? 'pause' : 'play', 18)),
      h('span.tts-text', h('span.tts-title', tts.playing ? '正在朗读' : '已暂停'), h('span.tts-line', cur ? cur.text : chapterTitle())),
      h('button.tts-rate.tts-sleep' + (tts.sleep ? '.is-on' : ''), { type: 'button', 'aria-label': '定时停止', title: '定时停止', onclick: cycleSleep }, sleepLabel()),
      h('button.tts-rate', { type: 'button', 'aria-label': '语速', title: '语速', onclick: () => {
        const steps = [0.8, 1, 1.2, 1.5, 1.8, 2];
        const nxt = steps[(steps.findIndex((s) => s >= rate - 0.01) + 1) % steps.length];
        ai.saveTtsSettings({ rate: nxt }); drawPlayer();
        if (tts.playing) { ai.stopSpeaking(); }
      } }, `${rate.toFixed(1)}×`));
  }
  const SLEEPS = [null, 15, 30, 60, 'chapter'];
  function cycleSleep() {
    const k = SLEEPS.findIndex((v) => v === (tts.sleep?.mode ?? null));
    const mode = SLEEPS[(k + 1) % SLEEPS.length];
    tts.sleep = mode == null ? null : { mode, until: typeof mode === 'number' ? Date.now() + mode * 60000 : 0 };
    toast(mode == null ? '已取消定时' : mode === 'chapter' ? '读完这一章就停' : `${mode} 分钟后停止朗读`);
    drawPlayer();
  }
  function sleepLabel() {
    const s = tts?.sleep;
    if (!s) return '定时';
    if (s.mode === 'chapter') return '本章';
    return `${Math.max(1, Math.ceil((s.until - Date.now()) / 60000))} 分`;
  }
  async function startTts(fromOffset) {
    if (!ai.ttsAvailable()) { toast(ai.ttsSettings().engine === 'api' ? '请先在设置 → 阅读助手里填好接口' : '这台设备不支持朗读，可以在设置 → 听书里改用接口语音', { error: true }); return; }
    stopTts();
    const from = fromOffset ?? firstVisibleOffset();
    const sentences = sentencesOf();
    const i = Math.max(0, sentences.findIndex((s) => s.end > from));
    tts = { sentences, i, playing: true, token: 0 };
    drawPlayer();
    loopTts();
  }
  async function loopTts() {
    const token = ++tts.token;
    while (tts && tts.playing && token === tts.token) {
      const cur = tts.sentences[tts.i];
      if (tts.sleep?.until && Date.now() >= tts.sleep.until) { tts.sleep = null; pauseTts(); toast('定时到了，已暂停朗读'); return; }
      if (!cur) { // 本章读完：进下一章
        if (tts.sleep?.mode === 'chapter') { tts.sleep = null; pauseTts(); toast('这一章读完了，已暂停朗读'); return; }
        if (index >= epub.spine.length - 1) { toast('全书读完了'); stopTts(); return; }
        await load(index + 1, {}, true, 1);
        if (!tts || token !== tts.token) return;
        tts.sentences = sentencesOf(); tts.i = 0;
        continue;
      }
      setTempHighlight('shl-tts', rangeOf(cur.start, cur.end));
      revealOffset(cur.start, true);
      drawPlayer();
      ai.prefetch(tts.sentences[tts.i + 1]?.text);
      touchActivity();
      let ok;
      try { ok = await ai.speak(cur.text); } catch (e) { toast(e.message, { error: true }); stopTts(); return; }
      if (!tts || token !== tts.token || !tts.playing) return;
      if (ok) { tts.i++; tts.fails = 0; continue; }
      // 没读完：可能是改了语速被打断（重读这一句），也可能是引擎出错（连续几次就停下）
      if (++tts.fails > 3) { toast('朗读出错了，请检查设置 → 听书', { error: true }); stopTts(); return; }
    }
  }
  function pauseTts() { if (!tts) return; tts.playing = false; tts.token++; ai.stopSpeaking(); drawPlayer(); }
  function resumeTts() { if (!tts) return; tts.playing = true; drawPlayer(); loopTts(); }
  function stopTts() {
    if (!tts) return;
    tts.token++; tts = null;
    ai.stopSpeaking();
    setTempHighlight('shl-tts', null);
    drawPlayer();
  }

  // ---------- 手势：翻页模式由盖在书页上的一层处理 ----------
  let down = null, pressTimer = null;
  function beginSelectAt(lx, ly) {
    const off = caretAt(lx, ly);
    if (!onText(lx, ly, off)) return false;
    const [a, b] = unitBounds(off);
    navigator.vibrate?.(8);
    toggleChrome(false);
    selectRange(a, b);
    if (sel) sel.origin = off;
    return true;
  }
  function extendSelectionTo(lx, ly) {
    if (!sel || sel.mark) return;
    const off = caretAt(lx, ly);
    if (off == null) return;
    if (!sel.anchor) sel.anchor = [sel.start, sel.end];
    const [a0, b0] = sel.anchor;
    if (off >= a0) { sel.start = a0; sel.end = Math.max(b0, off + 1); } else { sel.start = off; sel.end = b0; }
    drawSelection(false);
  }
  touch.addEventListener('pointerdown', (e) => {
    if (!e.isPrimary || e.button !== 0) return;
    down = { x: e.clientX, y: e.clientY, t: Date.now(), dragging: false, selecting: false };
    try { touch.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
    clearTimeout(pressTimer);
    pressTimer = setTimeout(() => { // 长按：插画就放大看，文字就开始选
      if (!down || down.dragging) return;
      const [lx, ly] = local(down.x, down.y);
      const src = imageOf(hitAt(down.x, down.y));
      if (src) { down = null; imageViewer(src); return; }
      if (beginSelectAt(lx, ly)) { down.selecting = true; selMenu.hidden = true; }
    }, 420);
  });
  touch.addEventListener('pointermove', (e) => {
    if (!e.isPrimary || !down || busy) return;
    if (down.selecting) { extendSelectionTo(...local(e.clientX, e.clientY)); return; }
    const dx = e.clientX - down.x, dy = e.clientY - down.y;
    if (!down.dragging && Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy)) {
      down.dragging = true; clearTimeout(pressTimer); slideToken++; clearSelection();
      // 仿真翻页：纸角跟着手指走（章节首尾这一下翻不了，松手时照常换章）
      if (curlWanted()) {
        if (curl.active && !curlDrag) { curlSeq++; curl.end(); frameWin()?.scrollTo(page * W, 0); }
        const [lx, ly] = local(down.x, down.y);
        down.curl = curlDragBegin(dx < 0 ? 1 : -1, lx, ly);
      }
    } else if (Math.abs(dy) > 10) clearTimeout(pressTimer);
    if (down.curl) { curl.dragTo(...local(e.clientX, e.clientY)); return; }
    if (down.dragging && turnStyle() === 'slide' && !isVertical()) { // 书页跟着手指走
      const max = (pages - 1) * W;
      frameWin().scrollTo(Math.min(max, Math.max(0, page * W - dx)), 0);
    }
  });
  touch.addEventListener('pointerup', (e) => {
    if (!e.isPrimary) return;
    clearTimeout(pressTimer);
    if (!down) return;
    const d = down;
    down = null;
    if (d.selecting) { if (sel) { delete sel.anchor; drawSelection(); } return; }
    const dx = e.clientX - d.x, dy = e.clientY - d.y, quick = Date.now() - d.t < 300;
    if (d.curl) { toggleChrome(false); curlDragEnd(quick && Math.abs(dx) > 30); return; }
    if (d.dragging) {
      toggleChrome(false);
      // 手指往左拖 = 把右边的内容拉进来；竖排时右边是上一页
      if (Math.abs(dx) > Math.min(90, W * 0.2) || (quick && Math.abs(dx) > 30)) { if (dx < 0) rightward(); else leftward(); }
      else show(page, false, turnStyle() === 'slide'); // 没拖够，弹回去
      return;
    }
    if (Math.abs(dx) + Math.abs(dy) > 12) return;
    tapAt(...local(e.clientX, e.clientY), hitAt(e.clientX, e.clientY));
  });
  touch.addEventListener('pointercancel', (e) => {
    if (!e.isPrimary) return;
    clearTimeout(pressTimer);
    if (down?.curl) curlDragEnd(false); else if (down?.dragging) show(page, false);
    down = null;
  });
  touch.addEventListener('dblclick', (e) => { // 电脑上：双击插画放大，双击文字选词
    const src = imageOf(hitAt(e.clientX, e.clientY));
    if (src) { toggleChrome(false); imageViewer(src); return; }
    beginSelectAt(...local(e.clientX, e.clientY));
  });
  touch.addEventListener('contextmenu', (e) => e.preventDefault());
  // 双击后浏览器会选中文字，再拖动就变成“拖拽选区”而打断翻页，这里一并禁掉
  touch.addEventListener('dragstart', (e) => e.preventDefault());
  touch.addEventListener('mousedown', (e) => e.preventDefault());

  // 拖动选区两端的拖柄
  for (const [knob, which] of [[knobA, 'start'], [knobB, 'end']]) {
    knob.addEventListener('pointerdown', (e) => {
      e.stopPropagation(); e.preventDefault();
      knob.setPointerCapture(e.pointerId);
      selMenu.hidden = true;
      const move = (ev) => {
        const [lx, ly] = local(ev.clientX, ev.clientY - 14);
        const off = caretAt(lx, ly);
        if (off == null || !sel) return;
        if (which === 'start') sel.start = Math.min(off, sel.end - 1); else sel.end = Math.max(off + 1, sel.start + 1);
        drawSelection(false);
      };
      const up = () => { knob.removeEventListener('pointermove', move); drawSelection(); };
      knob.addEventListener('pointermove', move);
      knob.addEventListener('pointerup', up, { once: true });
      knob.addEventListener('pointercancel', up, { once: true });
    });
  }

  let lastWheel = 0;
  touch.addEventListener('wheel', (e) => {
    e.preventDefault();
    const now = Date.now();
    if (now - lastWheel < 220 || Math.abs(e.deltaY) + Math.abs(e.deltaX) < 4) return;
    lastWheel = now;
    if (e.deltaY + e.deltaX > 0) next(); else prev();
  }, { passive: false });

  // 上下滚动模式：书页自己滚动，点按和长按从书页里来（坐标已是书页坐标）
  let docDown = null, docPress = null;
  function onDocDown(e) {
    if (!isScroll() || e.button > 0) return;
    docDown = { x: e.clientX, y: e.clientY, selecting: false, target: e.target };
    clearTimeout(docPress);
    docPress = setTimeout(() => {
      if (!docDown) return;
      if (imageOf(docDown.target)) { imageViewer(imageOf(docDown.target)); docDown = null; return; }
      if (beginSelectAt(docDown.x, docDown.y)) { docDown.selecting = true; selMenu.hidden = true; }
    }, 420);
  }
  function onDocMove(e) {
    if (!docDown) return;
    if (docDown.selecting) { e.preventDefault(); extendSelectionTo(e.clientX, e.clientY); return; }
    if (Math.abs(e.clientX - docDown.x) + Math.abs(e.clientY - docDown.y) > 10) { clearTimeout(docPress); docDown = null; }
  }
  function onDocUp(e) {
    clearTimeout(docPress);
    const d = docDown;
    docDown = null;
    if (!d || !isScroll()) return;
    if (d.selecting) { if (sel) { delete sel.anchor; drawSelection(); } return; }
    tapAt(e.clientX, e.clientY, e.target);
  }
  let scrollTick = false, saveTimer = null;
  function onDocScroll() {
    if (!isScroll() || busy || scrollTick) return;
    scrollTick = true;
    requestAnimationFrame(() => {
      scrollTick = false;
      if (destroyed || !isScroll()) return;
      if (sel) drawSelection(!selMenu.hidden);
      refresh(false);
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => { if (!destroyed && isScroll()) refresh(true); }, 500);
    });
  }

  function onKey(e) {
    if (document.querySelector('dialog[open], .viewer')) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); openSearch(); return; }
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName);
    if (typing && !(e.key === 'Escape' && panelOpen())) return; // 输入框里按 Esc 也能关掉面板
    if (e.key === 'Escape') {
      if (autoTimer) stopAuto(); else if (sel) clearSelection(); else if (panelOpen()) closePanels(); else if (chromeOpen()) toggleChrome(false); else if (tts) stopTts(); else onExit();
      return;
    }
    if (panelOpen()) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); leftward(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); rightward(); }
    else if (['PageDown', ' ', 'ArrowDown'].includes(e.key)) { e.preventDefault(); next(); }
    else if (['PageUp', 'ArrowUp'].includes(e.key)) { e.preventDefault(); prev(); }
  }
  window.addEventListener('keydown', onKey);

  // 安卓音量键翻页：原生层把按键转成 volumekey 事件
  function onVolume(e) {
    if (panelOpen() || document.querySelector('dialog[open], .viewer')) return;
    if (e.detail === 'down') next(); else prev();
  }
  const native = window.SusukoNative;
  const syncVolumeKeys = (on) => { try { native?.setVolumeKeys(!!on); } catch { /* 网页版没有原生层 */ } };
  window.addEventListener('volumekey', onVolume);
  syncVolumeKeys(settings.volumeKeys);

  slider.addEventListener('input', () => { // 拖动时预览会跳到哪一章
    const n = tocIndex(epub.locate(slider.value / 1000).index);
    dockChapter.textContent = n < 0 ? title : epub.toc[n].label;
    dockPercent.textContent = `${Math.round(slider.value / 10)}%`;
    slider.style.setProperty('--v', `${slider.value / 10}%`);
  });
  slider.addEventListener('change', () => {
    const to = epub.locate(slider.value / 1000);
    load(to.index, { fraction: to.fraction });
  });

  let resizeTimer = null, firstResize = true;
  const observer = new ResizeObserver(() => {
    if (firstResize) { firstResize = false; return; }
    clearTimeout(resizeTimer); resizeTimer = setTimeout(() => relayout(false), 120);
  });
  observer.observe(frame.parentElement);

  // ---------- 目录 ----------
  function markToc() {
    const current = tocIndex();
    [...tocList.children].forEach((el, n) => el.classList.toggle('is-current', n === current));
  }
  if (epub.toc.length) {
    tocList.replaceChildren(...epub.toc.map((t) => h('button.toc-item', {
      type: 'button', style: `--depth:${Math.min(t.depth, 3)}`,
      onclick: () => { closePanels(); load(t.index, { hash: t.hash }, true, Math.sign(t.index - index)); },
    }, t.label)));
  } else tocList.append(h('p.panel-note', '这本书没有目录。'));

  // ---------- 书签与页笔记 ----------
  function excerptNow() { // 当前画面开头的一小段文字，用来在列表里认出这个位置
    const off = firstVisibleOffset();
    return tmap.text.slice(off, off + 60).replace(/\s+/g, ' ').trim();
  }
  const bookmarkHere = () => {
    const [from, to] = spanNow();
    return marksOf(book.id).find((m) => m.type === 'bookmark' && m.loc?.index === index && m.loc.fraction >= from - 1e-6 && m.loc.fraction < to - 1e-6);
  };
  function drawBookmarkState() {
    const on = !!bookmarkHere();
    pageMark.hidden = !on;
    markBtn.replaceChildren(icon(on ? 'bookmarkOn' : 'bookmark'));
    markBtn.classList.toggle('is-on', on);
    const label = on ? '取消这一页的书签' : '给这一页加书签';
    markBtn.title = label; markBtn.setAttribute('aria-label', label);
  }
  const markHere = (extra) => ({ loc: { index, fraction: fractionNow() }, percent: lastPercent, chapter: chapterTitle(), excerpt: excerptNow(), ...extra });
  function toggleBookmark() {
    const existing = bookmarkHere();
    if (existing) { removeMark(book.id, existing.id); toast('已取消书签'); }
    else { saveMark(book.id, markHere({ type: 'bookmark' })); toast('已加书签'); }
    drawBookmarkState();
    if (!sheet.hidden) drawSheet();
  }
  function editNote(existing) {
    const base = existing || markHere({ type: 'note' });
    return dialog(existing ? '修改笔记' : '写笔记', (close) => {
      const area = h('textarea.field.is-area', { value: base.text || '', rows: 5, maxLength: 5000, placeholder: '在这里写下想法…' });
      setTimeout(() => area.focus(), 40);
      return h('form.dialog-body', {
        onsubmit: (e) => {
          e.preventDefault();
          if (!area.value.trim()) { area.focus(); return; }
          saveMark(book.id, { ...base, text: area.value.trim() });
          close(); toast(existing ? '笔记已修改' : '笔记已保存');
          if (!sheet.hidden) drawSheet();
        },
      },
      h('p.note-where', `${base.chapter}　${fmtPercent(Math.max(base.percent, 0.01))}`),
      base.excerpt && h('blockquote.note-quote', base.excerpt + '…'),
      area,
      h('div.dialog-actions',
        h('button.btn', { type: 'button', onclick: () => close() }, '取消'),
        h('button.btn.is-primary', { type: 'submit' }, '保存')));
    });
  }
  function jumpToMark(m) {
    closePanels();
    const i = Number.isInteger(m.loc?.index) && m.loc.index < epub.spine.length ? m.loc.index : 0;
    const where = m.loc?.start != null ? { offset: m.loc.start } : { fraction: Number(m.loc?.fraction) || 0 };
    load(i, where, true, Math.sign(i - index)).then(() => { if (m.type === 'highlight') flashMark(m); });
  }
  function markList(types) {
    const list = marksOf(book.id).filter((m) => types.includes(m.type));
    if (!list.length) {
      return h('p.panel-note', types.includes('bookmark') ? '还没有书签。翻到想记住的地方，点上面的按钮。' : '还没有划线和笔记。长按文字可以划线、写批注；也可以在这一页写笔记。');
    }
    return h('div.mark-list', list.map((m) => h('div.mark-item', { style: `--hl:${HL_COLORS[m.color] || 'transparent'}` },
      h('button.mark-main' + (m.type === 'highlight' ? '.is-hl' : ''), { type: 'button', onclick: () => jumpToMark(m) },
        h('span.mark-title', m.chapter || title),
        m.type === 'highlight' ? h('span.mark-quote', m.excerpt) : m.excerpt && h('span.mark-excerpt', m.excerpt + '…'),
        m.text && h('span.mark-text', m.text),
        h('span.mark-meta', `${{ highlight: '划线', note: '笔记', bookmark: '书签' }[m.type]}　${fmtPercent(Math.max(m.percent, 0.01))}　${new Date(m.createdAt).toLocaleDateString()}`)),
      m.type !== 'bookmark' && h('button.icon-btn', { type: 'button', 'aria-label': '修改', onclick: () => (m.type === 'highlight' ? annotate(m) : editNote(m)) }, icon('pen', 18)),
      h('button.icon-btn', { type: 'button', 'aria-label': '删除', onclick: () => { removeMark(book.id, m.id); paintHighlights(); drawSheet(); drawBookmarkState(); } }, icon('trash', 18)))));
  }

  // ---------- 设置面板（排版 / 操作 / 书签 / 标记） ----------
  let tab = 'type', relayoutQueued = false, adjustTimer = null;
  function openSheet(which) { tab = which; drawSheet(); openPanel(sheet); }
  const LAYOUT_KEYS = ['fontSize', 'lineHeight', 'marginPx', 'para', 'font', 'writing', 'flow', 'spread'];
  function change(patch, redraw = true) {
    const before = { ...settings };
    Object.assign(settings, patch);
    prefs.set('reader', settings);
    applyPaper();
    if ('turn' in patch) { if (curl.active) curl.end(); scheduleGhost(); }
    const layoutChanged = LAYOUT_KEYS.some((k) => k in patch && patch[k] !== before[k]);
    const colorChanged = ('paper' in patch && patch.paper !== before.paper) || ('hlStyle' in patch && patch.hlStyle !== before.hlStyle) || ('book' in patch && patch.book !== before.book);
    if (layoutChanged || colorChanged) {
      if (!relayoutQueued) {
        relayoutQueued = true;
        requestAnimationFrame(() => {
          relayoutQueued = false;
          if (destroyed) return;
          // 颜色变化靠 CSS 过渡慢慢变；排版变化用文字淡开再浮现
          if (layoutChanged && !frame.classList.contains('is-adjusting')) relayout(true); else relayout(false);
        });
      }
    }
    if (redraw) drawSheet();
  }
  /** 拖滑杆时：书页轻微模糊着实时重排，松手后清晰回来 */
  function adjusting(on) {
    clearTimeout(adjustTimer);
    if (on) frame.classList.add('is-adjusting');
    else adjustTimer = setTimeout(() => frame.classList.remove('is-adjusting'), 60);
  }
  function drawSheet() {
    const seg = (label, key, options, hint) => h('div.sheet-row', h('span.sheet-label', label, hint && h('small', hint)),
      h('div.segmented', { role: 'group', 'aria-label': label }, options.map(([value, text]) => h('button' + (settings[key] === value ? '.is-on' : ''), {
        type: 'button', onclick: () => change({ [key]: value }),
      }, text))));
    const range = (label, key, min, max, step, fmt) => {
      const value = h('span.range-value', fmt(settings[key]));
      const input = h('input.reader-slider', { type: 'range', min, max, step, value: settings[key], 'aria-label': label });
      const fill = () => input.style.setProperty('--v', `${((input.value - min) / (max - min)) * 100}%`);
      fill();
      input.addEventListener('pointerdown', () => adjusting(true));
      input.addEventListener('input', () => { const v = Number(input.value); value.textContent = fmt(v); fill(); adjusting(true); change({ [key]: v }, false); });
      input.addEventListener('change', () => adjusting(false));
      return h('div.range-row', h('div.range-head', h('span.sheet-label', label), value), input);
    };
    let body;
    if (tab === 'type') {
      body = [
        h('div.sheet-block', h('span.sheet-label', '阅读配色'),
          h('div.chips', [['auto', { name: '跟随外观', bg: 'linear-gradient(135deg,#FBFAF5 0 50%,#15171C 50% 100%)' }], ...Object.entries(PAPERS)].map(([k, p]) => h('button.chip' + (settings.paper === k ? '.is-on' : ''), {
            type: 'button', 'aria-pressed': String(settings.paper === k), onclick: () => change({ paper: k }),
          }, h('span.chip-dot', { style: `background:${p.bg}` }), p.name)))),
        range('字体大小', 'fontSize', 12, 34, 1, (v) => `${v} px`),
        range('行距', 'lineHeight', 1.2, 2.6, 0.05, (v) => `${v.toFixed(2)} 倍`),
        range('页边距', 'marginPx', 6, 60, 1, (v) => `${v} px`),
        range('段落间距', 'para', 0, 32, 1, (v) => (v ? `${v} px` : '跟随原书')),
        seg('字体', 'font', Object.entries(FONTS).map(([k, f]) => [k, f.name])),
      ];
    } else if (tab === 'act') {
      body = [
        seg('文字方向', 'writing', [['h', '横排'], ['v', '竖排']]),
        !isVertical() && seg('阅读方式', 'flow', [['paged', '左右翻页'], ['scroll', '上下滚动']]),
        !isScroll() && seg('翻页动画', 'turn', [['curl', '仿真'], ['rise', '逐段浮现'], ['float', '浮现'], ['slide', '滑动'], ['none', '无']]),
        !isScroll() && settings.turn === 'curl' && isVertical() && h('p.sheet-hint', '竖排时仿真翻页暂时用滑动代替'),
        !isScroll() && seg('纸质书效果', 'book', [[true, '开'], [false, '关']]),
        !isScroll() && settings.turn !== 'none' && seg('动画速度', 'turnSpeed', [[1.5, '舒缓'], [1, '标准'], [0.6, '利落']]),
        !isScroll() && seg('点屏幕两侧', 'tapMode', [['lr', '左右分别翻'], ['next', '都是下一页']]),
        seg('划线样式', 'hlStyle', [['line', '直线'], ['wave', '波浪线'], ['marker', '荧光笔']]),
        seg('长按选取', 'selUnit', [['word', '一个词'], ['sentence', '一句'], ['para', '一段']]),
        'vibrate' in navigator && seg('翻页轻震', 'haptic', [[true, '开'], [false, '关']]),
        h('div.sheet-row', h('span.sheet-label', '自动翻页'),
          h('div.auto-row',
            h('div.segmented', { role: 'group', 'aria-label': '自动翻页间隔' }, [15, 30, 60].map((v) => h('button' + (Number(settings.autoSec) === v ? '.is-on' : ''), {
              type: 'button', onclick: () => change({ autoSec: v }),
            }, `${v} 秒`))),
            h('button.btn.is-soft', { type: 'button', onclick: autoTimer ? stopAuto : startAuto }, autoTimer ? '停止' : '开始'))),
        !isScroll() && !isVertical() && seg('宽屏双页', 'spread', [[true, '开'], [false, '关']]),
        native && h('div.sheet-row', h('span.sheet-label', '音量键翻页'),
          h('div.segmented', { role: 'group', 'aria-label': '音量键翻页' }, [[true, '开'], [false, '关']].map(([v, text]) => h('button' + (settings.volumeKeys === v ? '.is-on' : ''), {
            type: 'button', onclick: () => { change({ volumeKeys: v }); syncVolumeKeys(v); },
          }, text)))),
        h('p.panel-note', `${settings.tapMode === 'next' ? '点屏幕左右两侧都翻到下一页，' : isVertical() ? '竖排时从右往左读：点屏幕左侧是下一页，右侧是上一页，' : '点屏幕两侧翻页，'}点中间呼出菜单。长按文字选取，选中后可以在菜单里切换词 / 句 / 段，拖动两端调整范围；按住插画可以放大。自动翻页时点一下屏幕就会停。`),
      ];
    } else if (tab === 'marks') {
      const on = !!bookmarkHere();
      body = [
        h('button.btn.is-block.is-soft', { type: 'button', onclick: toggleBookmark }, icon(on ? 'bookmarkOn' : 'bookmark', 18), on ? '取消这一页的书签' : '给这一页加书签'),
        markList(['bookmark']),
      ];
    } else {
      body = [
        h('button.btn.is-block.is-soft', { type: 'button', onclick: () => editNote() }, icon('pen', 18), '在这一页写笔记'),
        markList(['highlight', 'note']),
      ];
    }
    const tabs = [['type', '排版'], ['act', '操作'], ['marks', '书签'], ['notes', '标记']];
    sheet.replaceChildren(
      h('div.sheet-head', h('h2', '阅读设置'),
        h('button.icon-btn', { type: 'button', 'aria-label': '关闭', onclick: closePanels }, icon('close'))),
      h('div.sheet-tabs', { role: 'tablist' }, tabs.map(([k, text]) => h('button' + (tab === k ? '.is-on' : ''), {
        type: 'button', role: 'tab', 'aria-selected': String(tab === k), onclick: () => { tab = k; drawSheet(); },
      }, text))),
      h('div.sheet-body', body.filter(Boolean)));
  }
  // 别的设备同步来了新划线，或应用主题变了（“跟随外观”）
  const unsubscribe = onChange(() => { if (!destroyed) { drawBookmarkState(); paintHighlights(); } });
  const themeWatch = new MutationObserver(() => { if (settings.paper === 'auto') { applyPaper(); relayout(false); } });
  themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  // ---------- 打开到上次位置 ----------
  const loc = progress?.loc || {};
  const start = Number.isInteger(loc.index) && loc.index >= 0 && loc.index < epub.spine.length ? loc.index : 0;
  await load(start, loc.start != null ? { offset: loc.start } : { fraction: Number(loc.fraction) || 0 }, !!flash);
  if (flash) flashMark(marksOf(book.id).find((m) => m.id === flash));

  return {
    async destroy() {
      destroyed = true;
      stopTts(); stopAuto(); search.token++;
      aiAbort?.abort();
      observer.disconnect(); themeWatch.disconnect(); unsubscribe(); clock.stop();
      curl.end(); if (ghostState.url) URL.revokeObjectURL(ghostState.url);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('volumekey', onVolume);
      syncVolumeKeys(false);
      clearTimeout(resizeTimer); clearTimeout(saveTimer); clearTimeout(pressTimer); clearTimeout(docPress);
      document.querySelector('.viewer')?.remove();
      root.remove();
      await epub.close();
    },
  };
}
