// 漫画阅读器：CBZ / ZIP。翻页（可日漫右翻、宽屏双页）或下拉长条。
import { routeChip } from './cloud-direct.js';
import { ZipReader, mimeOf, isImageName } from './zip.js';
import { prefs, setProgress, natural, account, updateBook, remakeComicCover } from './store.js';
import { probeLayout, frontRect, halfRect, cropBlob } from './pagefit.js';
import { createW2x, w2xSupported, W2X_MODES, W2X_AHEAD } from './waifu2x.js';
import { h, icon, loader, toast, menuButton, statusClock } from './ui.js';

const DEFAULTS = { mode: 'page', rtl: true, spread: true, turn: 'slide', zoom: true, pageNum: true, applyAll: true, w2x: 'off', split: true };

export async function open({ host, book, title = book.title, source, progress, onExit }) {
  // 网盘里的图片文件夹本身就是一页一张图；压缩包则从里面挑出图片
  const zip = source.isPageList ? source : await ZipReader.open(source);
  const entries = zip.entries.filter((e) => !e.isDir && isImageName(e.name)).sort((a, b) => natural(a.name, b.name));
  if (!entries.length) throw new Error(source.isPageList ? '这个文件夹里没有图片' : '压缩包里没有图片');
  // 本机文件读得快，预读两页就够；从服务器或网盘取的要多预读几页，翻页时才不用等
  const remote = !(source instanceof Blob);
  const AHEAD = remote ? 5 : 2;
  // 阅读方式可以只对这一本生效（比如某本是条漫就用下拉，其余还是日漫翻页）
  const own = prefs.get('comicBooks', {})[book.id];
  const settings = { ...DEFAULTS, ...prefs.get('comic', {}), ...(own || {}), applyAll: !own };

  // ---------- 版面：跨页拼图拆成两页，整张书衣只显示正面 ----------
  // 版面串一页一个字符（p 单页 / w 两页拼图 / c 整张书衣），导入时识别好存在书上；老书第一次打开时识别一次
  let layout = book.pageLayout || '';
  if (layout.length !== entries.length && typeof zip.head === 'function') {
    layout = await probeLayout(zip, entries).catch(() => '');
    if (layout) {
      updateBook(book.id, { pageLayout: layout }).catch(() => {});
      if (layout[0] === 'c') remakeComicCover(book.id, 'front').catch(() => {}); // 以前导入的书，封面顺便裁成正面
    }
  }
  let pages = [], total = 0;
  function buildPages() {
    pages = [];
    entries.forEach((_, i) => {
      const k = settings.split ? layout[i] || 'p' : 'p';
      if (k === 'c') pages.push({ i, part: 'front' });
      else if (k === 'w') for (const part of settings.rtl ? ['R', 'L'] : ['L', 'R']) pages.push({ i, part }); // 日漫先读右半边
      else pages.push({ i, part: 'full' });
    });
    total = pages.length;
  }
  // 把“第几张图、哪半边”换算成现在的页序号（换了拆分设置或阅读方向后，停在同一处）
  function pageAt(entry, part) {
    let v = pages.findIndex((p) => p.i === entry && (!part || p.part === part));
    if (v < 0) v = pages.findIndex((p) => p.i >= entry);
    return v < 0 ? Math.max(0, total - 1) : v;
  }
  buildPages();
  const loc = progress?.loc || {};
  let page = loc.entry != null ? pageAt(Number(loc.entry) || 0, loc.part) : pageAt(Math.max(0, Number(loc.page) || 0));
  let destroyed = false, cleanupView = () => {};

  // ---------- 图片缓存 ----------
  const urls = new Map();
  const raw = new Map(); // 同一张图的两个半页共用一次读取
  function entryBlob(i) {
    if (!raw.has(i)) {
      raw.set(i, zip.blobOf(entries[i], mimeOf(entries[i].name)));
      raw.get(i).catch(() => raw.delete(i));
      if (raw.size > 6) raw.delete(raw.keys().next().value);
    }
    return raw.get(i);
  }
  async function pageBlob(v) {
    const p = pages[v];
    const blob = await entryBlob(p.i);
    if (p.part === 'full') return blob;
    return cropBlob(blob, (bmp) => (p.part === 'front' ? frontRect(bmp, settings.rtl) : halfRect(bmp, p.part)));
  }
  function urlOf(i) {
    if (!urls.has(i)) {
      const job = pageBlob(i).then((b) => URL.createObjectURL(b));
      urls.set(i, job);
      job.catch(() => { if (urls.get(i) === job) urls.delete(i); });
    }
    return urls.get(i);
  }
  // 画质增强好了的页优先用增强后的图
  const srcOf = (i) => { const u = w2x?.url(i); return u ? Promise.resolve(u) : urlOf(i); };
  function evict(keepAround, radius) {
    for (const [i, p] of urls) {
      if (Math.abs(i - keepAround) > radius) { urls.delete(i); p.then((u) => URL.revokeObjectURL(u)).catch(() => {}); }
    }
  }

  // ---------- 画质增强（waifu2x） ----------
  let w2x = null, w2xStatus = null;
  const w2xNote = h('small.w2x-note');
  function w2xText(st) {
    if (!st) return '';
    if (st.error) return `没能启动：${st.error}`;
    const be = st.backend === 'webgpu' ? '显卡（WebGPU）' : st.backend === 'wasm' ? 'CPU（较慢）' : '';
    const run = st.running != null ? `正在处理第 ${st.running + 1} 页` : st.queued ? '' : '后面几页都处理好了';
    return [be, run, st.queued ? `还有 ${st.queued} 页排队` : '', st.lastMs ? `上一页用时 ${(st.lastMs / 1000).toFixed(1)} 秒` : ''].filter(Boolean).join('，');
  }
  function startW2x() {
    w2x?.destroy(); w2x = null; w2xStatus = null;
    const conf = account();
    if (settings.w2x === 'off' || !W2X_MODES[settings.w2x] || !conf?.url || !w2xSupported()) { w2xNote.textContent = ''; return; }
    w2x = createW2x({
      server: conf.url, mode: settings.w2x,
      getBlob: (i) => pageBlob(i),
      onStatus: (st) => {
        w2xStatus = st; w2xNote.textContent = w2xText(st);
        if (st.error && !startW2x.warned) { startW2x.warned = true; toast('画质增强没能启动：' + st.error, { error: true }); }
      },
      onDone: (i, url) => { // 正在看的页处理好了，直接换上去
        for (const img of stage.querySelectorAll(`img[data-i="${i}"]`)) {
          const next = new Image(); next.src = url;
          next.decode().then(() => { if (img.isConnected) { img.src = url; img.classList.add('is-w2x'); } }).catch(() => {});
        }
      },
    });
    w2x.focus(page, total);
  }

  // ---------- 结构 ----------
  const stage = h('div.reader-stage');
  const footRight = h('span.foot-page');
  const slider = h('input.reader-slider', { type: 'range', min: 1, max: total, step: 1, 'aria-label': '页码' });
  const sliderLabel = h('span.dock-percent');
  const topSub = h('span.reader-sub');
  const fill = () => slider.style.setProperty('--v', `${total > 1 ? ((slider.value - 1) / (total - 1)) * 100 : 100}%`);
  const sheet = h('div.reader-sheet', { hidden: true });
  const scrim = h('div.reader-scrim', { hidden: true, onclick: closePanels });
  const clock = statusClock();
  const modeBtn = menuButton('scroll', '下拉', () => { toggleChrome(false); change({ mode: settings.mode === 'scroll' ? 'page' : 'scroll' }); });
  const drawModeBtn = () => modeBtn.replaceChildren(
    icon(settings.mode === 'scroll' ? 'pages' : 'scroll', 22), h('span', settings.mode === 'scroll' ? '改为翻页' : '改为下拉'));
  drawModeBtn();
  const root = h('div.reader.is-comic', { 'data-dark': 'true' },
    stage,
    h('footer.reader-foot', clock.el, h('span.foot-chapter', title), footRight),
    h('header.reader-top',
      h('button.icon-btn', { type: 'button', 'aria-label': '返回书架', onclick: onExit }, icon('back')),
      h('div.reader-heading', h('span.reader-title', title), topSub, routeChip(book) || '')),
    h('div.reader-bottom',
      h('div.dock-info', h('span.dock-chapter', '页码'), sliderLabel),
      h('div.bottom-row', slider),
      h('div.bottom-actions', modeBtn, menuButton('gear', '设置', openSheet))),
    scrim, sheet);
  root.style.setProperty('--paper', '#101114');
  root.style.setProperty('--paper-ink', '#C9CED9');
  root.style.setProperty('--paper-accent', '#F283A8');
  host.replaceChildren(root);

  const chromeOpen = () => root.classList.contains('is-chrome');
  const toggleChrome = (on = !chromeOpen()) => root.classList.toggle('is-chrome', on);
  function closePanels() { sheet.hidden = true; scrim.hidden = true; }
  function openSheet() { toggleChrome(false); drawSheet(); sheet.hidden = false; scrim.hidden = false; }

  function report(lastShown = page, save = true) {
    footRight.textContent = `${lastShown + 1} / ${total}`;
    slider.value = lastShown + 1; fill();
    sliderLabel.textContent = `${lastShown + 1} / ${total}`;
    topSub.textContent = `第 ${lastShown + 1} / ${total} 页`;
    if (save) setProgress(book.id, { page, entry: pages[page]?.i ?? page, part: pages[page]?.part }, (lastShown + 1) / total);
  }

  // ---------- 翻页模式 ----------
  // 三块面板并排：上一页 | 当前页 | 下一页。手指拖动时整条跟着走，松手后滑到位再换内容，
  // 所以翻页是真正“拉过来”的一页，而不是旧页消失再淡入新页。
  function mountPaged(save) {
    const cur = h('div.comic-page');
    const sideA = h('div.comic-page.is-side'), sideB = h('div.comic-page.is-side');
    const track = h('div.comic-track', sideA, cur, sideB);
    const touch = h('div.reader-touch');
    const spinner = h('div.comic-loader', { hidden: true }, loader('正在加载这一页'));
    stage.replaceChildren(track, spinner, touch);
    let token = 0, shown = -1, busy = false;
    const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const nextSide = () => (settings.rtl ? -1 : 1); // 下一页在屏幕哪一侧：日漫在左边
    const panelFor = (dir) => (dir * nextSide() > 0 ? sideB : sideA); // dir: +1 下一页，-1 上一页
    const place = () => { sideA.style.transform = 'translateX(calc(-100% - 24px))'; sideB.style.transform = 'translateX(calc(100% + 24px))'; };
    place();

    const spread = () => settings.spread && stage.clientWidth > stage.clientHeight * 1.15;
    // 双页时的分组：封面单独一页；从同一张拼图拆出的两半放回一起；其余单页两两成对
    const groupOf = [];
    for (let v = 0; v < total;) {
      const p = pages[v], q = pages[v + 1];
      const pair = v > 0 && q && (p.part === 'full' ? q.part === 'full' : (p.part === 'R' || p.part === 'L') && q.i === p.i);
      const g = pair ? [v, v + 1] : [v];
      for (const x of g) groupOf[x] = g;
      v += g.length;
    }
    function group(p) { // 当前画面显示哪几页
      return spread() ? groupOf[p] || [p] : [p];
    }
    const targetOf = (dir) => {
      const g = group(page);
      if (dir > 0) return g[g.length - 1] + 1 < total ? g[g.length - 1] + 1 : null;
      return g[0] > 0 ? group(g[0] - 1)[0] : null;
    };
    async function fillPanel(panel, p) {
      const g = group(p);
      panel.dataset.page = String(g[0]);
      const srcs = await Promise.all(g.map(srcOf)).catch(() => null);
      if (!srcs || panel.dataset.page !== String(g[0])) return false;
      const imgs = srcs.map((src, n) => h('img' + (w2x?.url(g[n]) === src ? '.is-w2x' : ''), { src, alt: `第 ${g[n] + 1} 页`, draggable: false, 'data-i': g[n] }));
      await Promise.all(imgs.map((im) => im.decode().catch(() => {}))); // 先在后台解码，滑过来时不会顿
      if (panel.dataset.page !== String(g[0])) return false;
      panel.classList.toggle('is-rtl', settings.rtl);
      panel.replaceChildren(...imgs);
      return true;
    }
    function prepareSides() {
      for (const dir of [1, -1]) {
        const t = targetOf(dir), panel = panelFor(dir);
        if (t == null) { panel.replaceChildren(); panel.dataset.page = ''; continue; }
        if (panel.dataset.page !== String(group(t)[0])) { panel.replaceChildren(); fillPanel(panel, t); }
      }
    }
    async function render(saveNow = true) {
      const t = ++token;
      const g = group(page);
      page = g[0];
      for (let i = g[g.length - 1] + 1; i <= Math.min(total - 1, g[g.length - 1] + AHEAD); i++) urlOf(i); // 先把后面几页排上队
      report(g[g.length - 1], saveNow);
      w2x?.focus(page, total);
      if (cur.dataset.page !== String(page) || !cur.childElementCount) {
        // 这一页还没取到时，过一小会儿显示“正在加载”，不让画面看起来卡住
        const wait = setTimeout(() => { if (t === token) { cur.classList.add('is-loading'); spinner.hidden = false; } }, 150);
        const ok = await fillPanel(cur, page);
        clearTimeout(wait);
        if (t !== token || destroyed) return;
        cur.classList.remove('is-loading'); spinner.hidden = true;
        if (!ok) { toast('这一页读不出来，可能是网络断了', { error: true }); return; }
        const turn = settings.turn;
        if (shown >= 0 && shown !== page && !calm && turn === 'fade') cur.animate([{ opacity: 0.2 }, { opacity: 1 }], { duration: 200, easing: 'ease-out' });
      }
      shown = page;
      resetZoom();
      prepareSides();
      if (g[0] > 0) urlOf(g[0] - 1); // 往回翻一页也常见
      evict(page, AHEAD + 6);
    }
    // 滑到相邻那一页：from 是松手时已经拖出去的距离（像素）
    async function turn(dir, from = 0) {
      const target = targetOf(dir);
      if (target == null) {
        if (from) track.animate([{ transform: `translateX(${from}px)` }, { transform: 'none' }], { duration: 220, easing: 'ease-out' });
        toast(dir > 0 ? '已经是最后一页了' : '已经是第一页了');
        return;
      }
      if (busy) return;
      const W = stage.clientWidth + 24;
      const panel = panelFor(dir);
      if (settings.turn === 'slide' && !calm) {
        busy = true;
        const to = -dir * nextSide() * W;
        const left = Math.abs(to - from) / W;
        await track.animate([{ transform: `translateX(${from}px)` }, { transform: `translateX(${to}px)` }],
          { duration: Math.max(140, 300 * left), easing: 'cubic-bezier(.2,.7,.25,1)' }).finished.catch(() => {});
        busy = false;
        if (destroyed) return;
        // 滑到位后：把旁边面板里已经画好的页搬到中间，再把整条移回原位，画面不会闪
        if (panel.dataset.page === String(group(target)[0]) && panel.childElementCount) {
          cur.replaceChildren(...panel.children); cur.dataset.page = panel.dataset.page; cur.classList.toggle('is-rtl', settings.rtl);
          panel.dataset.page = '';
        }
      }
      track.style.transform = '';
      page = target;
      render();
    }
    const next = () => turn(1);
    const prev = () => turn(-1);
    const leftward = () => turn(-nextSide());
    const rightward = () => turn(nextSide());

    // ---- 双击放大 ----
    let zoom = { s: 1, x: 0, y: 0 };
    function applyZoom(animated) {
      const tf = zoom.s === 1 ? '' : `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.s})`;
      if (animated) cur.animate([{ transform: cur.style.transform || 'none' }, { transform: tf || 'none' }], { duration: 200, easing: 'ease-out' });
      cur.style.transform = tf;
      root.classList.toggle('is-zoomed', zoom.s > 1);
    }
    function resetZoom(animated = false) { if (zoom.s !== 1) { zoom = { s: 1, x: 0, y: 0 }; applyZoom(animated); } }
    function clampZoom() {
      const mx = (stage.clientWidth * (zoom.s - 1)) / 2, my = (stage.clientHeight * (zoom.s - 1)) / 2;
      zoom.x = Math.max(-mx, Math.min(mx, zoom.x)); zoom.y = Math.max(-my, Math.min(my, zoom.y));
    }
    function toggleZoom(cx, cy) {
      if (zoom.s > 1) { resetZoom(true); return; }
      const r = stage.getBoundingClientRect();
      zoom.s = 2.2;
      zoom.x = (r.width / 2 - (cx - r.left)) * (zoom.s - 1); zoom.y = (r.height / 2 - (cy - r.top)) * (zoom.s - 1); // 点哪里就放大哪里
      clampZoom(); applyZoom(true);
    }

    // ---- 手势：拖动翻页 / 放大后拖动查看 / 点按 ----
    let down = null, tapTimer = null, lastTap = 0;
    touch.addEventListener('pointerdown', (e) => {
      if (!e.isPrimary || e.button !== 0 || busy) return;
      down = { x: e.clientX, y: e.clientY, zx: zoom.x, zy: zoom.y, dragging: false, t: performance.now() };
      touch.setPointerCapture?.(e.pointerId);
      if (zoom.s === 1) prepareSides();
    });
    touch.addEventListener('pointermove', (e) => {
      if (!e.isPrimary || !down) return;
      const dx = e.clientX - down.x, dy = e.clientY - down.y;
      if (zoom.s > 1) { zoom.x = down.zx + dx; zoom.y = down.zy + dy; clampZoom(); applyZoom(false); down.dragging = Math.abs(dx) + Math.abs(dy) > 6; return; }
      if (!down.dragging && Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) { down.dragging = true; toggleChrome(false); }
      if (down.dragging && settings.turn === 'slide' && !calm) {
        // 拖到没有页的一侧时加阻尼，提示到头了
        const dir = -Math.sign(dx) * nextSide();
        const edge = targetOf(dir) == null;
        track.style.transform = `translateX(${edge ? dx * 0.25 : dx}px)`;
      }
    });
    const end = (e) => {
      if (!e.isPrimary || !down) return;
      const dx = e.clientX - down.x, dy = e.clientY - down.y, dt = performance.now() - down.t;
      const d = down; down = null;
      if (zoom.s > 1) { if (!d.dragging) tap(e); return; }
      if (d.dragging) {
        const fast = Math.abs(dx) / Math.max(1, dt) > 0.45; // 甩一下也算
        if (Math.abs(dx) > stage.clientWidth * 0.18 || (fast && Math.abs(dx) > 30)) turn(-Math.sign(dx) * nextSide(), settings.turn === 'slide' ? dx : 0);
        else if (settings.turn === 'slide') track.animate([{ transform: `translateX(${dx}px)` }, { transform: 'none' }], { duration: 200, easing: 'ease-out' }).finished.then(() => { track.style.transform = ''; }).catch(() => {});
        track.style.transform = '';
        return;
      }
      if (Math.abs(dx) + Math.abs(dy) > 12) return;
      tap(e);
    };
    touch.addEventListener('pointerup', end);
    touch.addEventListener('pointercancel', (e) => {
      if (!e.isPrimary) return;
      down = null;
      track.style.transform = '';
    });
    function tap(e) {
      const now = performance.now();
      if (settings.zoom && now - lastTap < 280) { clearTimeout(tapTimer); lastTap = 0; toggleZoom(e.clientX, e.clientY); return; }
      lastTap = now;
      const act = () => {
        if (zoom.s > 1) return; // 放大时单击不翻页，免得看细节时误翻
        if (chromeOpen()) { toggleChrome(false); return; }
        const rect = touch.getBoundingClientRect();
        const x = (e.clientX - rect.left) / rect.width;
        if (x < 0.3) leftward(); else if (x > 0.7) rightward(); else toggleChrome(true);
      };
      if (settings.zoom) tapTimer = setTimeout(act, 260); else act(); // 开了双击放大，单击要稍等一下看是不是双击
    }
    let lastWheel = 0;
    touch.addEventListener('wheel', (e) => {
      e.preventDefault();
      const now = Date.now();
      if (now - lastWheel < 260 || Math.abs(e.deltaY) < 4) return;
      lastWheel = now;
      if (e.deltaY > 0) next(); else prev();
    }, { passive: false });

    const onKey = (key) => {
      if (key === 'ArrowLeft') leftward();
      else if (key === 'ArrowRight') rightward();
      else if ([' ', 'PageDown', 'ArrowDown'].includes(key)) next();
      else if (['PageUp', 'ArrowUp'].includes(key)) prev();
      else return false;
      return true;
    };
    let wasSpread = spread();
    const observer = new ResizeObserver(() => { if (spread() !== wasSpread) { wasSpread = spread(); cur.dataset.page = ''; sideA.dataset.page = ''; sideB.dataset.page = ''; render(false); } });
    observer.observe(stage);
    render(save);
    return { goto: (p) => { page = p; render(); }, onKey, cleanup: () => { observer.disconnect(); clearTimeout(tapTimer); root.classList.remove('is-zoomed'); } };
  }

  // ---------- 下拉模式 ----------
  function mountScroll(save) {
    const scroller = h('div.comic-scroll');
    const items = pages.map((_, i) => h('div.comic-strip', { 'data-i': i }));
    scroller.append(...items);
    stage.replaceChildren(scroller);

    const loader = new IntersectionObserver((list) => {
      for (const entry of list) {
        const el = entry.target, i = Number(el.dataset.i);
        if (entry.isIntersecting && !el.firstChild) {
          srcOf(i).then((src) => {
            if (destroyed || el.firstChild) return;
            const img = h('img' + (w2x?.url(i) === src ? '.is-w2x' : ''), { src, alt: `第 ${i + 1} 页`, draggable: false, 'data-i': i });
            img.addEventListener('load', () => { el.style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`; }, { once: true });
            el.append(img);
          }).catch(() => {});
        }
      }
    }, { root: scroller, rootMargin: remote ? '400% 0px' : '150% 0px' });
    items.forEach((el) => loader.observe(el));

    let ticking = false;
    function track() {
      ticking = false;
      const mid = scroller.scrollTop + scroller.clientHeight * 0.4;
      let lo = 0, hi = total - 1;
      while (lo < hi) { // 二分找到视口里的那一页
        const m = (lo + hi) >> 1;
        if (items[m].offsetTop + items[m].offsetHeight < mid) lo = m + 1; else hi = m;
      }
      const atEnd = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4;
      const now = atEnd ? total - 1 : lo;
      if (now !== page) {
        page = now; report(page); w2x?.focus(page, total);
        for (const [i] of urls) { // 离得远的页释放内存，保留占位高度
          if (Math.abs(i - page) > 8 && items[i].firstChild) items[i].replaceChildren();
        }
        evict(page, 8);
      }
    }
    scroller.addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(track); } }, { passive: true });
    let down = null;
    scroller.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
    scroller.addEventListener('click', (e) => {
      if (down && Math.abs(e.clientX - down.x) + Math.abs(e.clientY - down.y) < 10) toggleChrome();
    });

    const jump = (p) => { items[p].scrollIntoView({ block: 'start' }); };
    requestAnimationFrame(() => { if (page > 0) jump(page); report(page, save); w2x?.focus(page, total); });
    const step = (dir) => scroller.scrollBy({ top: dir * scroller.clientHeight * 0.85, behavior: 'smooth' });
    const onKey = (key) => {
      if ([' ', 'PageDown', 'ArrowDown', 'ArrowRight'].includes(key)) step(1);
      else if (['PageUp', 'ArrowUp', 'ArrowLeft'].includes(key)) step(-1);
      else return false;
      return true;
    };
    return { goto: (p) => { page = p; jump(p); report(p); }, onKey, cleanup: () => loader.disconnect() };
  }

  let viewApi = null;
  function mount(save = false) {
    cleanupView();
    viewApi = settings.mode === 'scroll' ? mountScroll(save) : mountPaged(save);
    cleanupView = viewApi.cleanup;
  }

  // ---------- 通用操作 ----------
  function onKey(e) {
    if (document.querySelector('dialog[open]')) return;
    if (e.key === 'Escape') { if (!scrim.hidden) closePanels(); else if (chromeOpen()) toggleChrome(false); else onExit(); return; }
    if (!scrim.hidden || e.target === slider) return;
    if (viewApi.onKey(e.key)) e.preventDefault();
  }
  window.addEventListener('keydown', onKey);
  // 安卓音量键翻页
  const onVolume = (e) => { if (scrim.hidden) viewApi.onKey(e.detail === 'down' ? 'PageDown' : 'PageUp'); };
  const volumeOn = prefs.get('reader', {}).volumeKeys !== false;
  window.addEventListener('volumekey', onVolume);
  try { window.SusukoNative?.setVolumeKeys(volumeOn); } catch { /* 网页版没有原生层 */ }
  slider.addEventListener('input', () => { sliderLabel.textContent = `${slider.value} / ${total}`; fill(); });
  slider.addEventListener('change', () => viewApi.goto(Number(slider.value) - 1));

  function change(patch) {
    Object.assign(settings, patch);
    const { applyAll, ...rest } = settings;
    const books = { ...prefs.get('comicBooks', {}) };
    if (applyAll) { prefs.set('comic', rest); delete books[book.id]; }
    else books[book.id] = { mode: rest.mode, rtl: rest.rtl }; // 只对这本：只记阅读方式，其他设置仍然全局
    prefs.set('comicBooks', books);
    if (!applyAll) prefs.set('comic', { ...prefs.get('comic', {}), turn: rest.turn, zoom: rest.zoom, pageNum: rest.pageNum, spread: rest.spread, w2x: rest.w2x, split: rest.split });
    root.classList.toggle('no-pagenum', !settings.pageNum);
    if ('w2x' in patch) { startW2x.warned = false; startW2x(); drawSheet(); return; }
    if ('split' in patch || 'rtl' in patch) {
      // 页序变了：按原来看到的那张图重新定位，缓存清掉重来
      const at = pages[page];
      buildPages();
      page = at ? pageAt(at.i, at.part === 'front' || at.part === 'full' ? null : at.part) : 0;
      for (const u of urls.values()) u.then((x) => URL.revokeObjectURL(x)).catch(() => {});
      urls.clear();
      slider.max = total;
      startW2x();
    }
    if ('turn' in patch || 'zoom' in patch || 'pageNum' in patch || 'applyAll' in patch) { drawSheet(); return; }
    mount(); drawSheet(); drawModeBtn();
  }
  function drawSheet() {
    const seg = (label, key, options) => h('div.sheet-row', h('span.sheet-label', label),
      h('div.segmented', { role: 'group', 'aria-label': label }, options.map(([value, text]) => h('button' + (settings[key] === value ? '.is-on' : ''), {
        type: 'button', onclick: () => change({ [key]: value }),
      }, text))));
    const modeNow = settings.mode === 'scroll' ? 'scroll' : settings.rtl ? 'rtl' : 'ltr';
    const modeCard = (key, ic, label, patch) => h('button.mode-card' + (modeNow === key ? '.is-on' : ''), {
      type: 'button', 'aria-pressed': String(modeNow === key), onclick: () => change(patch),
    }, icon(ic, 22), h('span', label));
    const toggleRow = (label, key, sub) => h('label.sheet-row.is-toggle', h('span.sheet-label', label, sub && h('small', sub)),
      h('input.switch', { type: 'checkbox', checked: !!settings[key], onchange: (e) => change({ [key]: e.target.checked }) }));
    const rows = [
      h('div.sheet-row.is-modes', h('span.sheet-label', '阅读模式'),
        h('div.mode-cards', modeCard('ltr', 'next', '普通模式', { mode: 'page', rtl: false }),
          modeCard('rtl', 'prev', '日漫模式', { mode: 'page', rtl: true }),
          modeCard('scroll', 'scroll', '滚动模式', { mode: 'scroll' }))),
      toggleRow('阅读模式对所有漫画生效', 'applyAll', '关掉后，上面的阅读模式只对这一本生效'),
    ];
    if (settings.mode === 'page') {
      rows.push(seg('翻页动画', 'turn', [['slide', '左右滑动'], ['fade', '淡入'], ['none', '无']]),
        seg('宽屏双页', 'spread', [[true, '开'], [false, '关']]),
        toggleRow('允许双击放大画面', 'zoom', '放大后拖动查看细节，再双击还原'));
    }
    rows.push(toggleRow('拆分跨页扫图', 'split', layout.includes('w') || layout.includes('c')
          ? `这本有 ${[...layout].filter((k) => k === 'w').length} 张两页拼图${layout[0] === 'c' ? '，封面是整张书衣' : ''}：拆成单页，书衣只显示正面`
          : '两页拼在一张图里的扫图拆成单页，整张书衣只显示正面'));
    rows.push(toggleRow('显示页码', 'pageNum'));
    const canW2x = w2xSupported() && !!account()?.url;
    rows.push(h('div.sheet-row.is-w2x', h('span.sheet-label', '画质增强', h('small', canW2x
      ? `waifu2x 降噪，后台先处理后面 ${W2X_AHEAD} 页，好了自动换上。第一次使用要下载几十 MB 模型`
      : (w2xSupported() ? '要先登录自己的服务器（模型从服务器下载）' : '这个设备不支持'))),
      h('div.segmented', { role: 'group', 'aria-label': '画质增强' },
        [['off', '关'], ...Object.entries(W2X_MODES).map(([k, m]) => [k, m.label])].map(([value, text]) => h('button' + (settings.w2x === value ? '.is-on' : ''), {
          type: 'button', disabled: !canW2x && value !== 'off', title: W2X_MODES[value]?.sub || '',
          onclick: () => change({ w2x: value }),
        }, text)))));
    if (w2x) { w2xNote.textContent = w2xText(w2xStatus); rows.push(h('div.sheet-row.w2x-status', w2xNote)); }
    sheet.replaceChildren(
      h('div.sheet-head', h('h2', '阅读设置'),
        h('button.icon-btn', { type: 'button', 'aria-label': '关闭', onclick: closePanels }, icon('close'))),
      h('div.sheet-body', rows));
  }

  root.classList.toggle('no-pagenum', !settings.pageNum);
  startW2x();
  mount(false);

  return {
    async destroy() {
      destroyed = true;
      cleanupView(); clock.stop(); w2x?.destroy();
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('volumekey', onVolume);
      try { window.SusukoNative?.setVolumeKeys(false); } catch { /* 忽略 */ }
      root.remove();
      evict(-1e9, 0);
    },
  };
}
