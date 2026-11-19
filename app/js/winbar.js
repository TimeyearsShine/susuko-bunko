// Windows 客户端的窗口标题栏：系统标题栏关掉了（tauri.conf.json 里 decorations: false），
// 这里自己画——左上角软件小图标点一下切换“置于顶层”，右上角最小化 / 最大化 / 关闭，其余空白处拖动窗口、双击最大化。
import { h } from './ui.js';
import { prefs, isNativeShell } from './store.js';

const svg = (d) => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('width', '10'); s.setAttribute('height', '10'); s.setAttribute('viewBox', '0 0 10 10');
  s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '1'); s.setAttribute('aria-hidden', 'true');
  s.innerHTML = d;
  return s;
};
const GLYPH = {
  min: '<path d="M0 5.5h10"/>',
  max: '<rect x=".5" y=".5" width="9" height="9" rx="1"/>',
  restore: '<rect x=".5" y="2.5" width="7" height="7" rx="1"/><path d="M2.5 2.5V1.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-1"/>',
  close: '<path d="M.5 .5l9 9M9.5 .5l-9 9"/>',
};

/** 桌面客户端使用自绘标题栏，移动端保留系统交互。 */
export function isDesktopShell() {
  if (/[?&]winbar=1/.test(location.search)) return true; // 在浏览器里预览标题栏用
  const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return isNativeShell && !mobile && !!window.__TAURI__?.window;
}

export function mountWinbar() {
  if (!isDesktopShell() || document.querySelector('.winbar')) return;
  const win = window.__TAURI__?.window?.getCurrentWindow?.();
  const call = (fn, ...a) => { try { return win?.[fn]?.(...a)?.catch?.(() => {}); } catch { return null; } };
  document.documentElement.classList.add('is-desk');

  let pinned = prefs.get('pinTop', false);
  const pin = h('button.win-pin', { type: 'button', onclick: () => setPin(!pinned) },
    h('img', { src: 'icon-96.png', alt: '', draggable: false }), h('span.win-pin-dot', { 'aria-hidden': 'true' }));
  const tip = h('span.win-tip', { role: 'tooltip' });
  function setPin(on, save = true) {
    pinned = on;
    if (save) prefs.set('pinTop', on);
    call('setAlwaysOnTop', on);
    pin.classList.toggle('is-on', on);
    pin.setAttribute('aria-pressed', String(on));
    const label = on ? '已置顶，点一下取消' : '置于顶层';
    pin.setAttribute('aria-label', label);
    tip.textContent = label;
  }
  pin.addEventListener('click', () => { pin.classList.add('show-tip'); clearTimeout(pin._t); pin._t = setTimeout(() => pin.classList.remove('show-tip'), 1400); });

  const maxBtn = h('button.win-btn', { type: 'button', 'aria-label': '最大化', title: '最大化', onclick: () => call('toggleMaximize') }, svg(GLYPH.max));
  const ctrls = h('div.win-ctrls',
    h('button.win-btn', { type: 'button', 'aria-label': '最小化', title: '最小化', onclick: () => call('minimize') }, svg(GLYPH.min)),
    maxBtn,
    h('button.win-btn.is-close', { type: 'button', 'aria-label': '关闭', title: '关闭', onclick: () => call('close') }, svg(GLYPH.close)));
  async function syncMax() {
    let max = false;
    try { max = !!(await win?.isMaximized?.()); } catch { /* 拿不到就当没最大化 */ }
    document.documentElement.classList.toggle('is-maximized', max);
    maxBtn.replaceChildren(svg(max ? GLYPH.restore : GLYPH.max));
    const label = max ? '向下还原' : '最大化';
    maxBtn.title = label; maxBtn.setAttribute('aria-label', label);
  }

  // data-tauri-drag-region 只对元素本身生效（不含子元素），所以拖动区单独一层放在按钮下面
  const drag = h('div.win-drag', { 'data-tauri-drag-region': '' });
  document.body.append(h('div.winbar', drag, h('div.win-pin-wrap', pin, tip), ctrls));
  setPin(pinned, false);
  syncMax();
  try { win?.onResized?.(() => syncMax()); } catch { /* 旧版本没有这个事件 */ }
  window.addEventListener('resize', () => { clearTimeout(syncMax._t); syncMax._t = setTimeout(syncMax, 120); });
}
