// WKWebView keeps the application state and keyboard/VoiceOver targets.
const actionSelector = [
  '.side-toggle', '.topbar .heading .icon-btn', '.menu-btn',
  '.tools > .icon-btn', '.tools > .btn.is-primary',
  '.reader.is-chrome .reader-top .icon-btn', '.reader.is-chrome .bottom-row .icon-btn',
  '.reader.is-chrome .bottom-act',
  '.loading-back',
].join(', ');
const symbols = {
  sidebar: 'sidebar.left', menu: 'sidebar.left', back: 'chevron.left', close: 'xmark',
  more: 'ellipsis', checkCircle: 'checkmark.circle', plus: 'plus', sync: 'arrow.triangle.2.circlepath',
  cloudOff: 'icloud.slash', bookmark: 'bookmark', bookmarkOn: 'bookmark.fill',
  type: 'textformat.size', prev: 'chevron.left', next: 'chevron.right',
  list: 'list.bullet', search: 'magnifyingglass', headphones: 'headphones',
  moon: 'moon', sun: 'sun.max', gear: 'gearshape', scroll: 'arrow.down', pages: 'book',
};

export function mountAppleInterface(platform, size) {
  const root = document.documentElement;
  root.dataset.appleInterface = platform;
  root.dataset.appleSize = ['compact', 'comfortable', 'large'].includes(size) ? size : 'comfortable';
  const stylesheet = document.createElement('link');
  stylesheet.rel = 'stylesheet';
  stylesheet.href = new URL('../css/apple.css', import.meta.url);
  document.head.append(stylesheet);

  let frame = 0, sequence = 0, lastUpdate, busy = false, dirty = false, suspended = false;
  const ids = new WeakMap();
  let active = new Map();
  const schedule = () => {
    dirty = true;
    if (!busy && !frame) frame = requestAnimationFrame(update);
  };
  const covered = () => document.hidden || document.querySelector(
    'dialog[open], .pop-menu, .dropdown-menu, .reader-scrim:not([hidden]), .viewer, body.nav-open',
  );
  const viewport = window.visualViewport;
  const actions = () => {
    if (suspended || covered() || (viewport && (Math.abs(viewport.scale - 1) > 0.01 ||
      Math.abs(viewport.offsetTop) > 1 || Math.abs(viewport.offsetLeft) > 1 ||
      viewport.height < innerHeight - 1 || viewport.width < innerWidth - 1))) return [];
    return [...document.querySelectorAll(actionSelector)].flatMap((button) => {
      const symbol = symbols[button.querySelector('[data-apple-icon]')?.dataset.appleIcon];
      // The web control still shows animation and offline status during synchronization.
      if (!symbol || button.matches(':disabled, [aria-disabled=true], .is-spinning, .is-warn')) return [];
      const rect = button.getBoundingClientRect();
      if (rect.width < 30 || rect.height < 30) return [];
      const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
      // Sample inside the capsule to exclude partly clipped or covered controls.
      if (![[x, y], [rect.left + 5, y], [rect.right - 5, y], [x, rect.top + 5], [x, rect.bottom - 5]]
        .every(([left, top]) => button.contains(document.elementFromPoint(left, top)))) return [];
      const labelled = button.matches('.bottom-act');
      if (labelled && (rect.width < 82 || getComputedStyle(button).flexDirection === 'column')) return [];
      if (!ids.has(button)) ids.set(button, ++sequence);
      const reader = button.closest('.reader');
      const primary = button.matches('.tools > .btn.is-primary');
      return [{
        id: ids.get(button), symbol, primary, button,
        title: primary || labelled ? button.textContent.trim() : '',
        tooltip: button.title,
        textSize: labelled ? parseFloat(getComputedStyle(button).fontSize) :
          root.dataset.appleSize === 'large' ? 18 : 16,
        selected: button.classList.contains('is-on'),
        dark: reader ? reader.dataset.dark === 'true' : root.dataset.theme === 'dark',
        rect: [rect.left, rect.top, rect.width, rect.height].map((n) => Math.round(n * 2) / 2),
      }];
    });
  };

  function show(replacements) {
    for (const [id, button] of active) {
      if (!replacements.has(id)) delete button.dataset.nativeGlass;
    }
    for (const button of replacements.values()) button.dataset.nativeGlass = '';
    active = replacements;
  }

  async function update() {
    frame = 0;
    dirty = false;
    const handler = window.webkit?.messageHandlers?.susukoAppleChrome;
    if (!handler) return;
    const list = actions();
    const payload = list.map(({ button, ...data }) => data);
    const serialized = JSON.stringify(payload);
    if (lastUpdate === serialized) return;
    busy = true;
    try {
      const visible = new Set(await handler.postMessage(payload));
      lastUpdate = serialized;
      if (!suspended) {
        show(new Map(list.filter(({ id, button }) => visible.has(id) && button.isConnected)
          .map(({ id, button }) => [id, button])));
      }
    } catch {
      lastUpdate = undefined;
      show(new Map());
    } finally {
      busy = false;
      if (dirty) schedule();
    }
  }

  window.__susukoActivateGlass = (id) => {
    const button = active.get(id);
    if (button?.isConnected && !button.disabled && actions().some((action) => action.id === id)) button.click();
  };
  new MutationObserver(schedule).observe(document.body, {
    subtree: true, childList: true, attributes: true,
    attributeFilter: ['class', 'hidden', 'open', 'aria-label', 'aria-disabled', 'disabled', 'title', 'data-dark'],
  });
  new MutationObserver(schedule).observe(root, { attributeFilter: ['data-theme', 'data-apple-size'] });
  for (const event of ['resize', 'scroll', 'susuko-glass-ready', 'transitionend', 'animationend']) {
    window.addEventListener(event, schedule, { capture: true, passive: true });
  }
  document.addEventListener('visibilitychange', schedule);
  window.addEventListener('pagehide', () => {
    suspended = true;
    show(new Map());
    window.webkit?.messageHandlers?.susukoAppleChrome?.postMessage([]).catch(() => {});
  });
  window.addEventListener('pageshow', () => {
    suspended = false;
    lastUpdate = undefined;
    schedule();
  });
  const syncViewport = () => {
    if (platform === 'ios' && viewport) {
      const top = Math.round(Math.max(0, viewport.offsetTop));
      const bottom = Math.round(Math.max(0, innerHeight - viewport.offsetTop - viewport.height));
      const zoomed = Math.abs(viewport.scale - 1) > 0.01;
      root.style.setProperty('--apple-viewport-top', `${zoomed ? 0 : top}px`);
      root.style.setProperty('--apple-viewport-bottom', `${zoomed ? 0 : bottom}px`);
    }
    schedule();
  };
  viewport?.addEventListener('resize', syncViewport);
  viewport?.addEventListener('scroll', syncViewport);
  window.addEventListener('resize', syncViewport);
  window.addEventListener('pageshow', syncViewport);
  stylesheet.addEventListener('load', schedule);
  document.fonts.ready.then(schedule);
  syncViewport();
}
