// 漫画阅读器：CBZ / ZIP。翻页（可日漫右翻、宽屏双页）或下拉长条。
import { routeChip } from './cloud-direct.js';
import { ZipReader, mimeOf, isImageName } from './zip.js';
import { prefs, setProgress, natural } from './store.js';
import { h, icon, loader, toast, menuButton, statusClock } from './ui.js';

const DEFAULTS = { mode: 'page', rtl: true, spread: true, turn: 'slide', zoom: true, pageNum: true, applyAll: true };

export async function open({ host, book, title = book.title, source, progress, onExit }) {
  // 网盘里的图片文件夹本身就是一页一张图；压缩包则从里面挑出图片
  const zip = source.isPageList ? source : await ZipReader.open(source);
  const entries = zip.entries.filter((e) => !e.isDir && isImageName(e.name)).sort((a, b) => natural(a.name, b.name));
  if (!entries.length) throw new Error(source.isPageList ? '这个文件夹里没有图片' : '压缩包里没有图片');
  const total = entries.length;
  // 本机文件读得快，预读两页就够；从服务器或网盘取的要多预读几页，翻页时才不用等
  const remote = !(source instanceof Blob);
  const AHEAD = remote ? 5 : 2;
  // 阅读方式可以只对这一本生效（比如某本是条漫就用下拉，其余还是日漫翻页）
  const own = prefs.get('comicBooks', {})[book.id];
  const settings = { ...DEFAULTS, ...prefs.get('comic', {}), ...(own || {}), applyAll: !own };
  let page = Math.min(total - 1, Math.max(0, Number(progress?.loc?.page) || 0));
  let destroyed = false, cleanupView = () => {};

  // ---------- 图片缓存 ----------
  const urls = new Map();
  function urlOf(i) {
    if (!urls.has(i)) urls.set(i, zip.blobOf(entries[i], mimeOf(entries[i].name)).then((b) => URL.createObjectURL(b)));
    return urls.get(i);
  }
  function evict(keepAround, radius) {
    for (const [i, p] of urls) {
      if (Math.abs(i - keepAround) > radius) { urls.delete(i); p.then((u) => URL.revokeObjectURL(u)).catch(() => {}); }
    }
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
    if (save) setProgress(book.id, { page }, (lastShown + 1) / total);
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
    function group(p) { // 当前画面显示哪几页：封面单独一页，其后两两成对
      if (!spread() || p === 0) return [p];
      const first = p % 2 ? p : p - 1;
      return first + 1 < total ? [first, first + 1] : [first];
    }
    const targetOf = (dir) => {
      const g = group(page);
      if (dir > 0) return g[g.length - 1] + 1 < total ? g[g.length - 1] + 1 : null;
      return g[0] > 0 ? group(g[0] - 1)[0] : null;
    };
    async function fillPanel(panel, p) {
      const g = group(p);
      panel.dataset.page = String(g[0]);
      const srcs = await Promise.all(g.map(urlOf)).catch(() => null);
      if (!srcs || panel.dataset.page !== String(g[0])) return false;
      const imgs = srcs.map((src, n) => h('img', { src, alt: `第 ${g[n] + 1} 页`, draggable: false }));
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
    const items = entries.map((_, i) => h('div.comic-strip', { 'data-i': i }));
    scroller.append(...items);
    stage.replaceChildren(scroller);

    const loader = new IntersectionObserver((list) => {
      for (const entry of list) {
        const el = entry.target, i = Number(el.dataset.i);
        if (entry.isIntersecting && !el.firstChild) {
          urlOf(i).then((src) => {
            if (destroyed || el.firstChild) return;
            const img = h('img', { src, alt: `第 ${i + 1} 页`, draggable: false });
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
        page = now; report(page);
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
    requestAnimationFrame(() => { if (page > 0) jump(page); report(page, save); });
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
    if (!applyAll) prefs.set('comic', { ...prefs.get('comic', {}), turn: rest.turn, zoom: rest.zoom, pageNum: rest.pageNum, spread: rest.spread });
    root.classList.toggle('no-pagenum', !settings.pageNum);
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
    rows.push(toggleRow('显示页码', 'pageNum'));
    sheet.replaceChildren(
      h('div.sheet-head', h('h2', '阅读设置'),
        h('button.icon-btn', { type: 'button', 'aria-label': '关闭', onclick: closePanels }, icon('close'))),
      h('div.sheet-body', rows));
  }

  root.classList.toggle('no-pagenum', !settings.pageNum);
  mount(false);

  return {
    async destroy() {
      destroyed = true;
      cleanupView(); clock.stop();
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('volumekey', onVolume);
      try { window.SusukoNative?.setVolumeKeys(false); } catch { /* 忽略 */ }
      root.remove();
      evict(-1e9, 0);
    },
  };
}
