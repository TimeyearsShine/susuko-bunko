// 小型 DOM 工具：元素创建、图标、提示条、对话框。

export function h(spec, props, ...children) {
  const [tag, ...classes] = spec.split('.');
  const el = document.createElement(tag || 'div');
  if (classes.length) el.className = classes.join(' ');
  if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) { children.unshift(props); props = null; }
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && k !== 'list') { try { el[k] = v; } catch { el.setAttribute(k, v); } }
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

const paths = {
  contrast: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v17a8.5 8.5 0 0 0 0-17z" fill="currentColor"/>',
  lineSpacing: '<path d="M10 6h10M10 12h10M10 18h10M5 4v16M3 6.5L5 4l2 2.5M3 17.5L5 20l2-2.5"/>',
  letterSpacing: '<path d="M6 13l2.5-7 2.5 7M6.8 11h3.4M14 13V6h2.2a1.8 1.8 0 0 1 0 3.6H14M14 9.6h2.6a1.7 1.7 0 0 1 0 3.4H14M4 18h16M4 18l2-1.6M4 18l2 1.6M20 18l-2-1.6M20 18l-2 1.6"/>',
  wordSpacing: '<path d="M4 6h6M14 6h6M4 11h4M12 11h8M4 16h8M16 16h4"/>',
  margin: '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="8" y="8" width="8" height="8" rx="1" fill="currentColor" fill-opacity=".25"/>',
  paragraph: '<path d="M4 6h16M4 10h11M4 15h16M4 19h11"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.3 3.6 5.1 3.6 8.5s-1.2 6.2-3.6 8.5c-2.4-2.3-3.6-5.1-3.6-8.5s1.2-6.2 3.6-8.5z"/>',
  sidebar: '<rect x="3.5" y="4.5" width="17" height="15" rx="3"/><path d="M9.5 4.5v15"/>',
  caret: '<path d="M10 7.5l5 4.5-5 4.5z" fill="currentColor" stroke-width="1.2"/>',
  openBook: '<path d="M12 6.5C10 5 7.2 4.5 4 4.8v13.4c3.2-.3 6 .2 8 1.8 2-1.6 4.8-2.1 8-1.8V4.8c-3.2-.3-6 .2-8 1.7zM12 6.5V20" fill="currentColor" fill-opacity=".18"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  more: '<circle cx="5" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="19" cy="12" r="1.3" fill="currentColor"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7"/>',
  list: '<path d="M8 6h12M8 12h12M8 18h12"/><circle cx="4" cy="6" r="1" fill="currentColor"/><circle cx="4" cy="12" r="1" fill="currentColor"/><circle cx="4" cy="18" r="1" fill="currentColor"/>',
  type: '<path d="M4 19l5-14h1l5 14M6 14h7M16 19l2.5-7h.5l2.5 7M17 16.5h4"/>',
  sync: '<path d="M20 12a8 8 0 0 1-14.3 4.9M4 12a8 8 0 0 1 14.3-4.9"/><path d="M18.5 3v4.5H14M5.5 21v-4.5H10"/>',
  cloudOff: '<path d="M7 18a4.5 4.5 0 0 1-.8-8.9M10 6.5a6 6 0 0 1 8 4.6A3.5 3.5 0 0 1 18.5 18M3 3l18 18"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  books: '<path d="M5 4h4v16H5zM10.5 4h4v16h-4zM16 6.2l3.6-1 3 13.6-3.6 1z" transform="translate(-1.5 0)"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5.5l3.5 2"/>',
  inbox: '<path d="M4 13l2.5-8h11L20 13v6H4zM4 13h5l1 2.5h4l1-2.5h5"/>',
  folder: '<path d="M3.5 7.5v10.5h17V8.5h-8.5l-2-2.5H3.5z"/>',
  down: '<path d="M12 4v12M7 11.5l5 5 5-5M5 20h14"/>',
  prev: '<path d="M14.5 6l-6 6 6 6"/>',
  tag: '<path d="M3.5 12.2V4.5a1 1 0 0 1 1-1h7.7l8.3 8.3a1.5 1.5 0 0 1 0 2.1l-6.1 6.1a1.5 1.5 0 0 1-2.1 0z"/><circle cx="8" cy="8" r="1.4"/>',
  search2: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.2-4.2"/>',
  next: '<path d="M9.5 6l6 6-6 6"/>',
  chevron: '<path d="M7 10l5 5 5-5"/>',
  chevronRight: '<path d="M10 6l6 6-6 6"/>',
  gridView: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/>',
  listView: '<rect x="4" y="5" width="4" height="5" rx="1"/><rect x="4" y="14" width="4" height="5" rx="1"/><path d="M11 6.5h9M11 9h6M11 15.5h9M11 18h6"/>',
  spineView: '<rect x="4" y="4" width="3.5" height="16" rx="1"/><rect x="9" y="4" width="3.5" height="16" rx="1"/><rect x="14" y="6.5" width="3.5" height="13.5" rx="1" transform="rotate(-12 15.75 13.25)"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.8v.4"/>',
  sort: '<path d="M7 5v14M4 8l3-3 3 3M17 19V5M14 16l3 3 3-3"/>',
  checkCircle: '<circle cx="12" cy="12" r="8.5"/><path d="M8.3 12.3l2.6 2.6 5-5.3"/>',
  user: '<circle cx="12" cy="8.5" r="3.8"/><path d="M4.5 20c.9-3.8 4-5.8 7.5-5.8s6.6 2 7.5 5.8"/>',
  logout: '<path d="M14 5H6v14h8M10 12h10M17 9l3 3-3 3"/>',
  cloud: '<path d="M7 18a4.5 4.5 0 0 1-.6-9A6 6 0 0 1 18 10.5 3.8 3.8 0 0 1 17.5 18z"/>',
  upload: '<path d="M12 16V4M7 8.5l5-5 5 5M5 20h14"/>',
  highlighter: '<path d="M5 20h6M8.5 16.5l-2-2L15 6l4 4-8.5 8.5z"/><path d="M13 8l4 4"/>',
  quote: '<path d="M6 17c-1-1.5-1.5-3-1.5-4.5C4.5 9 6.5 7 9 6.5M15 17c-1-1.5-1.5-3-1.5-4.5 0-3.5 2-5.5 4.5-6"/><circle cx="7.5" cy="14.5" r="2.5" fill="currentColor"/><circle cx="16.5" cy="14.5" r="2.5" fill="currentColor"/>',
  copy: '<rect x="8" y="8" width="11" height="11" rx="2.5"/><path d="M16 8V6.5A1.5 1.5 0 0 0 14.5 5h-8A1.5 1.5 0 0 0 5 6.5v8A1.5 1.5 0 0 0 6.5 16H8"/>',
  dict: '<path d="M5 5.5A1.5 1.5 0 0 1 6.5 4H19v13H6.5A1.5 1.5 0 0 0 5 18.5zM5 18.5A1.5 1.5 0 0 0 6.5 20H19"/><path d="M9.5 8h5M9.5 11h3.5"/>',
  translate: '<path d="M4 6h9M8.5 4v2M6 6c.6 2.8 2.6 5 5.5 6.3M11 6c-.7 3.5-3 6.3-6.5 7.7"/><path d="M12.5 20l3.8-9h.4l3.8 9M14 17h5"/>',
  sparkle: '<path d="M12 3.5l1.7 5 5 1.7-5 1.7-1.7 5-1.7-5-5-1.7 5-1.7zM18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>',
  headphones: '<path d="M4.5 16v-3.5a7.5 7.5 0 0 1 15 0V16"/><rect x="3.5" y="14" width="4" height="6" rx="1.5"/><rect x="16.5" y="14" width="4" height="6" rx="1.5"/>',
  play: '<path d="M8 5.5v13l10-6.5z" fill="currentColor"/>',
  pause: '<path d="M8 5.5v13M16 5.5v13" stroke-width="3"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor"/>',
  camera: '<path d="M4 8.5A1.5 1.5 0 0 1 5.5 7H8l1.5-2h5L16 7h2.5A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z"/><circle cx="12" cy="12.5" r="3.3"/>',
  key: '<circle cx="8" cy="14" r="3.5"/><path d="M10.5 11.5L19 3M15.5 6.5l2.5 2.5M17.5 4.5l2 2"/>',
  palette: '<path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.2 0 1.8-.8 1.8-1.7 0-1.2-1-1.5-1-2.6 0-1 .8-1.7 1.8-1.7h2.2a3.7 3.7 0 0 0 3.7-3.7C20.5 7 16.7 3.5 12 3.5z"/><circle cx="7.8" cy="11" r="1.1" fill="currentColor"/><circle cx="10.5" cy="7.5" r="1.1" fill="currentColor"/><circle cx="15" cy="7.8" r="1.1" fill="currentColor"/>',
  database: '<ellipse cx="12" cy="6" rx="7" ry="2.5"/><path d="M5 6v12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V6M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5"/>',
  chart: '<path d="M5 20V11M12 20V5M19 20v-6"/>',
  bookmark: '<path d="M7 4h10v16l-5-4-5 4z"/>',
  bookmarkOn: '<path d="M7 4h10v16l-5-4-5 4z" fill="currentColor"/>',
  pen: '<path d="M4 20l1-4L16.5 4.5l3 3L8 19zM14 7l3 3"/>',
  trash: '<path d="M5 7h14M10 7V4.5h4V7M7 7l1 13h8l1-13M10 11v5M14 11v5"/>',
  star: '<path d="M12 3.8l2.5 5.2 5.7.8-4.1 4 1 5.6-5.1-2.7-5.1 2.7 1-5.6-4.1-4 5.7-.8z"/>',
  starOn: '<path d="M12 3.8l2.5 5.2 5.7.8-4.1 4 1 5.6-5.1-2.7-5.1 2.7 1-5.6-4.1-4 5.7-.8z" fill="currentColor"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8"/>',
  scroll: '<rect x="6" y="3" width="12" height="18" rx="2"/><path d="M12 8v8M9.5 13.5L12 16l2.5-2.5"/>',
  pages: '<rect x="3.5" y="5" width="7.5" height="14" rx="1"/><rect x="13" y="5" width="7.5" height="14" rx="1"/>',
};
export function icon(name, size = 20) {
  const span = document.createElement('span');
  span.className = 'icon';
  if (window.__susukoApplePlatform) span.dataset.appleIcon = name;
  span.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || ''}</svg>`;
  return span;
}

// ---------- 提示条 ----------
let toastHost = null;
export function toast(message, { sticky = false, error = false } = {}) {
  if (!toastHost) { toastHost = h('div.toasts', { role: 'status', 'aria-live': 'polite' }); document.body.append(toastHost); }
  const el = h('div.toast' + (error ? '.is-error' : ''), message);
  toastHost.append(el);
  let timer = sticky ? null : setTimeout(close, error ? 5000 : 2600);
  function close() { clearTimeout(timer); el.remove(); }
  return {
    update(text) { el.textContent = text; },
    close,
    done(text, isError = false) {
      el.textContent = text; el.classList.toggle('is-error', isError);
      timer = setTimeout(close, isError ? 5000 : 2200);
    },
  };
}

// ---------- 对话框 ----------
/** 打开一个对话框。build(close) 返回内容节点；Promise 在关闭时给出 close(value) 的值。 */
export function dialog(title, build, { wide = false } = {}) {
  return new Promise((resolve) => {
    let result;
    const dlg = h('dialog.dialog' + (wide ? '.is-wide' : ''));
    const close = (value) => { result = value; dlg.close(); };
    dlg.append(
      h('header.dialog-head', h('h2', title),
        h('button.icon-btn', { type: 'button', 'aria-label': '关闭', onclick: () => close() }, icon('close'))),
      build(close),
    );
    dlg.addEventListener('click', (e) => { if (e.target === dlg) close(); });
    dlg.addEventListener('close', () => { dlg.remove(); resolve(result); });
    document.body.append(dlg);
    dlg.showModal();
  });
}

export function confirmDialog(title, message, { ok = '确定', danger = false } = {}) {
  return dialog(title, (close) => h('div.dialog-body',
    h('p.dialog-text', message),
    h('div.dialog-actions',
      h('button.btn', { type: 'button', onclick: () => close(false) }, '取消'),
      h('button.btn' + (danger ? '.is-danger' : '.is-primary'), { type: 'button', onclick: () => close(true) }, ok)),
  )).then(Boolean);
}

export function promptDialog(title, { label, value = '', ok = '保存', placeholder = '' } = {}) {
  return dialog(title, (close) => {
    const input = h('input.field', { type: 'text', value, placeholder, maxLength: 60, 'aria-label': label || title });
    setTimeout(() => { input.focus(); input.select(); }, 30);
    return h('form.dialog-body', { onsubmit: (e) => { e.preventDefault(); const v = input.value.trim(); if (v) close(v); } },
      label && h('label.field-label', label), input,
      h('div.dialog-actions',
        h('button.btn', { type: 'button', onclick: () => close() }, '取消'),
        h('button.btn.is-primary', { type: 'submit' }, ok)));
  });
}

/** 阅读器底部菜单里的一个按钮：图标在上，文字在下 */
export function menuButton(iconName, label, onclick) {
  return h('button.bottom-act', { type: 'button', onclick }, icon(iconName, 22), h('span', label));
}

export const fmtPercent = (p) => (p >= 0.995 ? '读完' : `${Math.max(1, Math.round(p * 100))}%`);
export function fmtSize(bytes) {
  if (bytes > 1 << 30) return (bytes / (1 << 30)).toFixed(1) + ' GB';
  if (bytes > 1 << 20) return (bytes / (1 << 20)).toFixed(1) + ' MB';
  return Math.max(1, Math.round(bytes / 1024)) + ' KB';
}

/** 加载动画：捧着书的小女孩（img/loader.png 是 12×8 帧的精灵图，用当前文字颜色描出来，深色、纸张颜色都合适） */
export function loader(label = '正在加载') {
  return h('span.loader', { role: 'status', 'aria-label': label }, h('span.ld-y', h('span.ld-x')));
}

/** 全屏看图：滚轮 / 双指缩放，拖动平移，双击放大，单击或 Esc 关闭 */
export function imageViewer(src) {
  document.querySelector('.viewer')?.remove();
  const img = h('img', { src, alt: '插画', draggable: false });
  const closeBtn = h('button.icon-btn.viewer-close', { type: 'button', 'aria-label': '关闭' }, icon('close'));
  const root = h('div.viewer', { role: 'dialog', 'aria-label': '查看插画' }, img, closeBtn, h('p.viewer-hint', '双击放大，单击关闭'));
  let scale = 1, tx = 0, ty = 0;
  const apply = (smooth = false) => {
    img.style.transition = smooth ? 'transform .2s ease-out' : 'none';
    img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    root.classList.toggle('is-zoomed', scale > 1.01);
  };
  const zoomAt = (x, y, next, smooth) => { // 以屏幕上的 (x, y) 为中心缩放
    next = Math.min(6, Math.max(1, next));
    const cx = x - innerWidth / 2, cy = y - innerHeight / 2, k = next / scale;
    tx = cx - (cx - tx) * k; ty = cy - (cy - ty) * k; scale = next;
    if (scale === 1) { tx = 0; ty = 0; }
    apply(smooth);
  };
  const close = () => { window.removeEventListener('keydown', onKey, true); root.remove(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(); } };
  window.addEventListener('keydown', onKey, true);
  closeBtn.addEventListener('click', (e) => { e.stopPropagation(); close(); });

  const pts = new Map();
  let moved = 0, pinch = 0, lastTap = 0, tapTimer = null;
  root.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    root.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 1) moved = 0;
    if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch = Math.hypot(a.x - b.x, a.y - b.y); }
  });
  root.addEventListener('pointermove', (e) => {
    const p = pts.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    moved += Math.abs(dx) + Math.abs(dy);
    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch) zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, scale * (d / pinch));
      pinch = d;
    } else if (scale > 1) { tx += dx; ty += dy; apply(); }
  });
  const up = (e) => {
    if (!pts.delete(e.pointerId)) return;
    pinch = 0;
    if (pts.size || moved > 10 || e.type === 'pointercancel') return;
    const now = Date.now();
    if (now - lastTap < 300) { // 双击：放大 / 还原
      clearTimeout(tapTimer); lastTap = 0;
      zoomAt(e.clientX, e.clientY, scale > 1.01 ? 1 : 2.5, true);
    } else { lastTap = now; tapTimer = setTimeout(close, 300); }
  };
  root.addEventListener('pointerup', up);
  root.addEventListener('pointercancel', up);
  root.addEventListener('wheel', (e) => { e.preventDefault(); zoomAt(e.clientX, e.clientY, scale * (e.deltaY < 0 ? 1.2 : 1 / 1.2)); }, { passive: false });
  document.body.append(root);
  return { close };
}

/** 自绘下拉菜单（代替系统原生的 select）。options: [[value, 文字], ...] */
export function dropdown({ label, value, options, onChange }) {
  const text = h('span');
  const btn = h('button.dropdown-btn', { type: 'button', 'aria-haspopup': 'listbox', 'aria-label': label }, text, icon('chevron', 16));
  const root = h('div.dropdown', btn);
  let menu = null;
  const draw = () => { text.textContent = options.find(([v]) => v === value)?.[1] ?? ''; };
  const close = () => {
    if (!menu) return;
    menu.remove(); menu = null; btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', onKey, true);
  };
  const outside = (e) => { if (!root.contains(e.target)) close(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); btn.focus(); } };
  btn.addEventListener('click', () => {
    if (menu) { close(); return; }
    menu = h('div.dropdown-menu', { role: 'listbox', 'aria-label': label }, options.map(([v, t]) => h('button.dropdown-item' + (v === value ? '.is-on' : ''), {
      type: 'button', role: 'option', 'aria-selected': String(v === value),
      onclick: () => { value = v; draw(); close(); onChange(v); },
    }, h('span', t), v === value && icon('check', 16))));
    root.append(menu); btn.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', onKey, true);
  });
  draw();
  root.set = (v) => { value = v; draw(); };
  return root;
}

export function fmtDuration(seconds) {
  const m = Math.round(seconds / 60);
  if (m < 1) return seconds > 0 ? '不到 1 分钟' : '0 分钟';
  return m >= 60 ? `${Math.floor(m / 60)} 小时 ${m % 60} 分` : `${m} 分钟`;
}

/** 页脚左下角的电量图标 + 当前时间。返回 { el, stop } */
export function statusClock() {
  const fill = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  const battery = h('span.battery', { hidden: true, html: '<svg width="24" height="12" viewBox="0 0 24 12" aria-hidden="true"><rect x=".75" y=".75" width="19.5" height="10.5" rx="2.6" fill="none" stroke="currentColor" stroke-width="1.2"/><rect x="21.6" y="3.6" width="1.9" height="4.8" rx=".9" fill="currentColor"/></svg>' });
  for (const [k, v] of Object.entries({ x: 2.4, y: 2.4, height: 7.2, rx: 1.3, fill: 'currentColor' })) fill.setAttribute(k, v);
  battery.firstChild.append(fill);
  const time = h('span.clock');
  const el = h('span.foot-status', battery, time);
  const tick = () => { const d = new Date(); time.textContent = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
  tick();
  const timer = setInterval(tick, 15000);
  let source = null;
  const level = () => {
    battery.hidden = false;
    fill.setAttribute('width', (16.2 * source.level).toFixed(1));
    battery.title = `电量 ${Math.round(source.level * 100)}%${source.charging ? '，充电中' : ''}`;
    battery.classList.toggle('is-low', source.level <= 0.2 && !source.charging);
  };
  navigator.getBattery?.().then((b) => { source = b; level(); b.addEventListener('levelchange', level); b.addEventListener('chargingchange', level); }).catch(() => {});
  return { el, stop() { clearInterval(timer); source?.removeEventListener('levelchange', level); source?.removeEventListener('chargingchange', level); } };
}
