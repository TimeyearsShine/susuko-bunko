// 立体书架：每本书是一个有封面、有书脊的立体书本，沿着一道向后弯的弧摆开。
// 正中间那本转过来正对你露出封面，两边的书侧着身露出书脊。可以拖、甩（带惯性）、滚轮、方向键，
// 停下时自动对齐到一本书上，首尾相接循环。书脊颜色取自各自封面的主色。
import { h } from './ui.js';
import { extractColor, hexToOklch, spineTone } from './theme.js';
import { prefs } from './store.js';
import { buildSpine, fitSpine } from './spine.js';

const colorCache = prefs.get('spineColors2', {});
let saveTimer = null;
function rememberColor(key, color) {
  colorCache[key] = color;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const keys = Object.keys(colorCache);
    if (keys.length > 800) for (const k of keys.slice(0, keys.length - 800)) delete colorCache[k];
    prefs.set('spineColors2', colorCache);
  }, 500);
}

/**
 * items: [{ key, book, title, spine: {书脊信息，见 spine.js}, colorKey, fallbackHue }]
 * opts: { index, coverUrl(book) → Promise<url>, onFocus(i), onOpen(i) }
 */
export function mountShelf(host, items, opts) {
  const n = items.length;
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let pos = ((opts.index % n) + n) % n, target = pos, raf = 0, focused = -1, destroyed = false;
  let CW = 180, CH = 256, T = 38; // 封面宽、高，书本厚度

  const track = h('div.shelf-track');
  const root = h('div.shelf3d', { tabIndex: 0, role: 'listbox', 'aria-label': '立体书架，左右拖动或用方向键挑书，回车打开' },
    h('div.shelf-scene', track, h('div.shelf-plank', { 'aria-hidden': 'true' })));
  host.replaceChildren(root);

  const books = items.map((it, i) => {
    const front = h('div.b3d-face.b3d-front', h('div.b3d-cover', h('span', it.title)));
    const left = buildSpine(it.spine, 'b3d-face.b3d-spine.is-left');
    const right = buildSpine(it.spine, 'b3d-face.b3d-spine.is-right');
    const el = h('div.b3d', { role: 'option', 'aria-label': it.title, style: `--hue:${it.fallbackHue}` },
      h('div.b3d-floor', { 'aria-hidden': 'true' }), front, left.el, right.el, h('div.b3d-face.b3d-top'));
    track.append(el);
    const color = colorCache[it.colorKey];
    if (color) paint(el, color);
    return { el, front, spines: [left, right], loaded: false };
  });

  function paint(el, color) {
    el.style.setProperty('--sc', color);
    el.classList.toggle('is-light', hexToOklch(color).L > 0.68);
  }
  function loadCover(i) {
    const b = books[i];
    if (b.loaded) return;
    b.loaded = true;
    const it = items[i];
    if (!it.book?.hasCover) return;
    opts.coverUrl(it.book).then((url) => {
      if (!url || destroyed) return;
      const img = h('img', { src: url, alt: '', draggable: false });
      img.addEventListener('load', () => {
        b.front.firstChild.replaceWith(img);
        if (!colorCache[it.colorKey]) extractColor(img).then((c) => { c = spineTone(c); rememberColor(it.colorKey, c); paint(b.el, c); }).catch(() => {});
      }, { once: true });
    }).catch(() => {});
  }

  let K = 1; // 随书本大小缩放的系数
  function measure() {
    // 书本大小跟着可用的宽和高走：窗口放大，书也跟着放大，不会只缩在中间一小块
    const w = root.clientWidth, hgt = root.clientHeight || 400;
    CW = Math.round(Math.max(118, Math.min(w * 0.2, (hgt - 70) / 1.42, 460)));
    CH = Math.round(CW * 1.42);
    T = Math.round(CW * 0.2);
    K = CW / 184;
    root.style.setProperty('--persp', `${Math.round(CW * 6)}px`);
    root.style.setProperty('--cw', `${CW}px`);
    root.style.setProperty('--ch', `${CH}px`);
    root.style.setProperty('--t', `${T}px`);
    root.style.setProperty('--spk', (T / 80).toFixed(4)); // 书脊内容按 80px 宽排好，再整体缩放到实际厚度
  }

  const wrap = (d) => { d = ((d % n) + n) % n; return d >= n / 2 ? d - n : d; };
  function layout() {
    const near = CW / 2 + T / 2 + 18 * K; // 第一本侧放的书离中心多远
    const reach = Math.min(Math.max(8, Math.ceil(root.clientWidth / (T + 5 * K) / 2)), Math.ceil(n / 2));
    for (let i = 0; i < n; i++) {
      const d = n === 1 ? 0 : wrap(i - pos);
      const a = Math.abs(d), s = Math.sign(d) || 1;
      const el = books[i].el;
      if (a > reach) { el.style.display = 'none'; continue; }
      el.style.display = '';
      if (!books[i].fitted) { books[i].fitted = true; for (const sp of books[i].spines) fitSpine(sp.el); }
      if (a < 6) loadCover(i); // 近处几本取封面（侧面也要用封面的颜色）
      const t = Math.min(a, 1);
      const x = a <= 1 ? s * a * near : s * (near + (a - 1) * (T + 5 * K));
      const z = (a <= 1 ? -a * 70 : -70 - (a - 1) ** 1.25 * 16) * K; // 越往两边越往后退，摆成一道弧
      const rot = s * t * 78;
      const lift = (1 - t) * -10 * K; // 正中那本稍微抬起来
      el.style.transform = `translate3d(${x}px, ${lift}px, ${z}px) rotateY(${rot}deg)`;
      el.style.zIndex = String(200 - Math.round(a * 10));
      el.style.setProperty('--shade', (Math.min(a, 8) * 0.045).toFixed(3));
      el.classList.toggle('is-center', a < 0.5);
    }
    const now = ((Math.round(pos) % n) + n) % n;
    if (now !== focused) {
      if (focused !== -1) navigator.vibrate?.(4);
      focused = now;
      opts.onFocus?.(now);
    }
  }

  // 平滑移动到 target：拖动时直接跟手，松手后带惯性滑行再吸附
  function animate() {
    cancelAnimationFrame(raf);
    const step = () => {
      if (destroyed) return;
      const diff = target - pos;
      if (Math.abs(diff) < 0.002 || calm) { pos = target; layout(); return; }
      pos += diff * 0.16;
      layout();
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  }
  const goTo = (t) => { target = t; animate(); };
  const settle = () => { target = Math.round(target); animate(); };

  // 拖动 / 甩动
  let drag = null;
  const PX = () => CW * 0.42; // 拖动多少像素换一本
  root.addEventListener('pointerdown', (e) => {
    if (!e.isPrimary || e.button !== 0) return;
    cancelAnimationFrame(raf);
    drag = { x: e.clientX, y: e.clientY, pos, moved: false, samples: [[e.timeStamp, e.clientX]], target: e.target };
    root.setPointerCapture(e.pointerId);
  });
  root.addEventListener('pointermove', (e) => {
    if (!e.isPrimary || !drag) return;
    const dx = e.clientX - drag.x;
    if (!drag.moved && Math.abs(dx) < 6) return;
    drag.moved = true;
    pos = target = drag.pos - dx / PX();
    drag.samples.push([e.timeStamp, e.clientX]);
    if (drag.samples.length > 6) drag.samples.shift();
    layout();
  });
  const release = (e) => {
    if (!e.isPrimary || !drag) return;
    const d = drag;
    drag = null;
    if (e.type === 'pointercancel') { settle(); return; }
    if (!d.moved) { // 点按：点中间那本打开，点旁边的书把它转到中间
      const el = d.target.closest?.('.b3d');
      const i = books.findIndex((b) => b.el === el);
      if (i < 0) { settle(); return; }
      const off = wrap(i - pos);
      if (Math.abs(off) < 0.5) opts.onOpen?.(i); else goTo(pos + off);
      return;
    }
    const [t0, x0] = d.samples[0], [t1, x1] = d.samples[d.samples.length - 1];
    const v = t1 > t0 ? (x1 - x0) / (t1 - t0) : 0; // 像素 / 毫秒
    target = Math.round(pos - (v * 260) / PX()); // 甩得越快滑得越远
    animate();
  };
  root.addEventListener('pointerup', release);
  root.addEventListener('pointercancel', release);

  let wheelAt = 0;
  root.addEventListener('wheel', (e) => {
    e.preventDefault();
    const dlt = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (Math.abs(dlt) < 4 || e.timeStamp - wheelAt < 90) return;
    wheelAt = e.timeStamp;
    goTo(Math.round(target) + Math.sign(dlt));
  }, { passive: false });
  root.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') { e.preventDefault(); goTo(Math.round(target) + 1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); goTo(Math.round(target) - 1); }
    else if (e.key === 'Enter') opts.onOpen?.(focused);
  });

  const ro = new ResizeObserver(() => { measure(); layout(); });
  ro.observe(root);
  measure(); layout();

  return {
    next: () => goTo(Math.round(target) + 1),
    prev: () => goTo(Math.round(target) - 1),
    focus: () => root.focus({ preventScroll: true }),
    get index() { return focused; },
    destroy() { destroyed = true; cancelAnimationFrame(raf); ro.disconnect(); },
  };
}
