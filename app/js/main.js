// 书架、详情、摘录、统计、设置、登录与路由。
import * as store from './store.js';
import { state, prefs } from './store.js';
import { h, icon, loader, toast, dialog, confirmDialog, promptDialog, dropdown, fmtPercent, fmtSize, fmtDuration } from './ui.js';
import * as ai from './ai.js';
import * as theme from './theme.js';
import { mountShelf } from './shelf3d.js';
import { labelOf, labelById, matchLabel, searchLabels, logoUrl } from './labels.js';
import { buildSpine, fitSpine } from './spine.js';
import { mountWinbar } from './winbar.js';
import { renderOnline } from './online.js';
import { importMenuSections, refreshMounts, mountsCard } from './mounts.js';

// 0.6 起立体书架是默认的书架视图（旧的“书脊”视图并入了它）
if (prefs.get('layout') === 'spine' || !prefs.get('layoutV')) { prefs.set('layout', 'shelf'); prefs.set('layoutV', 1); }

const app = document.getElementById('app');
const readerHost = document.getElementById('reader');

const view = {
  filter: prefs.get('filter', 'all'), // all | reading | finished | none | <合集 id> | series:<名> | stats | excerpts | settings
  sort: prefs.get('sort', 'recent'),
  layout: prefs.get('layout', 'shelf'), // shelf | grid | list
  query: '',
  selecting: false,
  selected: new Set(),
  detail: null, // 正在看详情的书
  spineIndex: 0,
  excerptType: 'all', excerptBook: null,
  settingsTab: 'account',
};

// ---------- 主题 ----------
export function applyTheme() {
  const t = prefs.get('theme', 'auto');
  const dark = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  theme.applyAccent(); // 主题色的深浅两套跟着切换
  // Windows 客户端：让系统的云母材质跟着应用的深浅色走
  try { window.__TAURI__?.window?.getCurrentWindow?.().setTheme(t === 'auto' ? null : t)?.catch?.(() => {}); } catch { /* 网页版没有这个接口 */ }
}
// Windows 11 客户端的窗口背景是系统云母材质，界面要让出透明的地方给它
(async () => {
  try {
    if (!store.isNativeShell || !navigator.userAgentData) return;
    const info = await navigator.userAgentData.getHighEntropyValues(['platformVersion']);
    if (navigator.userAgentData.platform === 'Windows' && parseInt(info.platformVersion, 10) >= 13) document.documentElement.classList.add('is-mica');
  } catch { /* 判断不了就用普通背景 */ }
})();
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
applyTheme();

// 安卓客户端的原生层在按下音量键时调用这里，阅读器监听 volumekey 事件来翻页
window.__volumeKey = (dir) => { window.dispatchEvent(new CustomEvent('volumekey', { detail: dir })); };

async function guard(job, okMessage) {
  try { await job(); if (okMessage) toast(okMessage); return true; }
  catch (e) { toast(e.message || '操作失败', { error: true }); return false; }
}

// ---------- 头像 ----------
function avatarEl(size = 32) {
  const p = store.profile();
  const el = h('span.avatar', { style: `--s:${size}px`, 'aria-hidden': 'true' }, h('span', (p.nickname || '?').slice(0, 1)));
  if (p.avatarAt) store.avatarUrl().then((url) => { if (url) el.replaceChildren(h('img', { src: url, alt: '' })); }).catch(() => {});
  return el;
}
function pickAvatar() {
  const input = h('input', { type: 'file', accept: 'image/*', hidden: true });
  input.addEventListener('change', () => {
    const f = input.files[0];
    if (f) guard(() => store.setAvatar(f), '头像已更新').then(() => renderAll());
  });
  document.body.append(input); input.click(); setTimeout(() => input.remove(), 60000);
}

// ---------- 登录 ----------
/** 登录 / 注册表单。onDone 在成功后调用。first：首次打开时显示“先在本机使用” */
function loginForm({ first = false, onDone }) {
  let mode = 'login';
  const url = h('input.field', {
    type: 'url', placeholder: 'https://books.example.com', autocomplete: 'url', required: true,
    value: store.account()?.url || (store.isNativeShell || !/^https?:$/.test(location.protocol) ? '' : location.origin),
  });
  const username = h('input.field', { type: 'text', autocomplete: 'username', required: true, maxLength: 32, placeholder: '用户名' });
  const password = h('input.field', { type: 'password', autocomplete: 'current-password', required: true, minLength: 6, placeholder: '至少 6 位' });
  const nickname = h('input.field', { type: 'text', maxLength: 40, placeholder: '显示在书架上的名字，可不填' });
  const invite = h('input.field', { type: 'password', placeholder: '启动服务端时设置的 SHIORI_KEY' });
  const regOnly = h('div.reg-only', h('label.field-label', '昵称'), nickname, h('label.field-label', '邀请码'), invite,
    h('p.field-hint', '注册需要邀请码，防止别人在你的服务器上开账号。第一个注册的账号会接管旧版本的书库。'));
  const error = h('p.form-error', { role: 'alert' });
  const submit = h('button.btn.is-primary.is-block', { type: 'submit' }, '登录');
  const tabs = h('div.segmented.is-wide', { role: 'tablist' });
  const draw = () => {
    tabs.replaceChildren(...[['login', '登录'], ['register', '注册账号']].map(([m, t]) => h('button' + (mode === m ? '.is-on' : ''), {
      type: 'button', role: 'tab', 'aria-selected': String(mode === m), onclick: () => { mode = m; draw(); },
    }, t)));
    regOnly.hidden = mode !== 'register';
    password.autocomplete = mode === 'register' ? 'new-password' : 'current-password';
    submit.textContent = mode === 'register' ? '注册并登录' : '登录';
    error.textContent = '';
  };
  draw();
  return h('form.login-form', {
    onsubmit: async (e) => {
      e.preventDefault();
      submit.disabled = true; error.textContent = '';
      const label = submit.textContent; submit.textContent = '正在连接…';
      try {
        await store.signIn(mode, { url: url.value, username: username.value, password: password.value, invite: invite.value, nickname: nickname.value });
        await onDone();
      } catch (err) { error.textContent = err.message; }
      finally { submit.disabled = false; submit.textContent = label; }
    },
  },
  tabs,
  h('label.field-label', '服务器地址'), url,
  h('label.field-label', '用户名'), username,
  h('label.field-label', '密码'), password,
  regOnly, error, submit,
  first && h('button.btn.is-quiet.is-block', { type: 'button', onclick: () => { store.useLocally(); startShelf(); } }, '先在本机使用，以后再登录'));
}

function renderWelcome() {
  app.replaceChildren(h('main.setup',
    h('div.setup-card',
      h('div.brand.is-large', h('img.brand-icon', { src: 'icon-96.png', alt: '' }), h('span.brand-name', 'スス子文庫')),
      h('p.setup-lead', '登录你自己服务器上的账号，书、进度、划线和批注会在每台设备上同步。不登录也能在这台设备上正常使用。'),
      loginForm({ first: true, onDone: afterSignIn }))));
}

async function afterSignIn() {
  document.querySelectorAll('dialog[open]').forEach((d) => d.close());
  startShelf();
  const n = await store.localLibrarySize();
  if (n && await confirmDialog('上传本机的书', `这台设备上还有 ${n} 本只存在本机的书。要把它们连同进度、划线批注和阅读时长一起上传到这个账号吗？`, { ok: '上传' })) {
    const t = toast('', { sticky: true });
    const r = await store.uploadLocalLibrary((i, total, b) => t.update(`正在上传 ${i} / ${total}：${b.title}`));
    t.done(r.failed ? `已上传 ${r.moved} 本，${r.failed} 本失败（留在本机书库）` : `已上传 ${r.moved} 本`, !!r.failed);
  }
}

// ---------- 书架 ----------
let els = null;
const coverCache = new Map(); // 已解析好的封面地址，避免重绘闪烁
const isSeries = (filter) => filter.startsWith('series:');
const isTag = (filter) => filter.startsWith('tag:');
const PAGES = ['stats', 'excerpts', 'settings', 'tags', 'online'];
/** 所有标签和用到它的书的数量（同系列多卷只算一次，免得一套 30 卷的书把标签数撑得很大） */
function allTags() {
  const count = new Map();
  for (const b of Object.values(state.books)) for (const t of new Set(b.tags || [])) {
    const key = `${t}\u0000${b.series || b.id}`;
    if (count.has(key)) continue;
    count.set(key, 1);
  }
  const out = new Map();
  for (const key of count.keys()) { const t = key.split('\u0000')[0]; out.set(t, (out.get(t) || 0) + 1); }
  return [...out].sort((a, b) => b[1] - a[1] || store.natural(a[0], b[0]));
}
const isPage = (filter) => PAGES.includes(filter);

function booksIn(filter) {
  const all = Object.values(state.books);
  if (filter === 'all') return all;
  if (filter === 'reading' || filter === 'finished') return all.filter((b) => store.statusOf(b) === filter);
  if (filter === 'none') return all.filter((b) => !b.collections.length);
  if (isPage(filter)) return [];
  if (isSeries(filter)) return all.filter((b) => b.series === filter.slice(7));
  if (isTag(filter)) return all.filter((b) => (b.tags || []).includes(filter.slice(4)));
  return all.filter((b) => b.collections.includes(filter));
}
function filterName(filter) {
  if (isSeries(filter)) return filter.slice(7);
  if (isTag(filter)) return '#' + filter.slice(4);
  return { all: '全部', reading: '在读', finished: '已读完', none: '未分类', stats: '阅读统计', excerpts: '摘录与批注', settings: '设置', tags: '标签', online: '在线书库' }[filter]
    || state.collections[filter]?.name || '全部';
}
function openSeries(name) {
  if (!isSeries(view.filter)) view.back = view.filter;
  setFilter('series:' + name, true);
}
/** keepSelect：进出系列时保留多选状态，方便先找到书再勾选 */
function setFilter(filter, keepSelect = false) {
  if (document.body.classList.contains('nav-open')) setDrawer(false);
  view.filter = filter;
  if (!isSeries(filter) && !isPage(filter)) prefs.set('filter', filter);
  if (!keepSelect) exitSelect(false);
  view.spineIndex = 0;
  if (isPage(filter) || view.autoDetail) { view.detail = null; view.autoDetail = false; }
  renderAll();
  els.main.scrollTop = 0;
}
function setLayout(layout) {
  view.layout = layout; prefs.set('layout', layout);
  if (view.autoDetail) { view.detail = null; view.autoDetail = false; }
  exitSelect(false);
  renderAll();
}

function renderShelf() {
  const search = h('input.search-input', {
    type: 'search', placeholder: '书名、作者、画师、出版社', 'aria-label': '搜索书名、作者、画师、出版社',
    oninput: () => { view.query = search.value.trim().toLowerCase(); renderBody(); },
    onkeydown: (e) => { if (e.key === 'Escape') { search.value = ''; view.query = ''; searchBox.classList.remove('is-open'); renderBody(); } },
  });
  const searchBox = h('div.search',
    h('button.icon-btn', {
      type: 'button', 'aria-label': '搜索', title: '搜索',
      onclick: () => { searchBox.classList.add('is-open'); search.focus(); },
    }, icon('search')),
    search);
  search.addEventListener('blur', () => { if (!search.value) searchBox.classList.remove('is-open'); });
  const fileInput = h('input', {
    type: 'file', multiple: true, hidden: true, accept: '.epub,.cbz,.zip,application/epub+zip,application/zip',
    onchange: () => { importFiles([...fileInput.files]); fileInput.value = ''; },
  });

  els = {
    nav: h('nav.side-nav', { 'aria-label': '书架分类' }),
    me: h('button.me-chip', { type: 'button', onclick: () => { view.settingsTab = 'account'; setFilter('settings'); } }),
    heading: h('div.heading'),
    tools: h('div.tools'),
    body: h('div.body'),
    bar: h('div.select-bar', { hidden: true }),
    pill: h('button.continue-pill', { type: 'button', hidden: true }),
    detail: h('aside.detail', { hidden: true, 'aria-label': '图书详情' }),
    search, searchBox, fileInput,
  };
  els.layoutSeg = h('div.icon-seg', { role: 'group', 'aria-label': '查看方式' });
  els.sort = dropdown({
    label: '排序方式', value: view.sort, options: [['recent', '最近阅读'], ['added', '最近添加'], ['published', '出版时间'], ['title', '按书名']],
    onChange: (v) => { view.sort = v; prefs.set('sort', v); renderBody(); },
  });
  els.selectBtn = h('button.icon-btn', { type: 'button', onclick: () => (view.selecting ? exitSelect() : enterSelect()) }, icon('checkCircle'));
  els.syncBtn = h('button.icon-btn', { type: 'button', onclick: manualSync });
  els.importBtn = h('button.btn.is-primary', { type: 'button', 'aria-haspopup': 'menu', onclick: () => importMenu(els.importBtn) }, icon('plus', 18), '导入');
  els.intro = h('section.series-intro', { hidden: true });
  // 手机：左上角汉堡按钮打开侧栏抽屉；右上角“更多”收着视图、排序、选择、同步、导入
  els.menuBtn = h('button.icon-btn.menu-btn', { type: 'button', 'aria-label': '打开菜单', title: '菜单', onclick: () => setDrawer(true) }, icon('menu', 22));
  els.moreBtn = h('button.icon-btn.more-btn', { type: 'button', 'aria-label': '更多操作', title: '更多', 'aria-haspopup': 'menu', onclick: () => moreMenu(els.moreBtn) }, icon('more', 22));
  els.main = h('main.main', h('header.topbar', els.menuBtn, els.heading, els.tools), els.intro, els.body, fileInput);
  // 电脑：侧栏顶上一个按钮，收成只剩图标的窄条
  const sideBtn = h('button.icon-btn.side-toggle', { type: 'button', onclick: () => setSideMini(!prefs.get('sideMini', false)) }, icon('sidebar', 20));
  const appleBrand = window.__susukoApplePlatform && h('div.brand.apple-sidebar-brand',
    h('img.brand-icon', { src: 'icon-96.png', alt: '' }), h('span.brand-name', 'スス子文庫'));
  els.drawerClose = appleBrand && h('button.icon-btn.apple-drawer-close', {
    type: 'button', 'aria-label': '关闭侧栏', onclick: () => setDrawer(false),
  }, icon('close', 20));
  els.side = h('aside.side', h('div.side-top', appleBrand || null, sideBtn, els.drawerClose || null), els.nav, els.me);
  if (appleBrand) {
    els.side.id = 'library-sidebar';
    els.side.setAttribute('aria-label', '书架侧栏');
    els.menuBtn.setAttribute('aria-controls', els.side.id);
    els.menuBtn.setAttribute('aria-expanded', 'false');
  }
  els.sideBtn = sideBtn;
  els.shell = h('div.shell', els.side, els.main, els.detail, els.pill, els.bar, h('div.drawer-scrim', { onclick: () => setDrawer(false) }));
  app.replaceChildren(els.shell);
  setSideMini(prefs.get('sideMini', false), false);
  renderAll();
}

function setSideMini(on, save = true) {
  if (save) prefs.set('sideMini', on);
  els.shell.classList.toggle('is-mini', on);
  const label = on ? '展开侧栏' : '收起侧栏';
  els.sideBtn.title = label; els.sideBtn.setAttribute('aria-label', label); els.sideBtn.setAttribute('aria-expanded', String(!on));
}
function setDrawer(open) {
  const wasOpen = document.body.classList.contains('nav-open');
  document.body.classList.toggle('nav-open', open);
  els.menuBtn?.setAttribute('aria-expanded', String(open));
  if (els.drawerClose) {
    for (const section of [els.main, els.detail, els.pill, els.bar]) section.inert = open;
    if (open) {
      els.side.setAttribute('role', 'dialog');
      els.side.setAttribute('aria-modal', 'true');
      (els.nav.querySelector('.is-active') || els.drawerClose).focus();
    } else {
      els.side.removeAttribute('role');
      els.side.removeAttribute('aria-modal');
      if (wasOpen && els.menuBtn.getClientRects().length) els.menuBtn.focus({ preventScroll: true });
    }
    return;
  }
  if (open) els.nav.querySelector('.is-active, .nav-item')?.focus({ preventScroll: true });
}
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !document.body.classList.contains('nav-open')) return;
  if (els.drawerClose && document.querySelector('dialog[open]')) return;
  e.stopPropagation();
  setDrawer(false);
  if (!els.drawerClose) els.menuBtn.focus();
}, true);
if (window.__susukoApplePlatform) {
  matchMedia('(max-width: 760px)').addEventListener('change', (event) => {
    if (!event.matches && document.body.classList.contains('nav-open')) setDrawer(false);
  });
}

/** 手机上的“更多”菜单：视图、排序、选择、同步、导入 */
function moreMenu(anchor) {
  const tick = (on) => (on ? 'check' : 'blank');
  popMenu(anchor, [
    { title: '查看方式', items: [['shelf', '立体书架'], ['grid', '封面宫格'], ['list', '列表']].map(([v, label]) => ({ icon: tick(view.layout === v), label, on: view.layout === v, onclick: () => setLayout(v) })) },
    { title: '排序', items: [['recent', '最近阅读'], ['added', '最近添加'], ['published', '出版时间'], ['title', '按书名']].map(([v, label]) => ({ icon: tick(view.sort === v), label, on: view.sort === v, onclick: () => { view.sort = v; prefs.set('sort', v); els.sort.set?.(v); renderBody(); } })) },
    { items: [
      { icon: 'checkCircle', label: view.selecting ? '完成选择' : '选择多本', onclick: () => (view.selecting ? exitSelect() : enterSelect()) },
      ...(store.isConfigured() ? [{ icon: 'sync', label: '立即同步', onclick: manualSync }] : []),
      { icon: 'upload', label: '导入', sub: '本机文件、WebDAV、OPDS、网盘', onclick: () => importMenu(els.moreBtn) },
    ] },
  ]);
}

function renderAll() {
  if (!els) return;
  if (isSeries(view.filter)) { if (!booksIn(view.filter).length) view.filter = view.back || 'all'; }
  else if (isTag(view.filter)) { if (!booksIn(view.filter).length) view.filter = 'all'; } // 标签下没有书了就回到全部
  else if (!['all', 'reading', 'finished', 'none', ...PAGES].includes(view.filter) && !state.collections[view.filter]) view.filter = 'all';
  if (view.detail && !state.books[view.detail]) view.detail = null;
  renderNav(); renderMe(); renderHeading(); renderTools(); renderIntro(); renderBody(); renderBar(); renderPill(); renderDetail();
}

const NAV_COLORS = { online: '#0EA5E9', all: '#3B82F6', reading: '#F59E0B', finished: '#10B981', none: '#8B5CF6', collection: '#EAB308', excerpts: '#14B8A6', stats: '#EC4899', settings: '#64748B', tag: '#8B7BD8' };
function renderNav() {
  const active = isSeries(view.filter) ? view.back || 'all' : view.filter;
  const item = (filter, iconName, label, color, count) => h('button.nav-item' + (active === filter ? '.is-active' : '') + (filter.startsWith('tag') ? '.is-tag' : ''), {
    type: 'button', 'aria-current': active === filter ? 'page' : null, style: `--c:${color}`, onclick: () => setFilter(filter), title: label,
  }, icon(iconName, 20), h('span.nav-label', label), count != null && h('span.nav-count', count));
  const markCount = Object.values(state.marks).reduce((n, l) => n + Object.values(l).filter((m) => m.type !== 'bookmark').length, 0);
  els.nav.replaceChildren(
    item('all', 'books', '全部', NAV_COLORS.all, booksIn('all').length),
    item('reading', 'clock', '在读', NAV_COLORS.reading, booksIn('reading').length),
    item('finished', 'check', '已读完', NAV_COLORS.finished, booksIn('finished').length),
    item('none', 'inbox', '未分类', NAV_COLORS.none, booksIn('none').length),
    item('online', 'globe', '在线书库', NAV_COLORS.online),
    h('div.nav-section', h('span', '合集'),
      h('button.icon-btn.is-small', { type: 'button', 'aria-label': '新建合集', title: '新建合集', onclick: newCollection }, icon('plus', 16))),
    ...store.sortedCollections().map((c) => item(c.id, 'folder', c.name, NAV_COLORS.collection, booksIn(c.id).length)),
    h('button.nav-item.is-new', { type: 'button', onclick: newCollection }, icon('plus', 18), h('span.nav-label', '新建合集')),
    ...navTags(item),
    h('div.nav-section', h('span', '记录')),
    item('excerpts', 'quote', '摘录与批注', NAV_COLORS.excerpts, markCount || null),
    item('stats', 'chart', '阅读统计', NAV_COLORS.stats),
    item('settings', 'gear', '设置', NAV_COLORS.settings),
  );
  requestAnimationFrame(() => els.nav.querySelector('.is-active')?.scrollIntoView({ inline: 'nearest', block: 'nearest' }));
}

function navTags(item) {
  const tags = allTags();
  if (!tags.length) return [];
  const open = prefs.get('tagsOpen', false); // 默认收起
  const head = h('button.nav-section.nav-fold' + (open ? '.is-open' : ''), {
    type: 'button', 'aria-expanded': String(open), title: open ? '收起标签' : '展开标签',
    onclick: () => { prefs.set('tagsOpen', !open); renderNav(); },
  }, h('span', '标签'), h('span.nav-fold-n', String(tags.length)), icon('caret', 16));
  if (!open) {
    // 收起时，正在看的那个标签仍然留一行，免得找不到自己在哪
    const cur = isTag(view.filter) && tags.find(([t]) => 'tag:' + t === view.filter);
    return [head, cur && item(view.filter, 'tag', cur[0], NAV_COLORS.tag, cur[1])].filter(Boolean);
  }
  const shown = tags.slice(0, 12);
  return [
    head,
    ...shown.map(([t, n]) => item('tag:' + t, 'tag', t, NAV_COLORS.tag, n)),
    item('tags', 'tag', tags.length > shown.length ? `全部标签（${tags.length}）` : '标签一览', NAV_COLORS.tag),
  ];
}

function renderMe() {
  const p = store.profile();
  const status = store.isConfigured() ? (state.online ? '已同步' : state.authLost ? '登录已失效' : '离线') : '本机书库';
  els.me.replaceChildren(avatarEl(34), h('span.me-text', h('span.me-name', p.nickname), h('span.me-sub' + (state.authLost ? '.is-warn' : ''), status)));
  els.me.title = store.isConfigured() ? `${p.username} @ ${p.server}` : '只存在这台设备上的书库';
}

function renderHeading() {
  const f = view.filter;
  if (isSeries(f)) {
    els.heading.replaceChildren(
      h('button.icon-btn', { type: 'button', 'aria-label': `返回「${filterName(view.back || 'all')}」`, onclick: () => setFilter(view.back || 'all', true) }, icon('back')),
      h('h1', filterName(f)), h('span.heading-count', `${booksIn(f).length} 卷`));
    return;
  }
  if (isPage(f)) { els.heading.replaceChildren(h('h1', filterName(f))); return; }
  els.heading.replaceChildren(...[
    h('h1', filterName(f)),
    h('span.heading-count', String(booksIn(f).length)),
    state.collections[f] && h('button.icon-btn', { type: 'button', 'aria-label': '管理这个合集', title: '管理这个合集', onclick: manageCollection }, icon('more')),
  ].filter(Boolean));
}

function renderTools() {
  const page = isPage(view.filter);
  els.main.classList.toggle('is-page', page);
  if (page) {
    els.tools.replaceChildren(...(store.isConfigured() ? [els.syncBtn] : []));
    renderSync();
    return;
  }
  els.layoutSeg.replaceChildren(...[['shelf', 'spineView', '立体书架'], ['grid', 'gridView', '封面'], ['list', 'listView', '列表']].map(([v, ic, label]) => h('button' + (view.layout === v ? '.is-on' : ''), {
    type: 'button', 'aria-label': `${label}视图`, title: `${label}视图`, 'aria-pressed': String(view.layout === v), onclick: () => setLayout(v),
  }, icon(ic, 18))));
  const label = view.selecting ? '完成选择' : '选择';
  els.selectBtn.title = label; els.selectBtn.setAttribute('aria-label', label);
  els.selectBtn.classList.toggle('is-on', view.selecting);
  els.tools.replaceChildren(els.searchBox, els.layoutSeg, els.sort, els.selectBtn, ...(store.isConfigured() ? [els.syncBtn] : []), els.importBtn, els.moreBtn);
  renderSync();
}

// ---------- 系列介绍 ----------
function renderIntro() {
  const f = view.filter;
  // 立体书架下面已经有标题和简介了，系列页就不再在上面重复一张大卡片
  const show = isSeries(f) && !(view.layout === 'shelf' && !view.selecting && visibleBooks().length > 0);
  els.intro.hidden = !show;
  if (!show) return;
  const name = f.slice(7);
  const books = booksIn(f).sort(byVolume);
  if (!books.length) return;
  const first = books[0];
  const cur = books.find((b) => store.statusOf(b) !== 'finished') || books[books.length - 1];
  const done = books.filter((b) => store.statusOf(b) === 'finished').length;
  const own = state.series[name]?.description;
  const text = own || first.description || '';
  const desc = h('p.si-desc', text || '还没有系列简介。');
  const more = text.length > 120 && h('button.link-btn', { type: 'button', onclick: () => { desc.classList.toggle('is-open'); more.textContent = desc.classList.contains('is-open') ? '收起' : '展开全部'; } }, '展开全部');
  const people = [first.author, first.illustrator && `插画 ${first.illustrator}`, first.publisher].filter(Boolean).join(' · ');
  const sec = books.reduce((n, b) => n + store.secondsOf(b.id), 0);
  els.intro.replaceChildren(
    h('div.si-cover', coverOf(first)),
    h('div.si-main',
      h('p.si-kicker', '系列'),
      h('h2', name),
      people && h('p.si-people', people),
      h('div.si-stats',
        h('span', h('b', String(books.length)), ' 卷'),
        h('span', h('b', String(done)), ' 卷读完'),
        sec > 0 && h('span', '共读了 ', h('b', fmtDuration(sec)))),
      h('div.si-text', !own && first.description && h('span.si-source', '第 1 卷自带的介绍'), desc, more),
      h('div.si-actions',
        h('button.btn.is-primary', { type: 'button', onclick: () => openBook(cur.id) }, icon('dict', 18),
          store.statusOf(cur) === 'unread' && !done ? '从第 1 卷开始' : `继续读${cur.volume != null ? `第 ${cur.volume} 卷` : ''}`),
        h('button.btn', { type: 'button', onclick: () => editSeriesDescription(name, own || '') }, icon('pen', 18), own ? '修改简介' : '写简介'))));
}
function editSeriesDescription(name, value) {
  return dialog(`「${name}」的系列简介`, (close) => {
    const area = h('textarea.field.is-area', { value, rows: 8, maxLength: 8000, placeholder: '这个系列讲了什么？' });
    const status = h('p.field-hint', { role: 'status' });
    const books = booksIn('series:' + name).sort(byVolume);
    return h('form.dialog-body', { onsubmit: async (e) => { e.preventDefault(); if (await guard(() => store.setSeriesDescription(name, area.value), '系列简介已保存')) close(); } },
      area, status,
      h('div.dialog-actions',
        h('button.btn.is-quiet', { type: 'button', onclick: () => fillWithAi(area, status, seriesFacts(name, books)) }, icon('sparkle', 18), '让助手写'),
        h('button.btn', { type: 'button', onclick: () => close() }, '取消'),
        h('button.btn.is-primary', { type: 'submit' }, '保存')));
  });
}
const seriesFacts = (name, books) => ({ kind: 'series', title: name, author: books[0]?.author, illustrator: books[0]?.illustrator, publisher: books[0]?.publisher, volumes: books.length, existing: books[0]?.description });
/** 让阅读助手把简介写进文本框（边写边显示），写完由用户确认保存 */
async function fillWithAi(area, status, facts) {
  if (!ai.aiReady() || (!ai.aiSettings().key && /openai\.com/.test(ai.aiSettings().base))) {
    status.textContent = '还没有设置阅读助手的接口，请先到 设置 → 阅读助手 里填写。';
    return;
  }
  const before = area.value;
  status.textContent = '阅读助手正在写…';
  area.classList.add('is-writing');
  try {
    const text = await ai.chat(ai.describeMessages(facts), { onDelta: (t) => { area.value = t; area.scrollTop = area.scrollHeight; } });
    area.value = text.trim() || before;
    status.textContent = '写好了。助手不能上网，内容不一定准确，请看一遍再保存。';
  } catch (e) { area.value = before; status.textContent = `没写成：${e.message}`; }
  finally { area.classList.remove('is-writing'); }
}

function renderBody() {
  const f = view.filter;
  const shelfNow = !isPage(f) && view.layout === 'shelf' && !view.selecting && !view.query && visibleBooks().length > 0;
  els.main.classList.toggle('is-shelf', shelfNow);
  if (els.shelf && !shelfNow) { els.shelf.api.destroy(); els.shelf = null; }
  els.body.className = 'body';
  if (f === 'stats') return renderStats();
  if (f === 'excerpts') return renderExcerpts();
  if (f === 'settings') return renderSettings();
  if (f === 'tags') return renderTagCloud();
  if (f === 'online') return renderOnline(els.body, { importFiles });
  const list = visibleBooks();
  if (!list.length) return renderEmpty();
  if (view.layout === 'list') return renderList(list);
  if (view.layout === 'shelf' && !view.selecting && !view.query) return renderShelf3d(list);
  return renderGrid(list); // 搜索结果用宫格，一眼能看到更多
}
function renderTagCloud() {
  const tags = allTags();
  els.body.className = 'body tag-page';
  els.body.replaceChildren(tags.length
    ? h('div.tag-cloud', tags.map(([t, n]) => h('button.tag-chip.is-big', { type: 'button', onclick: () => setFilter('tag:' + t) }, '#' + t, h('small', String(n)))))
    : h('p.muted', '还没有标签。在书的“编辑信息”里可以加，自动查资料时也会带上 Bangumi 上的常用标签。'));
}

function visibleBooks() {
  let list = booksIn(view.filter);
  if (view.query) {
    const q = view.query;
    if (q.startsWith('#') && q.length > 1) list = list.filter((b) => (b.tags || []).some((t) => t.toLowerCase().includes(q.slice(1))));
    else list = list.filter((b) => [b.title, b.originalTitle, b.author, b.illustrator, b.publisher, b.series, ...(b.tags || [])].filter(Boolean).join(' ').toLowerCase().includes(q));
  }
  const readAt = (b) => state.progress[b.id]?.updatedAt || 0;
  if (isSeries(view.filter)) list.sort(byVolume);
  else if (view.sort === 'title') list.sort((a, b) => store.natural(a.series || a.title, b.series || b.title) || byVolume(a, b));
  else if (view.sort === 'added') list.sort((a, b) => b.addedAt - a.addedAt);
  else if (view.sort === 'published') list.sort((a, b) => (b.published || '').localeCompare(a.published || '') || byVolume(a, b)); // 新出的在前，没填的排最后
  else list.sort((a, b) => Math.max(readAt(b), b.addedAt) - Math.max(readAt(a), a.addedAt));
  return list;
}
function byVolume(a, b) { // 没有卷号的排在最后
  return (a.volume ?? 1e9) - (b.volume ?? 1e9) || store.natural(a.title, b.title);
}
function fallbackHue(text) {
  let n = 0;
  for (const ch of text) n = (n * 31 + ch.codePointAt(0)) % 360;
  return n;
}
const fmtPublished = (v) => { const [y, m, d] = String(v).split('-'); return `${y} 年${m ? ` ${+m} 月` : ''}${d ? ` ${+d} 日` : ''}`; };
const bookLabel = (book) => (book.series ? (book.volume != null ? `${book.series} ${book.volume}` : book.series) : book.title);

/** 浏览时把同系列的书叠成一本；搜索、系列页里逐本显示 */
function groupSeries(list) {
  const stacking = prefs.get('stack', true) && !view.query && !isSeries(view.filter);
  if (!stacking) return list.map((b) => ({ book: b }));
  const groups = new Map();
  for (const b of list) if (b.series) groups.set(b.series, [...(groups.get(b.series) || []), b]);
  const done = new Set(), out = [];
  for (const b of list) {
    const group = b.series ? groups.get(b.series) : null;
    if (group) { /* 填了系列名就算系列，哪怕只有一本 */ if (!done.has(b.series)) { done.add(b.series); out.push({ series: b.series, books: group }); } }
    else out.push({ book: b });
  }
  return out;
}

function coverOf(book) {
  const progress = state.progress[book.id]?.percent || 0;
  const cover = h('div.cover');
  const key = `${book.id}:${book.coverAt || 0}`;
  const img = h('img', { alt: '', loading: 'lazy', draggable: false });
  if (book.hasCover && coverCache.has(key)) { img.src = coverCache.get(key); cover.append(img); }
  else {
    const fb = h('div.cover-fallback', { style: `--hue:${fallbackHue(book.series || book.title)}` }, h('span', book.series || book.title));
    cover.append(fb);
    if (book.hasCover) {
      store.coverUrl(book).then((url) => { if (url) { coverCache.set(key, url); img.src = url; fb.replaceWith(img); } }).catch(() => {});
    }
  }
  if (store.statusOf(book) === 'reading') cover.append(h('span.ribbon', { style: `--p:${Math.min(1, progress).toFixed(3)}`, 'aria-hidden': 'true' }));
  return cover;
}
function coverSrc(book) { return book.hasCover ? coverCache.get(`${book.id}:${book.coverAt || 0}`) : null; }

function stackCard(name, books) {
  const sorted = [...books].sort(byVolume);
  const current = sorted.find((b) => store.statusOf(b) !== 'finished') || sorted[0]; // 封面用正在读的那一卷
  const cover = coverOf(current);
  const started = sorted.some((b) => store.statusOf(b) !== 'unread');
  if (view.selecting) { // 多选时：点开系列再勾选，角标显示这个系列里已选了几本
    const picked = books.filter((b) => view.selected.has(b.id)).length;
    cover.append(h('span.cover-check' + (picked ? '.is-on' : ''), picked ? String(picked) : null));
  }
  return h('button.book.is-stack', {
    type: 'button', title: view.selecting ? `点开「${name}」选择其中的书` : `${name}（共 ${books.length} 卷）`,
    onclick: () => openSeries(name),
    oncontextmenu: (e) => { e.preventDefault(); openSeries(name); },
  },
  h('div.stack', cover),
  h('span.book-title', name),
  h('span.book-meta',
    h('span.book-author', current.author || (current.format === 'cbz' ? '漫画' : '')),
    h('span.book-progress.is-done', started && current.volume != null ? `读到 ${current.volume} / 共 ${books.length} 卷` : `共 ${books.length} 卷`)));
}

/** 书的点按：多选时勾选；否则打开阅读。长按 / 右键进入多选 */
function pressable(el, book) {
  let pressTimer = null, longPressed = false;
  el.addEventListener('click', (e) => {
    if (e.target.closest('.info-btn')) return;
    if (longPressed) { longPressed = false; return; }
    if (view.selecting) toggleSelect(book.id); else openBook(book.id);
  });
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); if (!view.selecting) enterSelect(book.id); });
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' || view.selecting) return;
    longPressed = false;
    pressTimer = setTimeout(() => { longPressed = true; navigator.vibrate?.(10); enterSelect(book.id); }, 480);
  });
  for (const t of ['pointerup', 'pointercancel']) el.addEventListener(t, () => clearTimeout(pressTimer));
  el.addEventListener('pointermove', (e) => { if (Math.abs(e.movementX) + Math.abs(e.movementY) > 6) clearTimeout(pressTimer); });
  return el;
}
const infoBtn = (book) => h('span.info-btn', {
  role: 'button', tabIndex: 0, 'aria-label': `《${book.title}》的详情`, title: '详情',
  onclick: (e) => { e.stopPropagation(); showDetail(book.id); },
  onkeydown: (e) => { if (e.key === 'Enter') { e.stopPropagation(); showDetail(book.id); } },
}, icon('info', 18));

function bookCard(book) {
  const progress = state.progress[book.id]?.percent || 0;
  const status = store.statusOf(book);
  const selected = view.selected.has(book.id);
  const cover = coverOf(book);
  if (book.series && book.volume != null) cover.append(h('span.cover-vol', { 'aria-hidden': 'true' }, String(book.volume)));
  if (!state.downloaded.has(book.id)) cover.append(h('span.cover-badge', { title: '还没下载到这台设备，打开时边读边加载' }, icon('down', 14)));
  if (view.selecting) cover.append(h('span.cover-check' + (selected ? '.is-on' : ''), selected && icon('check', 16)));
  else cover.append(infoBtn(book));
  return pressable(h('button.book' + (selected ? '.is-selected' : ''), {
    type: 'button', 'aria-pressed': view.selecting ? String(selected) : null,
    title: [book.title, book.author && `作者：${book.author}`, book.illustrator && `插画：${book.illustrator}`].filter(Boolean).join('\n'),
  },
  cover,
  h('span.book-title', bookLabel(book)),
  h('span.book-meta',
    h('span.book-author', book.author || (book.format === 'cbz' ? '漫画' : '')),
    status === 'finished' ? h('span.book-progress.is-done', '读完')
      : status === 'reading' && h('span.book-progress', progress > 0 ? fmtPercent(Math.min(progress, 0.99)) : '在读'))), book);
}

function renderGrid(list) {
  els.body.className = 'body grid';
  els.body.replaceChildren(...groupSeries(list).map((g) => (g.book ? bookCard(g.book) : stackCard(g.series, g.books))));
}

// 列表视图：一行一本，像音乐播放器的歌曲列表
function renderList(list) {
  els.body.className = 'body list';
  const rows = groupSeries(list).map((g) => {
    if (g.series) {
      const first = [...g.books].sort(byVolume)[0];
      return h('button.row.is-stack', { type: 'button', onclick: () => openSeries(g.series) },
        h('span.row-cover', coverOf(first)),
        h('span.row-main', h('span.row-title', g.series), h('span.row-sub', h('span.tag', '系列'), first.author || '')),
        h('span.row-mid', first.publisher || ''),
        h('span.row-end', `${g.books.length} 卷`, icon('chevronRight', 18)));
    }
    const b = g.book;
    const p = state.progress[b.id]?.percent || 0;
    const st = store.statusOf(b);
    const selected = view.selected.has(b.id);
    const sec = store.secondsOf(b.id);
    return pressable(h('button.row' + (selected ? '.is-selected' : ''), { type: 'button', 'aria-pressed': view.selecting ? String(selected) : null },
      h('span.row-cover', coverOf(b)),
      h('span.row-main',
        h('span.row-title', bookLabel(b)),
        h('span.row-sub', h('span.tag', b.format === 'cbz' ? '漫画' : 'EPUB'), [b.author, b.illustrator && `插画 ${b.illustrator}`].filter(Boolean).join('　'))),
      h('span.row-mid', b.publisher || (b.series ? b.series : '')),
      h('span.row-end',
        h('span.row-progress' + (st === 'finished' ? '.is-done' : ''), st === 'finished' ? '读完' : st === 'reading' ? fmtPercent(Math.min(p, 0.99)) : '未读'),
        h('span.row-time', sec ? fmtDuration(sec) : ''),
        view.selecting ? h('span.row-check' + (selected ? '.is-on' : ''), selected && icon('check', 16)) : infoBtn(b))), b);
  });
  els.body.replaceChildren(...rows);
}

// 立体书架：书本沿弧线摆开，中间那本露出封面，下面是它的信息
function renderShelf3d(list) {
  els.body.className = 'body shelf';
  const items = groupSeries(list).map((g) => {
    const sorted = g.books ? [...g.books].sort(byVolume) : null;
    const b = g.book || sorted.find((x) => store.statusOf(x) !== 'finished') || sorted[0];
    return {
      key: g.series ? 's:' + g.series : b.id, book: b, group: g,
      title: g.series || (b.series ? b.series : b.title),
      volume: g.series ? null : b.series ? b.volume : null,
      colorKey: `${b.id}:${b.coverAt || 0}`, fallbackHue: fallbackHue(b.series || b.title),
      spine: spineSpec(b),
    };
  });
  const keys = items.map((i) => `${i.key}:${i.book.updatedAt || 0}`).join('|');
  if (els.shelf && els.shelf.keys === keys && els.body.contains(els.shelf.stage)) { drawShelfCaption(); return; }
  els.shelf?.api.destroy();
  const stage = h('div.shelf-host');
  const caption = h('div.shelf-caption', { 'aria-live': 'polite' });
  els.body.replaceChildren(stage, caption);
  view.spineIndex = Math.min(Math.max(0, view.spineIndex), items.length - 1);
  els.shelf = { keys, items, stage, caption };
  els.shelf.api = mountShelf(stage, items, {
    index: view.spineIndex,
    coverUrl: (b) => store.coverUrl(b),
    onFocus: (i) => { view.spineIndex = i; drawShelfCaption(); },
    onOpen: (i) => openShelfItem(items[i]),
  });
}
function spineSpec(b) {
  return {
    title: b.series || b.title, volume: b.series ? b.volume : null, author: b.author, illustrator: b.illustrator,
    label: labelOf(b), publisher: b.publisher, reading: store.statusOf(b) === 'reading',
    kind: b.format === 'cbz' ? 'manga' : 'novel', mark: b.imprintMark || '',
  };
}
function openShelfItem(it) {
  if (!it) return;
  if (it.group.series) openSeries(it.group.series); else openBook(it.book.id);
}
function drawShelfCaption() {
  const sh = els.shelf;
  const it = sh?.items[view.spineIndex];
  if (!it) return;
  const b = it.book, total = sh.items.length;
  const st = store.statusOf(b), p = state.progress[b.id]?.percent || 0;
  const meta = it.group.series
    ? [b.author, `共 ${it.group.books.length} 卷`, b.volume != null && st !== 'unread' && `读到第 ${b.volume} 卷`]
    : [b.author, b.illustrator && `插画 ${b.illustrator}`, { reading: `在读 ${fmtPercent(Math.min(p, 0.99))}`, finished: '已读完', unread: '未读' }[st]];
  const first = it.group.series ? [...it.group.books].sort(byVolume)[0] : b;
  const inSeries = isSeries(view.filter) && state.series[view.filter.slice(7)]?.description;
  const desc = (it.group.series && state.series[it.group.series]?.description) || first.description || b.description || inSeries || '';
  const open = () => openShelfItem(it);
  sh.caption.replaceChildren(
    h('div.cap-head',
      h('button.cap-cover', { type: 'button', 'aria-label': '打开', onclick: open }, coverOf(b)),
      h('div.cap-main',
        h('h2', it.title + (it.volume != null ? ` ${it.volume}` : '')),
        h('p', meta.filter(Boolean).join(' · ')),
        it.group.series ? null : h('div.cap-bar', h('span', { style: `width:${Math.round(Math.min(1, p) * 100)}%` }))),
      h('div.cap-actions',
        h('div.cap-nav',
          h('button.icon-btn', { type: 'button', 'aria-label': '上一本', onclick: () => sh.api.prev() }, icon('prev')),
          h('span.cap-count', h('b', String(view.spineIndex + 1)), ` / ${total}`),
          h('button.icon-btn', { type: 'button', 'aria-label': '下一本', onclick: () => sh.api.next() }, icon('next'))),
        !it.group.series && h('button.btn', { type: 'button', onclick: () => showDetail(b.id) }, '详情'),
        h('button.btn.is-primary', { type: 'button', onclick: open }, it.group.series ? '打开系列' : p > 0 ? '继续阅读' : '开始阅读'))),
    h('p.cap-desc' + (desc ? '' : '.is-empty'), desc ? desc.replace(/\s*\n\s*/g, ' ') : '还没有简介，可以在“编辑信息”里写。'));
  // 书架下面已经有标题和简介，不再自动弹出右侧详情；以前自动弹出的，滑走就关掉
  if (view.autoDetail && view.detail) hideDetail();
}

function renderEmpty() {
  els.body.className = 'body is-empty';
  let title, text, action = null;
  if (view.query) { title = `没有找到“${view.query}”`; text = '换个书名、作者、画师或出版社试试。'; }
  else if (!Object.keys(state.books).length) {
    title = '书架还是空的';
    text = store.isConfigured() ? '导入 EPUB 小说或 CBZ / ZIP 漫画，它们会出现在你的每台设备上。' : '导入 EPUB 小说或 CBZ / ZIP 漫画。现在是本机书库，登录账号后可以同步到其他设备。';
    action = h('button.btn.is-primary', { type: 'button', onclick: (e) => importMenu(e.currentTarget) }, icon('plus', 18), '导入第一本书');
  } else if (state.collections[view.filter]) { title = '这个合集还没有书'; text = '在书架上长按（或右键）一本书，选择“加入合集”。也可以直接在这里导入。'; }
  else if (view.filter === 'reading') { title = '没有正在读的书'; text = '打开任意一本书，它就会出现在这里。'; }
  else if (view.filter === 'finished') { title = '还没有读完的书'; text = '读到最后一页的书会自动出现在这里，也可以多选后手动标记。'; }
  else { title = '所有书都已归入合集'; text = ''; }
  els.body.replaceChildren(h('div.empty', h('h2', title), text && h('p', text), action));
}

// ---------- 继续阅读浮条 ----------
function lastRead() {
  let best = null, at = 0;
  for (const [id, p] of Object.entries(state.progress)) {
    if (state.books[id] && p.updatedAt > at && store.statusOf(state.books[id]) !== 'finished') { best = state.books[id]; at = p.updatedAt; }
  }
  return best;
}
function renderPill() {
  syncCoverAccent();
  const b = !view.selecting && !isPage(view.filter) && lastRead();
  els.pill.hidden = !b;
  document.body.classList.toggle('has-pill', !!b);
  if (!b) return;
  const p = state.progress[b.id]?.percent || 0;
  els.pill.onclick = () => openBook(b.id);
  els.pill.title = '继续阅读';
  els.pill.replaceChildren(
    h('span.pill-cover', coverOf(b)),
    h('span.pill-text', h('span.pill-title', bookLabel(b)), h('span.pill-sub', `继续阅读 · ${fmtPercent(Math.min(p, 0.99))}${b.author ? ' · ' + b.author : ''}`)),
    h('span.pill-ring', { style: `--p:${Math.min(1, p)}` }, icon('play', 16)),
    h('span.pill-fab', { 'aria-hidden': 'true' }, icon('openBook', 26)));
  els.pill.setAttribute('aria-label', `继续阅读《${bookLabel(b)}》`);
  els.pill.style.setProperty('--p', Math.min(1, p));
}
/** 手机上右下角的样子：封面圆钮（默认）/ 图标圆钮 / 横条 */
const FAB_STYLES = [['cover', '封面圆钮'], ['icon', '图标圆钮'], ['bar', '横条']];
function applyFabStyle() {
  const v = prefs.get('fab', 'cover');
  for (const [k] of FAB_STYLES) document.body.classList.toggle('fab-' + k, k === v);
}

// ---------- 图书详情 ----------
function showDetail(id) { view.detail = id; view.autoDetail = false; renderDetail(); }
function hideDetail() { view.detail = null; view.autoDetail = false; renderDetail(); }
function renderDetail() {
  const b = view.detail && state.books[view.detail];
  els.detail.hidden = !b;
  document.body.classList.toggle('has-detail', !!b);
  if (!b) return;
  const p = state.progress[b.id]?.percent || 0;
  const st = store.statusOf(b);
  const sec = store.secondsOf(b.id);
  const marks = store.marksOf(b.id);
  const hl = marks.filter((m) => m.type === 'highlight').length;
  const desc = h('p.detail-desc', b.description || '还没有简介。可以在“编辑信息”里写。');
  const more = b.description && b.description.length > 160 && h('button.link-btn', { type: 'button', onclick: () => { desc.classList.toggle('is-open'); more.textContent = desc.classList.contains('is-open') ? '收起' : '展开全部'; } }, '展开全部');
  const facts = [
    b.illustrator && ['插画', b.illustrator], b.publisher && ['出版社', b.publisher],
    labelOf(b) && labelOf(b).name !== b.publisher && [labelOf(b).manga ? '漫画品牌' : '文库', labelOf(b).name], b.published && ['出版时间', fmtPublished(b.published)],
    b.series && ['系列', b.volume != null ? `${b.series} · 第 ${b.volume} 卷` : b.series],
    ['格式', b.format === 'cbz' ? '漫画（CBZ / ZIP）' : 'EPUB'], ['大小', fmtSize(b.size || 0)],
    ['阅读时长', sec ? fmtDuration(sec) : '还没开始'],
    ['加入书架', new Date(b.addedAt).toLocaleDateString()],
  ].filter(Boolean);
  els.detail.replaceChildren(
    h('header.detail-head',
      h('button.icon-btn', { type: 'button', 'aria-label': '关闭详情', onclick: hideDetail }, icon('close')),
      h('span', '图书详情')),
    h('div.detail-scroll',
      h('div.detail-top',
        h('div.detail-cover', coverOf(b)),
        h('div.detail-id',
          h('h2', b.title),
          b.author && h('button.link-btn.detail-author', { type: 'button', onclick: () => { els.search.value = b.author; view.query = b.author.toLowerCase(); els.searchBox.classList.add('is-open'); setFilter('all'); } }, b.author, icon('chevronRight', 16)),
          h('p.detail-status', h('span.status-dot.is-' + st), { reading: `在读 · ${fmtPercent(Math.min(p, 0.99))}`, finished: '已读完', unread: '未读' }[st]),
          b.rating > 0 && h('p.detail-stars', { 'aria-label': `${b.rating} 星` }, '★'.repeat(b.rating) + '☆'.repeat(5 - b.rating)),
          h('div.detail-tags', b.collections.map((c) => state.collections[c] && h('button.chip-tag', { type: 'button', onclick: () => setFilter(c) }, state.collections[c].name))))),
      h('div.detail-actions',
        h('button.btn.is-primary.is-grow', { type: 'button', onclick: () => openBook(b.id) }, icon('dict', 18), p > 0 ? '继续阅读' : '开始阅读'),
        h('button.btn', { type: 'button', onclick: () => editBook(b.id) }, '编辑信息')),
      h('section.detail-sec', h('h3', '简介'), desc, more),
      (b.tags || []).length > 0 && h('section.detail-sec', h('h3', '标签'),
        h('div.tag-row', b.tags.map((t) => h('button.tag-chip', { type: 'button', title: `看看所有 #${t} 的书`, onclick: () => setFilter('tag:' + t) }, '#' + t)))),
      b.review && h('section.detail-sec', h('h3', '我的书评'), h('p.detail-review', b.review)),
      marks.length > 0 && h('section.detail-sec',
        h('button.detail-link', { type: 'button', onclick: () => { view.excerptBook = b.id; setFilter('excerpts'); } },
          icon('quote', 18), h('span', `${hl} 条划线，${marks.length - hl} 条书签与笔记`), icon('chevronRight', 18))),
      h('dl.facts.detail-facts', facts.map(([k, v]) => [h('dt', k), h('dd', v)])),
      h('div.detail-more',
        store.isConfigured() && (state.downloaded.has(b.id)
          ? h('button.btn.is-quiet', { type: 'button', onclick: () => removeCopies([b.id]) }, '移除本机副本')
          : h('button.btn.is-quiet', { type: 'button', onclick: () => downloadBooks([b.id]) }, icon('down', 18), '下载到本机')),
        h('button.btn.is-quiet.is-danger', { type: 'button', onclick: () => deleteBooks([b.id]) }, icon('trash', 18), '删除'))));
}

function renderSync() {
  if (!store.isConfigured()) return;
  const label = state.syncing ? '正在同步' : state.online ? '已同步，点击立即同步' : state.authLost ? '登录已失效，请重新登录' : '离线，点击重试';
  els.syncBtn.replaceChildren(icon(state.online || state.syncing ? 'sync' : 'cloudOff'));
  els.syncBtn.className = 'icon-btn' + (state.syncing ? ' is-spinning' : '') + (!state.online && !state.syncing ? ' is-warn' : '');
  els.syncBtn.title = label; els.syncBtn.setAttribute('aria-label', label);
}
async function manualSync() {
  if (state.authLost) { view.settingsTab = 'account'; setFilter('settings'); return; }
  try { await store.sync(); toast('已同步'); } catch (e) { toast(e.message, { error: true }); }
}

// ---------- 多选 ----------
function enterSelect(id) {
  view.selecting = true; view.selected = new Set(id ? [id] : []);
  renderTools(); renderBody(); renderBar(); renderPill();
}
function exitSelect(render = true) {
  view.selecting = false; view.selected.clear();
  if (render) { renderTools(); renderBody(); renderBar(); renderPill(); }
}
function toggleSelect(id) {
  if (view.selected.has(id)) view.selected.delete(id); else view.selected.add(id);
  renderBody(); renderBar();
}
function renderBar() {
  els.bar.hidden = !view.selecting;
  if (!view.selecting) return;
  const ids = [...view.selected].filter((id) => state.books[id]);
  const n = ids.length;
  const inCollection = !!state.collections[view.filter];
  const act = (label, fn, cls = '') => h('button.btn' + cls, { type: 'button', disabled: !n, onclick: () => fn(ids) }, label);
  els.bar.replaceChildren(
    h('span.select-count', n ? `已选 ${n} 本` : '点选要整理的书'),
    h('div.select-actions',
      act('加入合集', pickCollections, '.is-primary'),
      inCollection && act('移出本合集', removeFromCurrent),
      n === 1 ? act('详情', ([id]) => { exitSelect(); showDetail(id); }) : act('设为系列', setSeries),
      n === 1 && act('编辑信息', ([id]) => editBook(id)),
      act('标记状态', setStatus),
      store.isConfigured() && ids.some((id) => !state.downloaded.has(id)) && act('下载到本机', downloadBooks),
      store.isConfigured() && ids.some((id) => state.downloaded.has(id)) && act('移除本机副本', removeCopies),
      act('删除', deleteBooks, '.is-danger'),
      h('button.btn.is-quiet', { type: 'button', onclick: () => exitSelect() }, '完成')),
  );
}

function pickCollections(ids) {
  const books = ids.map((id) => state.books[id]);
  return dialog('加入合集', (close) => {
    const listEl = h('div.check-list');
    const boxes = new Map();
    const addRow = (c, checked, mixed = false) => {
      const box = h('input', { type: 'checkbox', checked, indeterminate: mixed });
      boxes.set(c.id, box);
      listEl.append(h('label.check-row', box, h('span', c.name)));
    };
    for (const c of store.sortedCollections()) {
      const count = books.filter((b) => b.collections.includes(c.id)).length;
      addRow(c, count === books.length, count > 0 && count < books.length);
    }
    const empty = h('p.dialog-text', '还没有合集。在下面起个名字，新建第一个。');
    if (!boxes.size) listEl.append(empty);
    const name = h('input.field', { type: 'text', placeholder: '新合集的名字', maxLength: 60, 'aria-label': '新合集的名字' });
    const create = async () => {
      const v = name.value.trim(); if (!v) return;
      await guard(async () => { const c = await store.createCollection(v); empty.remove(); addRow(c, true); name.value = ''; });
    };
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); create(); } });
    return h('div.dialog-body', listEl,
      h('div.inline-form', name, h('button.btn', { type: 'button', onclick: create }, '新建')),
      h('div.dialog-actions',
        h('button.btn', { type: 'button', onclick: () => close() }, '取消'),
        h('button.btn.is-primary', {
          type: 'button',
          onclick: async () => {
            const ok = await guard(async () => {
              for (const b of books) {
                const set = new Set(b.collections);
                for (const [cid, box] of boxes) {
                  if (box.indeterminate) continue;
                  if (box.checked) set.add(cid); else set.delete(cid);
                }
                const next = [...set];
                if (next.length !== b.collections.length || next.some((c) => !b.collections.includes(c))) {
                  await store.updateBook(b.id, { collections: next });
                }
              }
            }, '合集已更新');
            if (ok) { close(); exitSelect(); }
          },
        }, '保存')));
  });
}

async function removeFromCurrent(ids) {
  const cid = view.filter;
  const ok = await guard(async () => {
    for (const id of ids) await store.updateBook(id, { collections: state.books[id].collections.filter((c) => c !== cid) });
  }, `已移出「${filterName(cid)}」`);
  if (ok) exitSelect();
}
async function removeCopies(ids) {
  await guard(async () => { for (const id of ids) await store.removeLocalCopy(id); }, '已移除本机副本，书仍保留在服务器上');
  exitSelect();
}
async function downloadBooks(ids) {
  const todo = ids.filter((id) => !state.downloaded.has(id));
  exitSelect();
  const t = toast('', { sticky: true });
  let failed = 0;
  for (const [i, id] of todo.entries()) {
    const book = state.books[id];
    const label = `正在下载 ${i + 1} / ${todo.length}：${store.seriesLabel(book)}`;
    t.update(label);
    try { await store.downloadBook(book, (p) => t.update(`${label}　${Math.round(p * 100)}%`)); }
    catch { failed++; }
  }
  t.done(failed ? `${todo.length - failed} 本已下载，${failed} 本失败，请检查网络后重试` : `已下载 ${todo.length} 本到本机`, !!failed);
}

const STATUSES = [['', '按进度自动'], ['reading', '在读'], ['finished', '已读完']];
function setStatus(ids) {
  return dialog('标记状态', (close) => h('div.dialog-body',
    h('div.menu', STATUSES.map(([value, label]) => h('button.menu-item', {
      type: 'button',
      onclick: async () => {
        const ok = await guard(async () => { for (const id of ids) await store.updateBook(id, { status: value }); }, value ? `已标为「${label}」` : '已改回按进度自动判断');
        if (ok) { close(); exitSelect(); }
      },
    }, label))),
    h('p.field-hint', '手动标记不会改动阅读进度，下次打开仍然从上次的位置继续。')));
}

function commonPrefix(titles) {
  let prefix = titles[0] || '';
  for (const t of titles) { while (prefix && !t.startsWith(prefix)) prefix = prefix.slice(0, -1); }
  return prefix.replace(/[\s　_\-—~～:：(（\[【第]*\d*\s*$/, '').trim();
}
/** 把选中的几本书设成同一个系列，并自动编卷号 */
function setSeries(ids) {
  const books = ids.map((id) => state.books[id]).sort((a, b) => store.natural(a.title, b.title));
  const existing = books.find((b) => b.series)?.series;
  const guess = existing || store.guessSeries(books[0].title)?.series || commonPrefix(books.map((b) => b.title));
  return dialog('设为系列', (close) => {
    const name = h('input.field', { type: 'text', value: guess, maxLength: 200, placeholder: '系列的名字', 'aria-label': '系列的名字' });
    const apply = async (series) => {
      // 卷号优先取书名里的数字；取不到或有重复，就按书名顺序从 1 开始编
      let volumes = books.map((b) => store.guessSeries(b.title)?.volume ?? b.volume ?? null);
      if (volumes.includes(null) || new Set(volumes).size !== volumes.length) volumes = books.map((_, i) => i + 1);
      const ok = await guard(async () => {
        for (const [i, b] of books.entries()) await store.updateBook(b.id, series ? { series, volume: volumes[i] } : { series: '', volume: null });
      }, series ? `已归入系列「${series}」` : '已取消系列');
      if (ok) { close(); exitSelect(); }
    };
    return h('form.dialog-body', { onsubmit: (e) => { e.preventDefault(); if (name.value.trim()) apply(name.value.trim()); } },
      h('label.field-label', '系列的名字'), name,
      h('p.field-hint', `这 ${books.length} 本书会按书名里的数字编卷号；书名里没有数字的，按书名顺序从 1 开始。编错的可以单选一本，在“编辑信息”里改。`),
      h('div.dialog-actions',
        books.some((b) => b.series) && h('button.btn.is-danger', { type: 'button', onclick: () => apply('') }, '取消系列'),
        h('button.btn', { type: 'button', onclick: () => close() }, '取消'),
        h('button.btn.is-primary', { type: 'submit' }, '保存')));
  });
}

async function deleteBooks(ids) {
  const what = ids.length === 1 ? `《${state.books[ids[0]].title}》` : `这 ${ids.length} 本书`;
  const where = store.isConfigured() ? '会从服务器和所有设备上删除' : '会从这台设备上删除';
  if (!await confirmDialog('删除书籍', `${what}${where}，阅读进度、划线和批注也会一并清除。`, { ok: '删除', danger: true })) return;
  const ok = await guard(async () => { for (const id of ids) await store.deleteBook(id); }, '已删除');
  if (ok) exitSelect();
}

/** 自动查资料：搜索 → 显示候选（带推荐）→ 选一个、勾要填的字段 → 返回给编辑表单 */
function lookupMeta(seed) {
  if (!store.isConfigured()) { toast('自动查资料要经过你的服务器，请先登录账号', { error: true }); return Promise.resolve(null); }
  return dialog('自动查资料', (close) => {
    const q = h('input.field', { type: 'search', value: seed.query, placeholder: '书名、俗称都行，例如：赛勃鹏客', 'aria-label': '要查的名字' });
    let kind = seed.kind;
    const kindSeg = h('div.segmented', { role: 'group', 'aria-label': '类型' }, [['novel', '轻小说'], ['manga', '漫画']].map(([v, t]) => h('button' + (kind === v ? '.is-on' : ''), {
      type: 'button', onclick: (e) => { kind = v; for (const b of e.currentTarget.parentElement.children) b.classList.toggle('is-on', b === e.currentTarget); },
    }, t)));
    const steps = h('ul.meta-steps', { role: 'status' });
    const list = h('div.meta-list');
    const detail = h('div.meta-pick');
    const go = h('button.btn.is-primary', { type: 'submit' }, '查找');
    async function run() {
      go.disabled = true; list.replaceChildren(); detail.replaceChildren();
      steps.replaceChildren(h('li', '正在查找…（名字不标准时会先上网确认，可能要十几秒）'));
      const m = metaSettings(), a = ai.aiSettings();
      const judge = m.judge === 'custom' ? (m.base && { url: m.base.replace(/\/+$/, '') + '/chat/completions', key: m.key, model: m.model })
        : m.judge === 'assistant' && ai.aiReady() ? { url: a.base.replace(/\/+$/, '') + '/chat/completions', key: a.key, model: a.model } : null;
      try {
        const r = await store.metaLookup({ query: q.value.trim(), kind, author: seed.author, bangumiToken: m.bangumiToken, dsKey: m.dsKey, ai: judge || undefined });
        steps.replaceChildren(...r.steps.map((t) => h('li', t)));
        if (!r.candidates.length) { list.replaceChildren(h('p.muted', '没有找到。换个名字试试，或者在设置里填上 DeepSeek 搜索的 Key 让它先上网确认正式名字。')); return; }
        list.replaceChildren(...r.candidates.map((c, i) => h('button.meta-cand' + (i === r.pick ? '.is-pick' : ''), { type: 'button', onclick: () => choose(c, i === r.pick) },
          c.cover ? h('img', { src: c.cover, alt: '', loading: 'lazy', referrerPolicy: 'no-referrer' }) : h('span.meta-nocover'),
          h('span.meta-text',
            h('b', c.titleCn || c.title), c.titleCn && c.title && h('small', c.title),
            h('small', [c.author, c.publisher || c.label, c.date && c.date.slice(0, 4), c.platform].filter(Boolean).join(' · ')),
            h('span.meta-badges', i === r.pick && h('span.meta-badge.is-pick', `推荐${r.confidence ? ` · 把握 ${Math.round(r.confidence * 100)}%` : ''}`), h('span.meta-badge', c.source === 'bangumi' ? 'Bangumi' : 'AniList'))))));
        if (r.pick != null) choose(r.candidates[r.pick], true);
      } catch (e) { steps.replaceChildren(h('li.form-error', e.message)); }
      finally { go.disabled = false; }
    }
    function choose(c, recommended) {
      for (const el of list.children) el.classList.toggle('is-on', el.querySelector('b')?.textContent === (c.titleCn || c.title));
      const use = {};
      const opt = (k, label, value) => {
        if (!value || (Array.isArray(value) && !value.length)) return null;
        use[k] = true;
        return h('label.meta-field', h('input', { type: 'checkbox', checked: true, onchange: (e) => { use[k] = e.target.checked; } }),
          h('span', h('b', label), h('span', Array.isArray(value) ? value.map((t) => '#' + t).join(' ') : String(value).slice(0, 160) + (String(value).length > 160 ? '…' : ''))));
      };
      detail.replaceChildren(
        h('h3', recommended ? '推荐结果，要填哪些？' : '要填哪些？'),
        ...[opt('title', seed.volumeBook ? '系列名' : '书名', c.titleCn || c.title), opt('author', '作者', c.author), opt('illustrator', seed.kind === 'manga' ? '作画' : '插画', c.illustrator),
          opt('publisher', '出版社', c.label || c.publisher), opt('date', '出版时间', !seed.volumeBook && c.date), opt('summary', '简介', c.summary), opt('tags', '标签', c.tags)].filter(Boolean),
        c.aliases.length > 0 && h('p.field-hint', `别名：${c.aliases.slice(0, 8).join(' / ')}`),
        h('a.link-btn', { href: c.url, target: '_blank', rel: 'noopener' }, `在 ${c.source === 'bangumi' ? 'Bangumi' : 'AniList'} 上看看`),
        h('div.dialog-actions', h('button.btn.is-primary', { type: 'button', onclick: () => close({ candidate: c, use }) }, '填入')));
    }
    queueMicrotask(run);
    return h('form.dialog-body.meta-dialog', { onsubmit: (e) => { e.preventDefault(); run(); } },
      h('div.meta-search', q, kindSeg, go), steps, h('div.meta-cols', list, detail),
      h('div.dialog-actions', h('button.btn', { type: 'button', onclick: () => close(null) }, '关闭')));
  }, { wide: true });
}

/** 标签输入：回车、逗号或空格加一个，点 × 去掉；下面列出书库里已有的标签可以一点就加 */
function tagEditor(initial = []) {
  let tags = [...initial];
  const input = h('input.tag-input', { type: 'text', placeholder: tags.length ? '' : '输入标签后回车，例如：恋爱、校园、异世界', 'aria-label': '添加标签', enterKeyHint: 'done' });
  const chips = h('span.tag-chips');
  const box = h('div.tag-editor', { onclick: (e) => { if (e.target === box || e.target === chips) input.focus(); } }, chips, input);
  const suggest = h('div.tag-suggest');
  const known = allTags().map(([t]) => t);
  const add = (raw) => {
    for (const t of String(raw).split(/[,，、\s]+/).map((x) => x.replace(/^#/, '').trim().slice(0, 30)).filter(Boolean)) if (!tags.includes(t)) tags.push(t);
    input.value = ''; draw();
  };
  // 输入框本身始终留在原位，只重画前面的标签和下面的建议——挪动输入框会让它失去焦点、收起键盘
  function draw() {
    chips.replaceChildren(...tags.map((t) => h('span.tag-chip.is-edit', '#' + t, h('button', { type: 'button', 'aria-label': `去掉标签 ${t}`, onclick: (e) => { e.stopPropagation(); tags = tags.filter((x) => x !== t); draw(); } }, '×'))));
    input.placeholder = tags.length ? '' : '输入标签后回车，例如：恋爱、校园、异世界';
    const q = input.value.trim().toLowerCase();
    const opts = known.filter((t) => !tags.includes(t) && (!q || t.toLowerCase().includes(q))).slice(0, 12);
    suggest.replaceChildren(...opts.map((t) => h('button.tag-chip.is-ghost', { type: 'button', onpointerdown: (e) => e.preventDefault(), onclick: () => { add(t); input.focus(); } }, '+ ' + t)));
  }
  input.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return; // 输入法还在选字
    if ((e.key === 'Enter' || e.key === ',' || e.key === '，') && input.value.trim()) { e.preventDefault(); add(input.value); }
    else if (e.key === 'Enter') e.preventDefault(); // 空回车不提交整个表单
    else if (e.key === 'Backspace' && !input.value && tags.length) { tags.pop(); draw(); }
  });
  input.addEventListener('input', (e) => { if (e.isComposing) return; if (/[,，、]/.test(input.value)) add(input.value); else draw(); });
  input.addEventListener('compositionend', () => { if (/[,，、]/.test(input.value)) add(input.value); else draw(); });
  input.addEventListener('blur', () => { if (input.value.trim()) add(input.value); });
  draw();
  return { el: h('div', box, suggest), get: () => (input.value.trim() ? (add(input.value), tags) : tags), set: (list) => { tags = [...new Set(list)]; draw(); } };
}

/** 把 2024/7/18、2024.07 这类写法整理成 2024-07-18 / 2024-07 */
function normDate(v) {
  const m = String(v || '').trim().match(/^(\d{4})(?:[-/.年](\d{1,2})(?:[-/.月](\d{1,2}))?)?/);
  if (!m) return '';
  return [m[1], m[2] && m[2].padStart(2, '0'), m[3] && m[3].padStart(2, '0')].filter(Boolean).join('-');
}
/** 输入框 + 下拉检索：打字时列出匹配的文库，方向键选、回车确定 */
function comboBox(input, search, onPick) {
  const list = h('div.combo-list', { role: 'listbox', hidden: true });
  let rows = [], active = -1;
  const draw = () => {
    rows = search(input.value);
    list.hidden = !rows.length || document.activeElement !== input;
    list.replaceChildren(...rows.map((L, i) => h('button.combo-item' + (i === active ? '.is-active' : ''), {
      type: 'button', role: 'option', tabIndex: -1,
      onpointerdown: (e) => e.preventDefault(), // 不让输入框失去焦点
      onclick: () => pick(i),
    }, h('span.combo-logo', logoUrl(L) ? h('img', { src: logoUrl(L), alt: '' }) : h('span', (L.short || L.name).slice(0, 1))),
      h('span.combo-text', h('b', L.name), h('small', L.company)))));
  };
  const pick = (i) => { const L = rows[i]; if (!L) return; list.hidden = true; active = -1; if (L.id) onPick(L); else { input.value = L.name; input.dispatchEvent(new Event('input')); } };
  input.addEventListener('focus', () => { active = -1; draw(); });
  input.addEventListener('input', () => { active = -1; draw(); });
  input.addEventListener('blur', () => { list.hidden = true; });
  input.addEventListener('keydown', (e) => {
    if (list.hidden) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); active = (active + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length; draw(); list.children[active]?.scrollIntoView({ block: 'nearest' }); }
    else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); pick(active); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); list.hidden = true; }
  });
  return h('div.combo', input, list);
}

function editBook(id) {
  const book = state.books[id];
  return dialog('编辑信息', (close) => {
    const title = h('input.field', { type: 'text', value: book.title, maxLength: 200, required: true });
    const author = h('input.field', { type: 'text', value: book.author, maxLength: 200 });
    const illustrator = h('input.field', { type: 'text', value: book.illustrator || '', maxLength: 200 });
    const publisher = h('input.field', { type: 'text', value: book.publisher || '', maxLength: 200, placeholder: '输入文库或出版社检索，例如：电击、GAGAGA、MF', autocomplete: 'off', role: 'combobox', 'aria-autocomplete': 'list' });
    const published = h('input.field', { type: 'text', value: book.published || '', maxLength: 10, placeholder: '例如 2024-07-18 或 2024-07', inputMode: 'numeric', pattern: '\\d{4}(\\D\\d{1,2}(\\D\\d{1,2})?)?\\D?', title: '年-月-日，也可以只写年月或年份' });
    let imprint = book.imprint || '';
    const spineHost = h('div.spine-prev');
    const drawSpine = () => {
      const label = labelById(imprint) || matchLabel(publisher.value, book.format === 'cbz');
      drawMarks(label);
      const sp = buildSpine({
        title: series.value.trim() || title.value.trim(), volume: series.value.trim() ? volume.value : null, author: author.value.trim(),
        illustrator: illustrator.value.trim(), kind: book.format === 'cbz' ? 'manga' : 'novel', mark,
        label, publisher: publisher.value.trim(),
      });
      const color = prefs.get('spineColors2', {})[`${book.id}:${book.coverAt || 0}`];
      spineHost.style.setProperty('--sc', color || `hsl(${fallbackHue(book.series || book.title)} 34% 52%)`);
      spineHost.classList.toggle('is-light', !!color && theme.hexToOklch(color).L > 0.68);
      spineHost.replaceChildren(sp.el);
      requestAnimationFrame(() => fitSpine(sp.el));
      drawPubTag(label);
    };
    const pubTag = h('span.pub-tag');
    const drawPubTag = (label) => pubTag.replaceChildren(...(label ? [logoUrl(label, mark) ? h('img', { src: logoUrl(label, mark), alt: '' }) : '', h('span', `书脊会用「${label.name}」的样式`)] : [h('span', publisher.value.trim() ? '没有对应的文库样式，书脊上只印名字' : '')]));
    const combo = comboBox(publisher, (text) => searchLabels(text, [...new Set(Object.values(state.books).map((x) => x.publisher).filter(Boolean))], 8, book.format === 'cbz'), (label) => {
      publisher.value = label.short || label.name; imprint = label.id; mark = ''; drawSpine();
    });
    // 漫画品牌往往有好几个年代的书脊小标，让用户自己挑和手上那本一样的
    let mark = book.imprintMark || '';
    const markRow = h('div.mark-pick', { hidden: true, role: 'group', 'aria-label': '书脊小标的版本' });
    let marksFor = null;
    function drawMarks(label) {
      const list = label?.manga ? label.marks : [];
      markRow.hidden = list.length < 2;
      if (marksFor === label && markRow.childElementCount) { for (const b of markRow.querySelectorAll('button')) b.classList.toggle('is-on', b.dataset.mark === (mark || list[0])); return; }
      marksFor = label;
      markRow.replaceChildren(h('span.field-hint', '小标版本'), ...list.map((m) => h('button' + ((mark || list[0]) === m ? '.is-on' : ''), {
        type: 'button', 'data-mark': m, title: label.wide[m] ? '官方品牌图' : '旧版书脊小标（低清）',
        onclick: () => { mark = m; drawSpine(); },
      }, h('img', { src: logoUrl(label, m), alt: '' }))));
    }
    publisher.addEventListener('input', () => { imprint = ''; drawSpine(); });
    const description = h('textarea.field.is-area', { value: book.description || '', maxLength: 8000, rows: 5, placeholder: '这本书讲了什么？' });
    const descStatus = h('p.field-hint', { role: 'status' });
    const review = h('textarea.field.is-area', { value: book.review || '', maxLength: 5000, rows: 4, placeholder: '读完有什么想说的？' });
    let rating = book.rating || 0;
    const stars = h('div.stars', { role: 'group', 'aria-label': '评分' });
    const drawStars = () => stars.replaceChildren(...[1, 2, 3, 4, 5].map((n) => h('button' + (n <= rating ? '.is-on' : ''), {
      type: 'button', 'aria-label': `${n} 星`, 'aria-pressed': String(n <= rating), onclick: () => { rating = rating === n ? 0 : n; drawStars(); },
    }, icon(n <= rating ? 'starOn' : 'star', 26))));
    drawStars();
    let status = book.status || '';
    const statusSeg = h('div.segmented', { role: 'group', 'aria-label': '阅读状态' });
    const drawStatus = () => statusSeg.replaceChildren(...STATUSES.map(([value, label]) => h('button' + (status === value ? '.is-on' : ''), {
      type: 'button', onclick: () => { status = value; drawStatus(); },
    }, label)));
    drawStatus();
    const series = h('input.field', { type: 'text', value: book.series || '', maxLength: 200, placeholder: '填了就按系列显示，只有一本也可以', list: 'series-names' });
    const volume = h('input.field', { type: 'number', value: book.volume ?? '', min: 0, step: 'any', placeholder: '例如 3', inputMode: 'decimal' });
    const names = [...new Set(Object.values(state.books).map((b) => b.series).filter(Boolean))];
    for (const f of [title, author, illustrator, series, volume]) f.addEventListener('input', drawSpine);
    queueMicrotask(drawSpine);
    const tagBox = tagEditor(book.tags || []);
    let extra = {}; // 查资料带来的、表单上没有输入框的字段（原名、Bangumi 编号）
    // 自动查资料：确认后把选中的字段填进表单，还没保存
    const fillFrom = (c, use) => {
      const put = (input, v) => { if (v) { input.value = v; input.dispatchEvent(new Event('input')); } };
      if (use.title) { if (series.value.trim() || book.series) put(series, c.titleCn || c.title); else put(title, c.titleCn || c.title); }
      if (use.author) put(author, c.author);
      if (use.illustrator) put(illustrator, c.illustrator);
      if (use.publisher && c.publisher) { publisher.value = c.label || c.publisher; imprint = ''; drawSpine(); }
      if (use.date && c.date && !book.series) put(published, c.date);
      if (use.summary) put(description, c.summary);
      if (use.tags && c.tags.length) tagBox.set([...tagBox.get(), ...c.tags]);
      extra = { originalTitle: c.title || '', bangumiId: c.source === 'bangumi' ? c.id : (book.bangumiId ?? null) };
      toast('已填入，检查一下再保存');
    };
    const lookupBtn = h('button.link-btn', { type: 'button', onclick: () => lookupMeta({
      query: series.value.trim() || title.value.trim(), kind: book.format === 'cbz' ? 'manga' : 'novel', author: author.value.trim(), volumeBook: !!series.value.trim(),
    }).then((r) => r && fillFrom(r.candidate, r.use)) }, icon('search2', 16), '自动查资料');
    return h('form.dialog-body', {
      onsubmit: async (e) => {
        e.preventDefault();
        const patch = {
          title: title.value, author: author.value, illustrator: illustrator.value.trim(), publisher: publisher.value.trim(), status,
          rating, review: review.value.trim(), description: description.value.trim(),
          series: series.value.trim(), volume: volume.value === '' ? null : Number(volume.value),
          imprint, published: normDate(published.value), imprintMark: mark, tags: tagBox.get(), ...extra,
        };
        if (await guard(() => store.updateBook(id, patch), '已保存')) { close(); exitSelect(false); renderAll(); }
      },
    },
    h('div.label-row', h('label.field-label', '书名'), lookupBtn), title,
    h('div.field-pair.is-even',
      h('div', h('label.field-label', book.format === 'cbz' ? '作者 / 原作' : '作者'), author),
      h('div', h('label.field-label', book.format === 'cbz' ? '作画' : '插画'), illustrator)),
    h('div.field-pair.is-date',
      h('div', h('label.field-label', book.format === 'cbz' ? '出版社 / 漫画品牌' : '出版社 / 文库'), combo),
      h('div', h('label.field-label', '出版时间'), published)),
    pubTag, markRow,
    h('div.label-row', h('label.field-label', '简介'),
      h('button.link-btn', { type: 'button', onclick: () => fillWithAi(description, descStatus, { kind: 'book', title: book.title, author: author.value, illustrator: illustrator.value, publisher: publisher.value, volume: book.volume, existing: book.description }) }, icon('sparkle', 16), '让助手写')),
    description, descStatus,
    h('label.field-label', '标签'), tagBox.el,
    h('label.field-label', '阅读状态'), statusSeg,
    h('div.field-pair',
      h('div', h('label.field-label', '系列'), series),
      h('div', h('label.field-label', '卷号'), volume)),
    h('datalist', { id: 'series-names' }, names.map((n) => h('option', { value: n }))),
    h('p.field-hint', '填了系列和卷号，书架上会显示成“系列名 + 卷号”，同系列的书会叠在一起并按卷号排序。'),
    h('label.field-label', '书脊'),
    h('div.spine-edit', spineHost,
      h('p.field-hint', book.format === 'cbz'
        ? '漫画书脊按“出版社 / 漫画品牌”自动选：顶上是品牌小标，中间是书名和卷号，原作和作画不是同一人时分两列写，最下面是出版社。品牌有好几个年代的小标时，可以在上面挑和手上那本一样的。只写 JC、KC 这类缩写不会自动套标志，因为好几个品牌都这么叫。'
        : '书脊样式按“出版社 / 文库”自动选：顶上是文库小标，中间是书名、卷号和作者，最下面是文库名。这是软件里的示意，不是真实书脊的复刻。')),
    h('label.field-label', '我的评分'), stars,
    h('label.field-label', '书评'), review,
    h('div.dialog-actions',
      h('button.btn', { type: 'button', onclick: () => close() }, '取消'),
      h('button.btn.is-primary', { type: 'submit' }, '保存')));
  });
}

// ---------- 合集 ----------
async function newCollection() {
  const name = await promptDialog('新建合集', { label: '合集名字', placeholder: '例如：正在追的轻小说', ok: '新建' });
  if (!name) return;
  let created;
  if (await guard(async () => { created = await store.createCollection(name); })) setFilter(created.id);
}
function manageCollection() {
  const col = state.collections[view.filter];
  return dialog(`合集「${col.name}」`, (close) => h('div.dialog-body',
    h('div.menu',
      h('button.menu-item', {
        type: 'button',
        onclick: async () => {
          close();
          const name = await promptDialog('重命名合集', { label: '合集名字', value: col.name });
          if (name) guard(() => store.renameCollection(col.id, name), '已重命名');
        },
      }, '重命名'),
      h('button.menu-item.is-danger', {
        type: 'button',
        onclick: async () => {
          close();
          if (await confirmDialog('删除合集', `只删除合集「${col.name}」，里面的书会留在书架上。`, { ok: '删除合集', danger: true })) {
            if (await guard(() => store.deleteCollection(col.id), '合集已删除')) setFilter('all');
          }
        },
      }, '删除合集（保留里面的书）'))));
}

// ---------- 摘录与批注 ----------
export const HL_COLORS = { blue: '#7FB3E6', pink: '#F49AB5', yellow: '#F2CF5B', green: '#8FD19E' };
const MARK_LABEL = { highlight: '划线', note: '笔记', bookmark: '书签' };
function renderExcerpts() {
  els.body.className = 'body excerpts';
  const types = [['all', '全部'], ['highlight', '划线'], ['annotated', '有批注'], ['note', '笔记'], ['bookmark', '书签']];
  const match = (m) => view.excerptType === 'all' || (view.excerptType === 'annotated' ? m.type === 'highlight' && m.text : m.type === view.excerptType);
  const q = view.query;
  const groups = Object.entries(state.marks)
    .filter(([id]) => state.books[id] && (!view.excerptBook || view.excerptBook === id))
    .map(([id, list]) => [state.books[id], Object.values(list).filter(match)
      .filter((m) => !q || `${m.excerpt} ${m.text} ${m.chapter}`.toLowerCase().includes(q))
      .sort((a, b) => a.percent - b.percent || a.createdAt - b.createdAt)])
    .filter(([, list]) => list.length)
    .sort((a, b) => Math.max(...b[1].map((m) => m.updatedAt || m.createdAt)) - Math.max(...a[1].map((m) => m.updatedAt || m.createdAt)));
  const total = groups.reduce((n, [, l]) => n + l.length, 0);
  const search = h('input.field.is-pill', { type: 'search', value: view.query, placeholder: '搜索摘录和批注', 'aria-label': '搜索摘录和批注',
    oninput: (e) => { view.query = e.target.value.trim().toLowerCase(); clearTimeout(search.t); search.t = setTimeout(renderBody, 200); } });
  const head = h('div.ex-head',
    h('div.segmented', { role: 'group', 'aria-label': '筛选' }, types.map(([v, t]) => h('button' + (view.excerptType === v ? '.is-on' : ''), {
      type: 'button', onclick: () => { view.excerptType = v; renderBody(); },
    }, t))),
    search,
    view.excerptBook && h('button.chip-tag.is-on', { type: 'button', onclick: () => { view.excerptBook = null; renderBody(); } }, `只看《${bookLabel(state.books[view.excerptBook])}》`, icon('close', 14)),
    h('span.ex-count', `${total} 条记录 · ${groups.length} 本书`));
  if (!groups.length) {
    els.body.replaceChildren(head, h('div.empty', h('h2', '还没有摘录'), h('p', '阅读时长按文字可以划线、写批注；点顶部的书签按钮可以记下这一页。它们都会收在这里。')));
    return;
  }
  const card = (book, m) => h('article.ex-card', { style: `--hl:${HL_COLORS[m.color] || HL_COLORS.blue}` },
    h('div.ex-card-top', h('span.ex-label', m.type === 'highlight' ? '原文摘录' : m.type === 'note' ? '这一页的笔记' : '书签'),
      h('span.ex-type.is-' + m.type, m.type === 'highlight' && m.text ? '批注' : MARK_LABEL[m.type])),
    m.type === 'highlight' ? h('blockquote.ex-quote', m.excerpt) : m.excerpt && h('p.ex-excerpt', m.excerpt + '…'),
    m.text && h('div.ex-note', h('span.ex-label', m.type === 'highlight' ? '个人批注' : '笔记'), h('p', m.text)),
    h('div.ex-foot',
      h('span.ex-where', `${m.chapter || ''}${m.chapter ? ' · ' : ''}${fmtPercent(Math.max(m.percent, 0.01))} · ${new Date(m.createdAt).toLocaleDateString()}`),
      h('div.ex-actions',
        h('button.btn.is-soft-sm', { type: 'button', onclick: () => openBook(book.id, m.id) }, '回到原文'),
        (m.excerpt || m.text) && h('button.icon-btn', { type: 'button', 'aria-label': '复制', title: '复制', onclick: () => copyText(`${m.excerpt || ''}${m.text ? `\n—— ${m.text}` : ''}\n《${book.title}》${m.chapter ? ' ' + m.chapter : ''}`) }, icon('copy', 18)),
        m.type !== 'bookmark' && h('button.icon-btn', { type: 'button', 'aria-label': '编辑批注', title: '编辑批注', onclick: () => editAnnotation(book.id, m) }, icon('pen', 18)),
        h('button.icon-btn', { type: 'button', 'aria-label': '删除', title: '删除', onclick: async () => {
          if (await confirmDialog('删除这条记录', m.type === 'highlight' ? '划线和它的批注都会删除。' : '删除后无法恢复。', { ok: '删除', danger: true })) store.removeMark(book.id, m.id);
        } }, icon('trash', 18)))));
  els.body.replaceChildren(head, ...groups.map(([book, list]) => h('section.ex-group',
    h('header.ex-book', h('span.ex-cover', coverOf(book)),
      h('div', h('h2', bookLabel(book)), h('p', `${list.length} 条书签与标记`)),
      h('button.icon-btn', { type: 'button', 'aria-label': '图书详情', onclick: () => showDetail(book.id) }, icon('info'))),
    h('div.ex-list', list.map((m) => card(book, m))))));
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('已复制'); } catch { toast('复制失败，请手动选择文字', { error: true }); }
}
export function editAnnotation(bookId, mark) {
  return dialog(mark.type === 'highlight' ? '批注' : '笔记', (close) => {
    const area = h('textarea.field.is-area', { value: mark.text || '', rows: 5, maxLength: 5000, placeholder: '写下你的想法…' });
    setTimeout(() => area.focus(), 40);
    return h('form.dialog-body', { onsubmit: (e) => { e.preventDefault(); store.saveMark(bookId, { ...mark, text: area.value.trim() }); close(); toast('已保存'); } },
      mark.excerpt && h('blockquote.note-quote', mark.excerpt),
      area,
      h('div.dialog-actions',
        h('button.btn', { type: 'button', onclick: () => close() }, '取消'),
        h('button.btn.is-primary', { type: 'submit' }, '保存')));
  });
}

// ---------- 阅读统计 ----------
// 悬停提示：图表上的柱子、格子都带 data-tip，鼠标或手指放上去显示具体数值
let tipEl = null;
function chartTips(root) {
  const show = (e) => {
    const t = e.target.closest?.('[data-tip]');
    if (!t) { tipEl?.remove(); tipEl = null; return; }
    tipEl ??= document.body.appendChild(h('div.chart-tip', { role: 'tooltip' }));
    tipEl.textContent = t.dataset.tip;
    const r = t.getBoundingClientRect();
    const w = tipEl.offsetWidth;
    tipEl.style.left = `${Math.min(innerWidth - w - 8, Math.max(8, r.left + r.width / 2 - w / 2))}px`;
    tipEl.style.top = `${Math.max(8, r.top - tipEl.offsetHeight - 8)}px`;
  };
  root.addEventListener('pointerover', show);
  root.addEventListener('pointerleave', () => { tipEl?.remove(); tipEl = null; });
  return root;
}
const dur = (sec) => fmtDuration(sec);
function dayList(n, end = new Date()) {
  const today = new Date(end); today.setHours(0, 0, 0, 0);
  return Array.from({ length: n }, (_, i) => { const d = new Date(today); d.setDate(d.getDate() - (n - 1 - i)); return d; });
}
const daySum = (key) => Object.values(state.stats[key] || {}).reduce((a, b) => a + b, 0);
function streaks() { // 当前连续天数（今天还没读就从昨天算起）和历史最长
  const days = new Set(Object.keys(state.stats).filter((k) => daySum(k) > 0));
  let longest = 0;
  for (const k of days) {
    const d = new Date(k + 'T00:00:00'); d.setDate(d.getDate() - 1);
    if (days.has(store.dayKey(d))) continue; // 只从每段连续的第一天往后数
    let n = 0; const c = new Date(k + 'T00:00:00');
    while (days.has(store.dayKey(c))) { n++; c.setDate(c.getDate() + 1); }
    longest = Math.max(longest, n);
  }
  const c = new Date(); c.setHours(0, 0, 0, 0);
  if (!days.has(store.dayKey(c))) c.setDate(c.getDate() - 1);
  let current = 0;
  while (days.has(store.dayKey(c))) { current++; c.setDate(c.getDate() - 1); }
  return { current, longest };
}

function renderStats() {
  const range = view.statRange || 30;
  const days = dayList(range);
  const keys = days.map((d) => store.dayKey(d));
  const perDay = keys.map(daySum);
  const total = perDay.reduce((a, b) => a + b, 0);
  const prevTotal = dayList(range, new Date(days[0].getTime() - 86400000)).reduce((n, d) => n + daySum(store.dayKey(d)), 0);
  const active = perDay.filter(Boolean).length;
  const best = perDay.reduce((m, v, i) => (v > m.v ? { v, i } : m), { v: 0, i: -1 });
  const perBook = new Map();
  for (const k of keys) for (const [id, sec] of Object.entries(state.stats[k] || {})) perBook.set(id, (perBook.get(id) || 0) + sec);
  const ranked = [...perBook].filter(([id]) => state.books[id]).sort((a, b) => b[1] - a[1]);
  const since = days[0].getTime();
  const finished = Object.values(state.books).filter((b) => store.statusOf(b) === 'finished' && (state.progress[b.id]?.updatedAt || 0) >= since).length;
  const allMarks = Object.entries(state.marks).flatMap(([id, l]) => Object.values(l).map((m) => ({ ...m, bookId: id })));
  const marksIn = allMarks.filter((m) => m.createdAt >= since);
  const st = streaks();

  // —— 总时长 + 和上一段比较
  const H = Math.floor(total / 3600), M = Math.round((total % 3600) / 60);
  const delta = total - prevTotal;
  const deltaText = !prevTotal && !total ? '这段时间还没有阅读记录' : !prevTotal ? `上一个 ${range} 天没有记录` :
    `比上一个 ${range} 天${delta >= 0 ? '多' : '少'} ${dur(Math.abs(delta))}（${delta >= 0 ? '+' : '−'}${Math.round(Math.abs(delta) / prevTotal * 100)}%）`;
  const seg = h('div.segmented', { role: 'group', 'aria-label': '统计范围' }, [7, 30, 90, 365].map((n) => h('button' + (n === range ? '.is-on' : ''), {
    type: 'button', onclick: () => { view.statRange = n; renderBody(); },
  }, `${n} 天`)));
  const tile = (value, unit, label, sub) => h('div.fact', h('div.fact-value', String(value), h('small', unit)), h('div.fact-label', label), sub && h('div.fact-sub', sub));

  // —— 每天 / 每周 / 每月的柱状图，带平均线
  let buckets;
  if (range <= 30) buckets = days.map((d, i) => ({ tip: `${d.getMonth() + 1} 月 ${d.getDate()} 日：${dur(perDay[i])}`, label: range === 7 ? '日一二三四五六'[d.getDay()] : (i % 5 === 0 || i === range - 1 ? `${d.getMonth() + 1}/${d.getDate()}` : ''), sec: perDay[i] }));
  else if (range === 90) {
    buckets = [];
    for (let i = 0; i < days.length; i += 7) { const d = days[i]; buckets.push({ tip: `${d.getMonth() + 1}/${d.getDate()} 起一周：${dur(perDay.slice(i, i + 7).reduce((a, b) => a + b, 0))}`, label: buckets.length % 3 ? '' : `${d.getMonth() + 1}/${d.getDate()}`, sec: perDay.slice(i, i + 7).reduce((a, b) => a + b, 0) }); }
  } else {
    const by = new Map();
    days.forEach((d, i) => { const k = `${d.getFullYear()}-${d.getMonth()}`; const b = by.get(k) || { tip: '', name: `${d.getFullYear()} 年 ${d.getMonth() + 1} 月`, label: `${d.getMonth() + 1}月`, sec: 0 }; b.sec += perDay[i]; by.set(k, b); });
    buckets = [...by.values()].map((b) => ({ ...b, tip: `${b.name}：${dur(b.sec)}` }));
  }
  const peak = Math.max(1, ...buckets.map((b) => b.sec));
  const avg = buckets.length ? buckets.reduce((n, b) => n + b.sec, 0) / buckets.length : 0;
  const barChart = h('div.bars-wrap',
    h('div.bars' + (buckets.length > 14 ? '.is-dense' : ''), buckets.map((b) => h('div.bar-col', { 'data-tip': b.tip },
      h('div.bar-track', h('div.bar' + (b.sec === peak && b.sec > 0 ? '.is-peak' : ''), { style: `height:${b.sec ? Math.max(2, (b.sec / peak) * 100) : 0}%` })),
      h('span.bar-label', b.label)))),
    avg > 0 && h('div.avg-line', { style: `bottom:calc(22px + (100% - 22px) * ${avg / peak})`, 'data-tip': `平均每${range <= 30 ? '天' : range === 90 ? '周' : '月'} ${dur(avg)}` }, h('span', `平均 ${dur(avg)}`)));

  // —— 日历热力图：一格一天，颜色越深读得越久
  const weeks = range <= 30 ? 6 : range === 90 ? 13 : 53;
  const calDays = dayList(weeks * 7 - (6 - ((new Date().getDay() + 6) % 7)));
  const calMax = Math.max(1, ...calDays.map((d) => daySum(store.dayKey(d))));
  const level = (sec) => (!sec ? 0 : sec < calMax * 0.25 ? 1 : sec < calMax * 0.5 ? 2 : sec < calMax * 0.8 ? 3 : 4);
  const cells = [];
  const firstCol = (calDays[0].getDay() + 6) % 7; // 周一在第一行
  for (let i = 0; i < firstCol; i++) cells.push(h('span.cal-cell.is-pad'));
  const monthMarks = [];
  calDays.forEach((d, i) => {
    const sec = daySum(store.dayKey(d));
    if (d.getDate() === 1 || i === 0) monthMarks.push([Math.floor((i + firstCol) / 7), `${d.getMonth() + 1}月`]);
    cells.push(h('span.cal-cell.is-l' + level(sec), { 'data-tip': `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}：${sec ? dur(sec) : '没有阅读'}` }));
  });
  const cols = Math.ceil(cells.length / 7);
  const cell = cols <= 8 ? 30 : cols <= 14 ? 24 : 14; // 格子少就画大一点
  const calendar = h('div.cal', { style: `--cols:${cols};--cell:${cell}px;--gap:${cell > 20 ? 6 : 4}px` },
    h('div.cal-months', monthMarks.map(([c, t]) => h('span', { style: `grid-column:${c + 1}` }, t))),
    h('div.cal-days', ['一', '', '三', '', '五', '', '日'].map((t) => h('span', t))),
    h('div.cal-grid', cells),
    h('div.cal-legend', h('span', '少'), [0, 1, 2, 3, 4].map((l) => h('span.cal-cell.is-l' + l)), h('span', '多')));

  // —— 一天里的节律：24 根放射状的柱子
  const hours = Array(24).fill(0);
  for (const k of keys) for (const [hr, sec] of Object.entries(state.hours[k] || {})) hours[hr] += sec;
  const hourTotal = hours.reduce((a, b) => a + b, 0);
  const topHour = hours.indexOf(Math.max(...hours));
  const night = [22, 23, 0, 1, 2, 3, 4, 5].reduce((n, hr) => n + hours[hr], 0);
  const hMax = Math.max(1, ...hours);
  const R0 = 58, R1 = 112;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '-130 -130 260 260'); svg.setAttribute('class', 'clock');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', hourTotal ? `最常在 ${topHour} 点读书` : '还没有分时段的记录');
  const add = (tag, attrs, text) => { const el = document.createElementNS(ns, tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); if (text) el.textContent = text; svg.append(el); return el; };
  add('circle', { r: R0 - 6, class: 'clock-face' });
  for (let hr = 0; hr < 24; hr++) {
    const ang = (hr / 24) * Math.PI * 2 - Math.PI / 2;
    const len = hours[hr] ? Math.max(4, (hours[hr] / hMax) * (R1 - R0)) : 2;
    const [c, s2] = [Math.cos(ang), Math.sin(ang)];
    const ln = add('line', { x1: c * R0, y1: s2 * R0, x2: c * (R0 + len), y2: s2 * (R0 + len), class: 'clock-bar' + (hr === topHour && hours[hr] ? ' is-top' : '') + (hr >= 22 || hr < 6 ? ' is-night' : '') });
    ln.dataset.tip = `${hr}:00–${hr + 1}:00：${hours[hr] ? dur(hours[hr]) : '没有阅读'}`;
    if (hr % 6 === 0) add('text', { x: c * (R1 + 12), y: s2 * (R1 + 12) + 4, class: 'clock-num' }, String(hr));
  }
  add('text', { x: 0, y: -4, class: 'clock-big' }, hourTotal ? `${topHour}:00` : '—');
  add('text', { x: 0, y: 16, class: 'clock-small' }, hourTotal ? '最常读书的时段' : '暂无记录');
  const week = [1, 2, 3, 4, 5, 6, 0].map((w) => ({ w, sec: days.reduce((n, d, i) => n + (d.getDay() === w ? perDay[i] : 0), 0) }));
  const wMax = Math.max(1, ...week.map((x) => x.sec));

  // —— 每本书
  const bookRows = ranked.slice(0, 20).map(([id, sec]) => {
    const b = state.books[id], p = state.progress[id]?.percent || 0;
    return h('button.stat-book', { type: 'button', onclick: () => openBook(id), 'data-tip': `${store.seriesLabel(b)}：${dur(sec)}` },
      h('span.sb-cover', coverOf(b)),
      h('span.sb-main', h('span.stat-book-title', store.seriesLabel(b)),
        h('span.stat-book-bar', h('span', { style: `width:${Math.max(2, (sec / ranked[0][1]) * 100)}%` }))),
      h('span.sb-end', h('b', dur(sec)), h('small', store.statusOf(b) === 'finished' ? '已读完' : `读到 ${fmtPercent(Math.min(p, 0.99))}`)));
  });
  const recent = marksIn.filter((m) => m.type === 'highlight').sort((a, b) => b.createdAt - a.createdAt).slice(0, 3);

  els.body.className = 'body stats';
  els.body.replaceChildren(chartTips(h('div.stats-inner',
    h('section.stat-hero',
      h('div',
        h('div.stat-caption', `近 ${range} 天的阅读时长`),
        h('div.stat-big', H > 0 && [String(H), h('small', '小时')], String(M), h('small', '分')),
        h('div.stat-delta' + (delta > 0 ? '.is-up' : delta < 0 ? '.is-down' : ''), deltaText)),
      seg),
    h('section.stat-facts',
      tile(active, `/ ${range} 天`, '有阅读的天数'),
      tile(st.current, '天', '当前连续阅读', `最长连续 ${st.longest} 天`),
      tile(active ? Math.round(total / active / 60) : 0, '分钟', '读书那天平均读', best.v ? `最多的一天 ${days[best.i].getMonth() + 1}/${days[best.i].getDate()} 读了 ${dur(best.v)}` : ''),
      tile(ranked.length, '本', '读过的书', finished ? `其中读完 ${finished} 本` : ''),
      tile(marksIn.filter((m) => m.type === 'highlight').length, '条', '划线', `批注 ${marksIn.filter((m) => m.text).length} 条 · 书签 ${marksIn.filter((m) => m.type === 'bookmark').length} 个`)),
    h('section.stat-card.is-wide', h('h2', range <= 30 ? '每天读了多久' : range === 90 ? '每周读了多久' : '每月读了多久'), barChart),
    h('section.stat-card' + (cols > 14 ? '.is-wide' : '.is-cal'), h('h2', '阅读日历'), calendar),
    h('section.stat-card', h('h2', '一天里的阅读节律'),
      h('div.clock-wrap', svg),
      h('p.stat-note', hourTotal ? `夜里 22 点到早上 6 点读的占 ${Math.round((night / hourTotal) * 100)}%` : '从这个版本开始记录分时段的数据，读一会儿就会出现。')),
    h('section.stat-card' + (cols > 14 ? '' : '.is-wide'), h('h2', '一周里哪天读得多'),
      h('div.week-rows', week.map(({ w, sec }) => h('div.week-row', { 'data-tip': `周${'日一二三四五六'[w]}：${dur(sec)}` },
        h('span', '周' + '日一二三四五六'[w]), h('span.week-track', h('span', { style: `width:${(sec / wMax) * 100}%` })), h('small', sec ? dur(sec) : '—'))))),
    h('section.stat-card.is-wide', h('h2', '每本书读了多久'),
      bookRows.length ? h('div.stat-books', bookRows) : h('p.stat-empty', '这段时间还没有阅读记录。打开一本书读一会儿，这里就会有数据。')),
    recent.length > 0 && h('section.stat-card.is-wide', h('h2', '这段时间划下的句子'),
      h('div.stat-quotes', recent.map((m) => h('button.stat-quote', { type: 'button', style: `--hl:${HL_COLORS[m.color] || HL_COLORS.blue}`, onclick: () => openBook(m.bookId, m.id) },
        h('q', m.excerpt), h('small', `《${store.seriesLabel(state.books[m.bookId] || { title: '' })}》${m.chapter ? ' · ' + m.chapter : ''}`))))),
  )));
}

// ---------- 设置 ----------
function segOf(label, options, current, onPick) {
  return h('div.segmented', { role: 'group', 'aria-label': label }, options.map(([v, t]) => h('button' + (current === v ? '.is-on' : ''), {
    type: 'button', onclick: () => onPick(v),
  }, t)));
}
const row = (label, control, hint) => h('div.set-row', h('div.set-label', h('span', label), hint && h('small', hint)), h('div.set-control', control));

function renderSettings() {
  els.body.className = 'body settings';
  const tabs = [['account', 'user', '账号'], ['look', 'palette', '外观'], ['ai', 'sparkle', '阅读助手'], ['tts', 'headphones', '听书'], ['cloud', 'cloud', '网盘与挂载'], ['data', 'database', '存储与同步']];
  const content = { account: settingsAccount, look: settingsLook, ai: settingsAi, tts: settingsTts, cloud: () => [settingsCloud(), mountsCard({ importFiles, rerender: () => renderBody() })], data: settingsData }[view.settingsTab]();
  els.body.replaceChildren(
    h('nav.set-tabs', { role: 'tablist' }, tabs.map(([k, ic, t]) => h('button' + (view.settingsTab === k ? '.is-on' : ''), {
      type: 'button', role: 'tab', 'aria-selected': String(view.settingsTab === k), onclick: () => { view.settingsTab = k; renderBody(); },
    }, icon(ic, 18), t))),
    h('div.set-panel', content));
}

function settingsAccount() {
  const p = store.profile();
  const acct = store.account();
  const nickname = h('input.field', { type: 'text', value: p.nickname, maxLength: 40, 'aria-label': '昵称' });
  const hero = h('section.set-card.account-hero',
    h('button.avatar-edit', { type: 'button', 'aria-label': '更换头像', title: '更换头像', onclick: pickAvatar }, avatarEl(84), h('span.avatar-cam', icon('camera', 16))),
    h('div.account-id',
      h('form.inline-form', { onsubmit: (e) => { e.preventDefault(); guard(() => store.setNickname(nickname.value), '昵称已保存').then(renderAll); } },
        nickname, h('button.btn', { type: 'submit' }, '保存')),
      h('p.field-hint', acct ? `账号 ${p.username} · ${p.server}` : '现在是本机书库：书和记录只存在这台设备上。')));
  if (!acct) {
    return [hero, h('section.set-card',
      h('h2', '登录服务器'),
      h('p.field-hint', '登录后书、进度、划线批注和阅读时长会在每台设备之间同步。登录后可以把本机书库一起上传。'),
      loginForm({ onDone: afterSignIn }))];
  }
  return [hero,
    state.authLost && h('section.set-card.is-warn', h('h2', '登录已失效'), h('p.field-hint', '可能是在别处修改了密码。请重新登录。'), loginForm({ onDone: afterSignIn })),
    h('section.set-card',
      h('h2', '同步'),
      row('状态', h('span', state.online ? `已同步 · ${new Date(state.lastSync || Date.now()).toLocaleTimeString()}` : '离线')),
      row('立即同步', h('button.btn', { type: 'button', onclick: manualSync }, icon('sync', 18), '同步')),
      row('上传本机书库', h('button.btn', { type: 'button', onclick: async () => {
        const n = await store.localLibrarySize();
        if (!n) { toast('本机书库里没有书'); return; }
        afterSignIn();
      } }, icon('upload', 18), '上传'), '把登录前在这台设备上导入的书搬到账号里')),
    h('section.set-card',
      h('h2', '安全'),
      row('修改密码', h('button.btn', { type: 'button', onclick: changePasswordDialog }, icon('key', 18), '修改')),
      row('退出登录', h('button.btn.is-danger', { type: 'button', onclick: async () => {
        if (!await confirmDialog('退出登录', '这台设备会回到本机书库。账号里的书和记录都还在服务器上，下次登录就能看到。', { ok: '退出登录', danger: true })) return;
        await store.signOut(); coverCache.clear(); view.filter = 'all'; startShelf();
      } }, icon('logout', 18), '退出'), '回到本机书库'))];
}
function changePasswordDialog() {
  return dialog('修改密码', (close) => {
    const oldP = h('input.field', { type: 'password', autocomplete: 'current-password', required: true });
    const newP = h('input.field', { type: 'password', autocomplete: 'new-password', required: true, minLength: 6 });
    return h('form.dialog-body', { onsubmit: async (e) => { e.preventDefault(); if (await guard(() => store.changePassword(oldP.value, newP.value), '密码已修改')) close(); } },
      h('label.field-label', '原密码'), oldP, h('label.field-label', '新密码（至少 6 位）'), newP,
      h('div.dialog-actions', h('button.btn', { type: 'button', onclick: () => close() }, '取消'), h('button.btn.is-primary', { type: 'submit' }, '保存')));
  });
}

function settingsLook() {
  const redraw = () => renderBody();
  const appleSize = window.__susukoApplePlatform && h('select.field', {
    'aria-label': '界面大小',
    onchange: (e) => {
      const value = e.target.value;
      prefs.set('appleInterfaceSize', value);
      document.documentElement.dataset.appleSize = value;
    },
  }, ...[['compact', '标准'], ['comfortable', '较大'], ['large', '最大']].map(([value, label]) =>
    h('option', { value, selected: document.documentElement.dataset.appleSize === value }, label)));
  return [themeCard(), h('section.set-card',
    h('h2', '外观'),
    appleSize ? row('界面大小', appleSize, '仅在这台设备上生效。正文字号可在阅读器内调整。') : null,
    row('界面主题', segOf('界面主题', [['auto', '跟随系统'], ['light', '浅色'], ['dark', '深色']], prefs.get('theme', 'auto'), (v) => { prefs.set('theme', v); applyTheme(); redraw(); })),
    row('书架的查看方式', segOf('查看方式', [['shelf', '立体书架'], ['grid', '封面'], ['list', '列表']], view.layout, (v) => { view.layout = v; prefs.set('layout', v); redraw(); })),
    row('同系列的书叠成一本', segOf('叠放', [[true, '开'], [false, '关']], prefs.get('stack', true), (v) => { prefs.set('stack', v); redraw(); })),
    row('继续阅读浮条', segOf('浮条', [[true, '显示'], [false, '隐藏']], prefs.get('pill', true), (v) => { prefs.set('pill', v); document.body.classList.toggle('no-pill', !v); redraw(); }), '书架底部显示上次读到的书'),
    (matchMedia('(max-width: 760px)').matches || /Android|iPhone/i.test(navigator.userAgent)) && prefs.get('pill', true)
      ? row('手机上的样子', segOf('手机上的样子', FAB_STYLES, prefs.get('fab', 'cover'), (v) => { prefs.set('fab', v); applyFabStyle(); redraw(); }), '封面圆钮：书的封面外面一圈是读到的进度；横条：和电脑上一样，带书名')
      : null)];
}

// 主题色：预设、自选、图片取色、跟随在读的书
function themeCard() {
  const a = theme.accentSettings();
  const current = a.mode === 'default' ? '' : a.color;
  const pick = (patch) => { theme.saveAccent(patch); renderBody(); };
  const drop = (id, name, color, on) => h('button.drop' + (on ? '.is-on' : ''), {
    type: 'button', 'aria-pressed': String(on), style: color ? `--d:${color}` : '', onclick: () => pick(id === 'default' ? { mode: 'default' } : { mode: 'preset', preset: id, color }),
  }, h('span.drop-dot' + (color ? '' : '.is-default')), h('span', name));
  const custom = h('input', { type: 'color', value: current || '#E46F93', 'aria-label': '自选颜色', onchange: (e) => pick({ mode: 'custom', color: e.target.value }) });
  const fromImage = h('input', { type: 'file', accept: 'image/*', hidden: true, onchange: async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try { pick({ mode: 'image', color: await theme.extractColor(f) }); toast('已从图片取色'); } catch { toast('这张图片读不出来', { error: true }); }
  } });
  const sample = lastRead() || Object.values(state.books)[0];
  return h('section.set-card.theme-card',
    h('h2', '主题色'),
    h('p.field-hint', '选一个主色，背景、玻璃、按钮和书架会一起换成和它协调的色调，深色模式下也有对应的一套。阅读页的纸张配色不受影响。'),
    h('div.theme-preview', { 'aria-hidden': 'true' },
      h('div.tp-side', h('span.tp-nav.is-on'), h('span.tp-nav'), h('span.tp-nav')),
      h('div.tp-main',
        h('div.tp-head', h('b', '全部'), h('span.tp-btn', '导入')),
        h('div.tp-shelf', [0, 1, 2, 3, 4].map((i) => h('span.tp-book' + (i === 2 ? '.is-center' : ''), { style: `--i:${i - 2}` }))),
        h('div.tp-pill', h('span.tp-cover'), h('span.tp-lines', h('i'), h('i')), h('span.tp-ring')))),
    h('div.drops',
      drop('default', 'スス子', null, a.mode === 'default'),
      ...theme.PRESETS.map((p) => drop(p.id, p.name, p.color, a.mode === 'preset' && a.preset === p.id))),
    h('div.theme-more',
      h('label.btn', icon('palette', 18), '自选颜色', custom),
      h('button.btn', { type: 'button', onclick: () => fromImage.click() }, icon('camera', 18), '从图片取色'), fromImage,
      h('button.btn' + (a.mode === 'cover' ? '.is-primary' : ''), {
        type: 'button', disabled: !sample?.hasCover, title: sample?.hasCover ? '' : '书架上还没有带封面的书',
        onclick: async () => { if (a.mode === 'cover') { pick({ mode: 'default' }); return; } coverAccentFor = null; await syncCoverAccent(true); renderBody(); },
      }, icon('dict', 18), a.mode === 'cover' ? '正在跟随在读的书' : '跟随在读的书')),
    h('p.field-hint', a.mode === 'default' ? '当前：スス子默认配色' : `当前主色 ${current.toUpperCase()}${a.mode === 'cover' ? '，换一本书读时会跟着变' : ''}`));
}
/** “跟随在读的书”：用最近在读那本的封面取色 */
let coverAccentFor = null;
async function syncCoverAccent(force = false) {
  if (!force && theme.accentSettings().mode !== 'cover') return;
  const b = lastRead() || Object.values(state.books).find((x) => x.hasCover);
  if (!b?.hasCover || coverAccentFor === b.id + ':' + b.coverAt) return;
  coverAccentFor = b.id + ':' + b.coverAt;
  try {
    const url = await store.coverUrl(b);
    const img = new Image();
    img.src = url;
    await img.decode();
    theme.saveAccent({ mode: 'cover', color: await theme.extractColor(img) });
  } catch { coverAccentFor = null; }
}

// ---------- 作品资料（自动查资料）的设置 ----------
const META_DEFAULT = { bangumiToken: '', dsKey: '', judge: 'assistant', base: '', key: '', model: '' };
const metaSettings = () => ({ ...META_DEFAULT, ...prefs.get('meta', {}) });
function metaSettingsCard() {
  const m = metaSettings();
  const field = (k, type, ph) => h('input.field', { type, value: m[k], placeholder: ph, autocomplete: 'off', spellcheck: false, onchange: (e) => prefs.set('meta', { ...metaSettings(), [k]: e.target.value.trim() }) });
  const custom = h('div.meta-custom', { hidden: m.judge !== 'custom' },
    h('label.field-label', '接口地址'), field('base', 'url', '例如 https://api.deepseek.com/v1，或 Liquid 的 OpenAI 兼容地址'),
    h('label.field-label', 'API Key'), field('key', 'password', 'sk-…'),
    h('label.field-label', '模型'), field('model', 'text', '例如 deepseek-chat、lfm-2.5-…'));
  const judgeSeg = h('div.segmented', { role: 'group', 'aria-label': '谁来挑选' }, [['assistant', '用阅读助手'], ['custom', '单独的模型'], ['off', '只按名字']].map(([v, t]) => h('button' + (m.judge === v ? '.is-on' : ''), {
    type: 'button', onclick: (e) => { prefs.set('meta', { ...metaSettings(), judge: v }); for (const b of e.currentTarget.parentElement.children) b.classList.toggle('is-on', b === e.currentTarget); custom.hidden = v !== 'custom'; },
  }, t)));
  return h('section.set-card',
    h('h2', '自动查资料'),
    h('p.field-hint', '编辑书籍信息时可以一键查：先在 Bangumi（中文资料、标签）和 AniList（英文名、罗马音）里找；名字不标准查不到时，再用 DeepSeek 网页搜索确认正式名字；最后由模型挑出最像的一条，你确认后才会填进去。Bangumi 和 AniList 查公开资料不需要申请应用。'),
    h('label.field-label', 'DeepSeek 搜索 Key（可选）'), field('dsKey', 'password', '和 DeepSeek 对话用的是同一种 Key'),
    h('p.field-hint', '每查一次最多调用 1 次搜索，名字本来就准的不会调用。DeepSeek 的搜索接口按成功次数计费。'),
    h('label.field-label', 'Bangumi Access Token（可选）'), field('bangumiToken', 'password', '不填也能查；填了可以查到需要登录才显示的条目'),
    row('谁来挑选', judgeSeg, '“只按名字”不调用模型，最省钱，但遇到同名作品可能挑错'),
    custom);
}

function settingsAi() {
  const s = ai.aiSettings();
  const base = h('input.field', { type: 'url', value: s.base, placeholder: 'https://api.openai.com/v1' });
  const key = h('input.field', { type: 'password', value: s.key, placeholder: 'sk-…', autocomplete: 'off' });
  const model = h('input.field', { type: 'text', value: s.model, placeholder: '例如 gpt-4o-mini、deepseek-chat、qwen-plus' });
  const prompt = h('textarea.field.is-area', { value: s.prompt, rows: 6 });
  const result = h('p.field-hint', { role: 'status' });
  let target = s.target, via = s.viaServer;
  const saveAll = () => ai.saveAiSettings({ base: base.value.trim(), key: key.value.trim(), model: model.value.trim(), prompt: prompt.value.trim() || ai.DEFAULT_PROMPT, target, viaServer: via });
  for (const el of [base, key, model, prompt]) el.addEventListener('change', saveAll);
  const targetSeg = h('div');
  const drawTarget = () => targetSeg.replaceChildren(segOf('翻译成', ai.LANGUAGES.map((l) => [l, l]), target, (v) => { target = v; saveAll(); drawTarget(); }));
  drawTarget();
  const viaSeg = h('div');
  const drawVia = () => viaSeg.replaceChildren(segOf('经服务器转发', [[true, '开'], [false, '关']], via, (v) => { via = v; saveAll(); drawVia(); }));
  drawVia();
  return [
    h('section.set-card',
      h('h2', '接口'),
      h('p.field-hint', '查词、翻译和提问都用这里的接口。支持 OpenAI 兼容格式：OpenAI、DeepSeek、通义千问、Kimi、智谱、硅基流动、本地 Ollama 等。填的是到 /v1 为止的地址。'),
      h('label.field-label', '接口地址'), base,
      h('label.field-label', 'API Key'), key,
      h('label.field-label', '模型'), model,
      store.isConfigured() && row('经服务器转发', viaSeg, '有些接口不允许浏览器直接访问，打开后请求会经过你的服务器'),
      h('div.set-actions',
        h('button.btn', { type: 'button', onclick: async () => {
          saveAll(); result.textContent = '正在测试…';
          try { const t = await ai.chat([{ role: 'user', content: '用一句话打个招呼。' }]); result.textContent = `连接成功：${t.slice(0, 60)}`; }
          catch (e) { result.textContent = `连接失败：${e.message}`; }
        } }, '测试连接')),
      result,
      h('p.field-hint', store.isConfigured() ? 'API Key 会随账号同步到你自己的服务器，换设备登录不用重填；不会发给其他任何地方。' : 'API Key 只保存在这台设备上。')),
    metaSettingsCard(),
    h('section.set-card',
      h('h2', '翻译'),
      row('默认翻译成', targetSeg, '查词的解释也用这种语言')),
    h('section.set-card',
      h('h2', '助手提示词'),
      h('p.field-hint', '每次查词、翻译、提问前都会先告诉模型这段话，可以按自己的喜好改。'),
      prompt,
      h('div.set-actions', h('button.btn.is-quiet', { type: 'button', onclick: () => { prompt.value = ai.DEFAULT_PROMPT; saveAll(); toast('已恢复默认提示词'); } }, '恢复默认'))),
  ];
}

function settingsTts() {
  const t = ai.ttsSettings();
  const voiceSel = h('select.field', { 'aria-label': '声音' }, h('option', { value: '' }, '自动（按书的语言挑选）'));
  ai.systemVoices().then((voices) => {
    for (const v of voices.filter((x) => /^(zh|ja|en)/i.test(x.lang))) voiceSel.append(h('option', { value: v.voiceURI, selected: v.voiceURI === t.voice }, `${v.name}（${v.lang}）`));
    if (!voices.length) voiceSel.append(h('option', { disabled: true }, store.isNativeShell ? '使用系统默认的语音引擎' : '这个浏览器没有可用的声音'));
  });
  voiceSel.addEventListener('change', () => ai.saveTtsSettings({ voice: voiceSel.value }));
  const rate = h('input.reader-slider.is-plain', { type: 'range', min: 0.5, max: 2.5, step: 0.1, value: t.rate, 'aria-label': '语速' });
  const rateVal = h('span.range-value', `${t.rate.toFixed(1)} 倍`);
  const fill = () => rate.style.setProperty('--v', `${((rate.value - 0.5) / 2) * 100}%`);
  fill();
  rate.addEventListener('input', () => { rateVal.textContent = `${Number(rate.value).toFixed(1)} 倍`; fill(); });
  rate.addEventListener('change', () => ai.saveTtsSettings({ rate: Number(rate.value) }));
  const apiModel = h('input.field', { type: 'text', value: t.apiModel, placeholder: 'tts-1' });
  const apiVoice = h('input.field', { type: 'text', value: t.apiVoice, placeholder: 'alloy' });
  for (const [el, k] of [[apiModel, 'apiModel'], [apiVoice, 'apiVoice']]) el.addEventListener('change', () => ai.saveTtsSettings({ [k]: el.value.trim() }));
  return [h('section.set-card',
    h('h2', '听书'),
    h('p.field-hint', '在阅读时点“听书”，会从当前页开始一句一句朗读，读到哪里就高亮哪里，自动翻页、自动进下一章。'),
    row('朗读引擎', segOf('朗读引擎', [['system', '系统语音'], ['api', '接口语音']], t.engine, (v) => { ai.saveTtsSettings({ engine: v }); renderBody(); }),
      t.engine === 'api' ? '使用“阅读助手”里的接口地址和 Key，调用 /audio/speech' : '免费，不需要联网；音色取决于系统'),
    t.engine === 'system' ? row('声音', voiceSel) : [row('语音模型', apiModel), row('音色', apiVoice)],
    row('语速', h('div.range-inline', rate, rateVal)),
    h('div.set-actions', h('button.btn', { type: 'button', onclick: async () => {
      ai.stopSpeaking();
      try { await ai.speak('放学后的教室里只剩下我一个人。夕阳从窗户斜斜地照进来。'); } catch (e) { toast(e.message, { error: true }); }
    } }, icon('headphones', 18), '试听')))];
}

function settingsData() {
  const device = h('input.field', { type: 'text', value: store.deviceName(), maxLength: 40, onchange: () => prefs.set('device', device.value.trim()) });
  const usage = h('span', '计算中…');
  store.localUsage().then((n) => { usage.textContent = `约 ${fmtSize(n)}`; });
  return [h('section.set-card',
    h('h2', '存储与同步'),
    store.isConfigured() && row('阅读时顺便把整本存到本机', segOf('缓存', [[true, '开'], [false, '关']], prefs.get('autoCache', true), (v) => { prefs.set('autoCache', v); renderBody(); }), '关掉更省流量，想离线看的书可以多选后“下载到本机”'),
    row('这台设备的名字', device, '在别的设备上继续阅读时，会显示进度来自哪台设备'),
    h('dl.facts',
      h('dt', '书库'), h('dd', store.isConfigured() ? `账号 ${store.profile().username}` : '本机书库'),
      h('dt', '书架'), h('dd', `${Object.keys(state.books).length} 本书，${Object.keys(state.collections).length} 个合集`),
      h('dt', '已存在本机'), h('dd', `${state.downloaded.size} 本`),
      h('dt', '占用空间'), h('dd', usage)))];
}

// ---------- 导入 ----------
// ---------- 导入菜单：本机文件 / 百度网盘 ----------
let closeApplePopMenu;
function popMenu(anchor, sections) {
  closeApplePopMenu?.();
  document.querySelector('.pop-menu')?.remove();
  const menu = h('div.pop-menu', { role: 'menu' }, sections.map((sec, i) => [
    i > 0 && h('hr.pop-sep'),
    sec.title && h('div.pop-title', sec.title),
    sec.items.map((it) => h('button.pop-item' + (it.on ? '.is-on' : ''), { type: 'button', role: it.on != null ? 'menuitemradio' : 'menuitem', 'aria-checked': it.on != null ? String(!!it.on) : null, onclick: () => { close(); it.onclick(); } },
      h('span.pop-icon', icon(it.icon, 20)), h('span.pop-text', h('b', it.label), it.sub && h('small', it.sub)))),
  ]));
  let stopPositioning;
  const close = () => {
    menu.remove();
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', esc, true);
    stopPositioning?.();
    if (closeApplePopMenu === close) closeApplePopMenu = undefined;
  };
  const outside = (e) => { if (!menu.contains(e.target) && !anchor.contains(e.target)) close(); };
  const esc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); anchor.focus(); } };
  document.body.append(menu);
  if (window.__susukoApplePlatform) {
    const viewport = window.visualViewport;
    const listeners = new AbortController();
    const options = { signal: listeners.signal, passive: true };
    const place = () => {
      if (!anchor.isConnected || !anchor.getClientRects().length) { close(); return; }
      const style = getComputedStyle(document.documentElement);
      const inset = (edge) => parseFloat(style.getPropertyValue('--safe-' + edge)) || 0;
      const left = Math.max(inset('l'), viewport?.offsetLeft ?? 0) + 8;
      const top = Math.max(inset('t'), viewport?.offsetTop ?? 0) + 8;
      const right = Math.min(innerWidth - inset('r'), (viewport?.offsetLeft ?? 0) + (viewport?.width ?? innerWidth)) - 8;
      const bottom = Math.min(innerHeight - inset('b'), (viewport?.offsetTop ?? 0) + (viewport?.height ?? innerHeight)) - 8;
      const r = anchor.getBoundingClientRect();
      menu.style.setProperty('--apple-menu-width', `${Math.max(0, right - left)}px`);
      const below = Math.max(0, bottom - r.bottom - 8);
      const above = Math.max(0, r.top - top - 8);
      const opensUp = menu.scrollHeight + 2 > below && above > below;
      menu.style.maxHeight = `${opensUp ? above : below}px`;
      menu.style.top = `${opensUp ? r.top - 8 - menu.offsetHeight : Math.max(top, r.bottom + 8)}px`;
      menu.style.left = `${Math.max(left, Math.min(right - menu.offsetWidth, r.right - menu.offsetWidth))}px`;
    };
    stopPositioning = () => listeners.abort();
    closeApplePopMenu = close;
    window.addEventListener('resize', place, options);
    window.addEventListener('scroll', (e) => { if (!menu.contains(e.target)) place(); }, { ...options, capture: true });
    viewport?.addEventListener('resize', place, options);
    viewport?.addEventListener('scroll', place, options);
    place();
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', esc, true);
    menu.querySelector('button')?.focus({ preventScroll: true });
    return;
  }
  const r = anchor.getBoundingClientRect();
  menu.style.top = `${r.bottom + 8}px`;
  menu.style.left = `${Math.max(8, Math.min(innerWidth - menu.offsetWidth - 8, r.right - menu.offsetWidth))}px`;
  setTimeout(() => { document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', esc, true); });
  menu.querySelector('button')?.focus();
}
async function importMenu(anchor) {
  await Promise.race([refreshMounts(), new Promise((r) => setTimeout(r, 400))]); // 列出已有的挂载；网络慢就先用上次的
  popMenu(anchor, [
    { items: [{ icon: 'upload', label: '从这台设备选文件', sub: 'EPUB、CBZ / ZIP', onclick: () => els.fileInput.click() }] },
    ...importMenuSections({ openBaidu: () => openBaiduBrowser(), onChanged: () => renderBody(), importFiles }),
  ]);
}

// ---------- 百度网盘 ----------
const https = (u) => String(u || '').replace(/^http:\/\//, 'https://');
let baiduPoll = null; // 正在等用户扫码授权
function stopBaiduPoll() { clearTimeout(baiduPoll); baiduPoll = null; }

function settingsCloud() {
  const card = h('section.set-card.cloud-card', h('div.cloud-head', h('span.cloud-logo', icon('cloud', 22)), h('div', h('h2', '百度网盘'), h('p.set-sub', '漫画放在网盘里，书架上只记位置；阅读时由你的服务器去网盘取正在看的那几页，不占服务器空间。'))));
  const body = h('div.cloud-body', h('p.muted', '正在读取网盘状态…'));
  card.append(body);
  if (!store.account()) {
    body.replaceChildren(h('p.muted', '网盘需要登录账号后使用：授权和下载都经过你自己的服务器转发。'));
    return card;
  }
  const draw = async () => {
    stopBaiduPoll();
    let st;
    try { st = await store.baidu.status(); } catch (e) { body.replaceChildren(h('p.form-error', e.message)); return; }
    if (!body.isConnected) return;
    if (st.connected) {
      const q = st.quota;
      body.replaceChildren(
        h('div.cloud-user',
          st.avatar ? h('img.cloud-avatar', { src: https(st.avatar), alt: '', referrerPolicy: 'no-referrer' }) : h('span.cloud-avatar', icon('user', 20)),
          h('div', h('b', st.name || '已连接'), q ? h('small', `已用 ${fmtSize(q.used)} / ${fmtSize(q.total)}`) : h('small', '已连接')),
          q && h('span.cloud-quota', h('span', { style: `width:${Math.min(100, (q.used / Math.max(1, q.total)) * 100)}%` }))),
        h('div.cloud-actions',
          h('button.btn.is-primary', { type: 'button', onclick: () => openBaiduBrowser() }, icon('folder', 18), '浏览网盘，添加漫画'),
          h('button.btn', { type: 'button', onclick: async () => { if (await confirmDialog('断开百度网盘', '断开后，书架上网盘里的书会暂时打不开，重新连接同一个账号就能恢复。', { ok: '断开', danger: true })) { await guard(() => store.baidu.disconnect(), '已断开'); draw(); } } }, '断开'),
          st.ownApp && h('button.btn.is-quiet', { type: 'button', onclick: () => drawApp(st) }, '更换应用')),
        directPanel());
      return;
    }
    if (!st.configured) return drawApp(st);
    body.replaceChildren(
      h('p', '还没有连接。点下面的按钮后，用百度网盘 App 扫码，或者在浏览器里登录百度账号同意授权。'),
      h('div.cloud-actions',
        h('button.btn.is-primary', { type: 'button', onclick: connect }, icon('cloud', 18), '连接百度网盘'),
        st.ownApp && h('button.btn.is-quiet', { type: 'button', onclick: () => drawApp(st) }, '更换应用')));
  };
  const drawApp = (st) => {
    const key = h('input.field', { type: 'text', value: st.appKey || '', placeholder: 'AppKey', autocomplete: 'off', spellcheck: false });
    const secret = h('input.field', { type: 'password', placeholder: st.ownApp ? '已保存，不改就留空…（重新填写才会更新）' : 'SecretKey', autocomplete: 'off' });
    const err = h('p.form-error', { hidden: true });
    body.replaceChildren(
      h('ol.cloud-steps',
        h('li', '用百度账号登录 ', h('a', { href: 'https://pan.baidu.com/union/console', target: '_blank', rel: 'noopener' }, '百度网盘开放平台'), '，按提示完成开发者认证（个人开发者就行）。'),
        h('li', '在控制台“创建应用”，类别选“软件”，名字随意。'),
        h('li', '打开应用详情，把 AppKey 和 SecretKey 复制到下面。SecretKey 只保存在你的服务器上。')),
      st.serverApp && h('p.field-hint', '你的服务器已经在环境变量里配置了应用，也可以不填，直接返回连接。'),
      h('form.cloud-form', {
        onsubmit: async (e) => {
          e.preventDefault();
          err.hidden = true;
          try { await store.baidu.setApp(key.value.trim(), secret.value.trim()); toast('应用信息已保存'); draw(); }
          catch (x) { err.textContent = x.message; err.hidden = false; }
        },
      },
      h('div.field-pair.is-even', h('div', h('label.field-label', 'AppKey'), key), h('div', h('label.field-label', 'SecretKey'), secret)),
      err,
      h('div.cloud-actions', h('button.btn.is-primary', { type: 'submit' }, '保存'), (st.configured) && h('button.btn', { type: 'button', onclick: draw }, '返回'))));
  };
  const connect = async () => {
    let d;
    try { d = await store.baidu.device(); } catch (e) { toast(e.message, { error: true }); return; }
    const status = h('p.cloud-wait', '等待授权…');
    body.replaceChildren(
      h('div.cloud-auth',
        h('img.cloud-qr', { src: https(d.qrcodeUrl), alt: '授权二维码', referrerPolicy: 'no-referrer' }),
        h('div',
          h('p', '用百度网盘 App 扫码，或者点下面的链接在浏览器里授权：'),
          h('p.cloud-code', h('small', '用户码'), h('b', d.userCode)),
          h('a.btn', { href: d.verificationUrl, target: '_blank', rel: 'noopener' }, '打开授权页'),
          status,
          h('button.btn.is-quiet', { type: 'button', onclick: draw }, '取消'))));
    const until = Date.now() + d.expiresIn * 1000;
    const tick = async () => {
      if (!body.isConnected) return stopBaiduPoll();
      if (Date.now() > until) { status.textContent = '二维码过期了，请重新连接。'; return; }
      try {
        const r = await store.baidu.poll();
        if (r.status === 'ok') { toast(`已连接百度网盘${r.name ? `：${r.name}` : ''}`); draw(); return; }
        if (r.status === 'expired') { status.textContent = '二维码过期了，请重新连接。'; return; }
        if (r.status === 'failed') { status.textContent = r.message; return; }
      } catch (e) { status.textContent = e.message; }
      baiduPoll = setTimeout(tick, Math.max(3, d.interval) * 1000);
    };
    baiduPoll = setTimeout(tick, Math.max(3, d.interval) * 1000);
  };
  draw();
  return card;
}

/** 设备直连：说明 + 用真实网盘文件做一次检查（随机跳到任意位置读，和服务器转发逐字节核对） */
function directPanel() {
  const native = store.direct.nativeAvailable();
  const books = Object.values(state.books).filter((b) => b.source?.type === 'baidu' || b.source?.type === 'baidu-dir');
  const box = h('div.direct-box',
    h('h3', '读取方式'),
    h('p.set-sub', native
      ? '这台设备上，网盘里的书优先由设备直接从百度下载（不经过你的服务器，也不占服务器流量）；直连不成功时会自动改走服务器转发。阅读时顶部会显示当前实际的读取方式。百度令牌只保存在服务器上，设备只拿到几分钟内有效的下载地址。'
      : '网页版不能直接向百度下载（浏览器不允许设置百度要求的请求头，也会被跨域限制挡住），所以始终经你的服务器转发。安卓和 Windows 客户端会优先直连。'));
  if (!native) return box;
  if (!books.length) { box.append(h('p.muted', '书架上还没有网盘里的书。添加一本以后，可以在这里检查直连是否可用。')); return box; }
  const pick = h('select.field', { 'aria-label': '用哪本书检查' }, books.map((b) => h('option', { value: b.id }, store.seriesLabel(b))));
  const result = h('div.direct-result', { role: 'status' });
  const run = h('button.btn', { type: 'button', onclick: async () => {
    const book = state.books[pick.value];
    run.disabled = true; result.replaceChildren(h('p.muted', '正在检查：直连随机读取 12 段，并经服务器读取同样的段落核对内容…'));
    try {
      const r = await store.diagnoseDirect(book, 12);
      const avg = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : 0);
      const reasons = Object.entries(r.errors).map(([k, n]) => `${directReason(k)} ×${n}`).join('；');
      result.replaceChildren(
        h('p', h('b', r.ok === 12 ? '直连可用' : r.ok > 0 ? '直连部分可用' : '直连不可用，会一直经服务器转发'),
          `：成功 ${r.ok} / 12，内容不一致 ${r.mismatch}，失败 ${r.fail}`),
        h('p.muted', `平均耗时：直连 ${avg(r.directMs)} ms，服务器转发 ${avg(r.proxyMs)} ms（每段 256 KB）`),
        reasons && h('p.muted', `失败原因：${reasons}`));
    } catch (e) { result.replaceChildren(h('p.form-error', e.message)); }
    finally { run.disabled = false; }
  } }, '检查设备直连');
  box.append(h('div.direct-run', pick, run), result);
  return box;
}
const directReason = (code) => ({
  host: '百度跳转到了不认识的地址', 'status:403': '百度拒绝了这台设备（可能下载地址和服务器的 IP 绑定）', 'status:401': '百度拒绝了这台设备',
  'status:200': '百度不支持按段读取', range: '返回的内容和请求的位置对不上', net: '网络连不上百度', timeout: '连接百度超时',
  'no-direct': '百度没有给出能安全交给设备的地址', failed: '服务器没能拿到直连地址',
}[code] || code);

const BOOK_RE = /\.(epub|cbz|zip)$/i;
const IMG_RE = /\.(jpe?g|png|webp|gif|avif|bmp)$/i;
const fileKind = (it) => (it.isDir ? 'folder' : /\.epub$/i.test(it.name) ? 'books' : /\.(cbz|zip)$/i.test(it.name) ? 'pages' : IMG_RE.test(it.name) ? 'pages' : 'list');

/** 把选中的文件 / 文件夹变成要放上书架的条目：
 *  文件夹里直接就是图片 → 一本漫画；里面是一个个子文件夹 / 压缩包 → 每个算一卷，系列名用文件夹名 */
async function planItems(selected) {
  const out = [];
  for (const it of selected) {
    if (!it.isDir) { out.push({ kind: 'file', fsid: it.fsid, name: it.name, path: it.path, size: it.size, ...(store.guessSeries(it.name.replace(/\.[^.]+$/, '')) || {}) }); continue; }
    const { items } = await store.baidu.list(it.path);
    if (items.some((x) => !x.isDir && IMG_RE.test(x.name))) { out.push({ kind: 'dir', path: it.path, title: it.name, ...(store.guessSeries(it.name) || {}) }); continue; }
    const vols = items.filter((x) => x.isDir || BOOK_RE.test(x.name));
    vols.forEach((x, i) => {
      const title = x.name.replace(/\.[^.]+$/, '');
      const num = store.guessSeries(title)?.volume ?? (Number((title.match(/\d+(\.\d+)?/) || [])[0]) || i + 1);
      out.push(x.isDir ? { kind: 'dir', path: x.path, title, series: it.name, volume: num } : { kind: 'file', fsid: x.fsid, name: x.name, path: x.path, size: x.size, series: it.name, volume: num });
    });
  }
  return out;
}

async function openBaiduBrowser() {
  if (!store.account()) { toast('网盘需要登录账号后使用', { error: true }); return; }
  let st;
  try { st = await store.baidu.status(); } catch (e) { toast(e.message, { error: true }); return; }
  if (!st.connected) {
    if (await confirmDialog('还没有连接百度网盘', '先在“设置 → 网盘”里连接你的百度网盘账号。', { ok: '去连接' })) { view.settingsTab = 'cloud'; setFilter('settings'); }
    return;
  }
  const into = state.collections[view.filter] ? [view.filter] : [];
  await dialog('从百度网盘添加', (close) => {
    let dir = prefs.get('baiduDir', '/');
    const picked = new Map(); // path → item
    const crumbs = h('nav.cd-crumbs', { 'aria-label': '当前位置' });
    const list = h('div.cd-list', { role: 'list' });
    const count = h('span.cd-count');
    const addBtn = h('button.btn.is-primary', { type: 'button', disabled: true, onclick: add }, '放上书架');
    const drawCount = () => {
      count.textContent = picked.size ? `已选 ${picked.size} 项` : '勾选 EPUB、CBZ / ZIP，或者整个漫画文件夹';
      addBtn.disabled = !picked.size;
    };
    async function go(path) {
      dir = path; prefs.set('baiduDir', path);
      const parts = path.split('/').filter(Boolean);
      crumbs.replaceChildren(
        h('button', { type: 'button', onclick: () => go('/') }, '百度网盘'),
        ...parts.flatMap((p, i) => [h('span', '/'), h('button', { type: 'button', onclick: () => go('/' + parts.slice(0, i + 1).join('/')) }, p)]));
      list.replaceChildren(h('p.cd-empty', '正在读取…'));
      let items;
      try { items = (await store.baidu.list(path)).items; }
      catch (e) {
        if (path !== '/') { prefs.set('baiduDir', '/'); return go('/'); }
        list.replaceChildren(h('p.cd-empty.form-error', e.message)); return;
      }
      if (dir !== path) return;
      const usable = items.filter((it) => it.isDir || BOOK_RE.test(it.name));
      const images = items.filter((it) => !it.isDir && IMG_RE.test(it.name)).length;
      list.replaceChildren(
        images > 0 ? h('div.cd-hint', icon('pages', 18), `这个文件夹里有 ${images} 张图片。勾选上一级里的这个文件夹，就能把它当成一本漫画放上书架。`) : '',
        ...(usable.length ? usable.map((it) => {
          const box = h('input', { type: 'checkbox', checked: picked.has(it.path), 'aria-label': `选择 ${it.name}`, onchange: () => { if (box.checked) picked.set(it.path, it); else picked.delete(it.path); drawCount(); } });
          return h('div.cd-row' + (it.isDir ? '.is-dir' : ''), { role: 'listitem' },
            box,
            h('button.cd-name', { type: 'button', onclick: () => (it.isDir ? go(it.path) : (box.checked = !box.checked, box.dispatchEvent(new Event('change')))) },
              h('span.cd-icon', icon(fileKind(it), 20)),
              h('span.cd-label', it.name),
              h('small', it.isDir ? '' : fmtSize(it.size)),
              it.isDir && icon('chevronRight', 16)));
        }) : [h('p.cd-empty', images ? '' : '这里没有可以添加的书（支持 EPUB、CBZ / ZIP 和装着图片的文件夹）。')]));
    }
    async function add() {
      addBtn.disabled = true; addBtn.textContent = '正在整理…';
      try {
        const items = await planItems([...picked.values()]);
        if (!items.length) { toast('选中的内容里没有能看的书', { error: true }); addBtn.textContent = '放上书架'; drawCount(); return; }
        close(true);
        const t = toast('', { sticky: true });
        t.update(`正在添加 ${items.length} 项…`);
        const added = await store.addFromBaidu(items, into, (i, n, b) => t.update(`正在读取封面 ${i} / ${n}：${store.seriesLabel(b)}`));
        const dup = added.filter((a) => a.duplicate).length;
        t.done(`已添加 ${added.length - dup} 本${dup ? `，${dup} 本已在书架上` : ''}`);
      } catch (e) { toast(e.message, { error: true }); addBtn.textContent = '放上书架'; drawCount(); }
    }
    drawCount(); go(dir);
    return h('div.dialog-body.cloud-browser',
      crumbs, list,
      h('p.field-hint', '文件不会复制到你的服务器。看书时服务器按需从网盘取那几页，所以第一次翻开会比本地书慢一点。'),
      h('div.dialog-actions', count, h('button.btn', { type: 'button', onclick: () => close() }, '取消'), addBtn));
  }, { wide: true });
}

/** meta：从在线书库来的资料（系列、作者、标签、简介、原名），导入后补到书上 */
async function importFiles(files, meta = null) {
  files = files.filter((f) => /\.(epub|cbz|zip)$/i.test(f.name));
  if (!files.length) { toast('只支持 EPUB 和 CBZ / ZIP 文件', { error: true }); return []; }
  const into = state.collections[view.filter] ? [view.filter] : [];
  const t = toast('', { sticky: true });
  let ok = 0, dup = 0; const failed = [], added = [];
  for (const [i, file] of files.entries()) {
    t.update(`正在导入 ${i + 1} / ${files.length}：${file.name}`);
    try {
      const r = await store.importBook(file, into);
      if (r.duplicate) dup++; else { ok++; added.push(r.book.id); }
      if (meta && !r.duplicate) await store.updateBook(r.book.id, onlinePatch(r.book, meta)).catch(() => {});
    } catch (e) { failed.push(`${file.name}（${e.message}）`); }
  }
  const parts = [];
  if (ok) parts.push(`已导入 ${ok} 本`);
  if (dup) parts.push(`${dup} 本已在书架上`);
  if (failed.length) parts.push(`失败：${failed.join('；')}`);
  t.done(parts.join('，'), !!failed.length);
  return added;
}
function onlinePatch(book, meta) {
  const patch = {};
  const fill = (k, v) => { if (v && !book[k]) patch[k] = v; };
  if (meta.series) {
    patch.series = meta.series;
    const m = /([0-9０-９]+(?:\.[0-9]+)?)\s*[卷巻册集]?\s*[)）】\]]?\s*$/.exec(meta.title || '');
    if (m) patch.volume = Number(m[1].replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)));
  }
  fill('author', meta.author); fill('illustrator', meta.illustrator); fill('publisher', meta.publisher);
  fill('description', meta.description); fill('originalTitle', meta.originalTitle);
  if (meta.tags?.length) patch.tags = [...new Set([...(book.tags || []), ...meta.tags])].slice(0, 20);
  return patch;
}
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (!els || !e.dataTransfer?.types.includes('Files')) return;
  dragDepth++; document.body.classList.add('is-dragging');
});
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('is-dragging'); } });
window.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
window.addEventListener('drop', (e) => {
  if (!e.dataTransfer?.files.length) return;
  e.preventDefault(); dragDepth = 0; document.body.classList.remove('is-dragging');
  if (els && readerHost.hidden) importFiles([...e.dataTransfer.files]);
});

// ---------- 安卓返回键 ----------
// 原生层（MainActivity）按下返回键时先问这里：一层层往回退，退到“全部”还没东西可关才返回 false，让应用退出。
function pressEscape() { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); }
window.__onBack = () => {
  try {
    const dlg = [...document.querySelectorAll('dialog[open]')].pop();
    if (dlg) { if (dlg.dispatchEvent(new Event('cancel', { cancelable: true }))) dlg.close(); return true; }
    if (document.querySelector('.viewer, .pop-menu, .dropdown-btn[aria-expanded=true]')) { pressEscape(); return true; }
    if (!readerHost.hidden) { pressEscape(); return true; } // 阅读器自己按层处理：选区 → 面板 → 菜单 → 退出阅读
    if (document.body.classList.contains('nav-open')) { setDrawer(false); return true; }
    if (!els) return false;
    if (view.selecting) { exitSelect(); return true; }
    if (view.query) { view.query = ''; els.searchBox.classList.remove('is-open'); els.search.value = ''; renderBody(); return true; }
    if (view.detail) { hideDetail(); return true; }
    if (isSeries(view.filter)) { setFilter(view.back && !isSeries(view.back) ? view.back : 'all', true); return true; }
    if (view.filter !== 'all') { setFilter('all'); return true; }
  } catch (err) { console.error(err); }
  return false;
};

// ---------- 阅读器路由 ----------
// #/read/<书> 打开书；#/read/<书>/<记号> 打开并跳到某条划线 / 书签
function openBook(id, markId) { location.hash = `#/read/${id}${markId ? '/' + markId : ''}`; }
let reader = null, routeToken = 0, cameFromShelf = false;
function leaveReader() {
  if (cameFromShelf) history.back(); else location.hash = '#/';
}
async function route() {
  const token = ++routeToken;
  const m = /^#\/read\/([a-f0-9]+)(?:\/([a-f0-9]+))?$/.exec(location.hash);
  if (reader) { const r = reader; reader = null; store.stopReading(); await r.destroy(); store.flushNow(); }
  if (!m || !store.hasStarted()) {
    readerHost.hidden = true; readerHost.replaceChildren(); app.hidden = false;
    document.title = 'スス子文庫';
    cameFromShelf = true;
    renderAll();
    return;
  }
  const book = state.books[m[1]];
  if (!book) { toast('这本书已经不在书架上了', { error: true }); location.replace('#/'); return; }
  const jump = m[2] && state.marks[book.id]?.[m[2]];

  document.querySelectorAll('dialog[open]').forEach((d) => d.close());
  exitSelect(false);
  app.hidden = true; readerHost.hidden = false;
  document.title = store.seriesLabel(book);
  const note = h('p');
  readerHost.replaceChildren(h('div.loading',
    h('button.icon-btn.loading-back', { type: 'button', 'aria-label': '返回书架', onclick: leaveReader }, icon('back')),
    loader('正在打开'), h('h2', store.seriesLabel(book)), note));
  let handle = null;
  try {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const [got, fresh] = await Promise.all([
      store.bookSource(book),
      Promise.race([store.freshProgress(book.id), wait(2500).then(() => state.progress[book.id] || null)]),
    ]);
    handle = got;
    if (token !== routeToken) { handle.release(); return; }
    const progress = jump ? { loc: jump.loc, percent: jump.percent } : fresh;
    const mod = await (book.format === 'epub' ? import('./reader-epub.js') : import('./reader-comic.js'));
    const opened = await mod.open({ host: readerHost, book, title: store.seriesLabel(book), source: handle.source, progress, onExit: leaveReader, flash: jump?.id });
    if (token !== routeToken) { opened.destroy(); handle.release(); return; }
    reader = { destroy: async () => { await opened.destroy(); handle.release(); } };
    store.startReading(book.id);
    if (!jump && fresh && fresh.percent > 0 && fresh.device && fresh.device !== store.deviceName()) {
      toast(`已接上「${fresh.device}」的进度 ${fmtPercent(fresh.percent)}`);
    }
  } catch (e) {
    if (token !== routeToken) return;
    console.error(e);
    handle?.release();
    note.textContent = `打不开这本书：${e.message}`; note.classList.add('form-error');
  }
}
window.addEventListener('hashchange', route);

// ---------- 启动 ----------
store.onChange(() => { if (els && !app.hidden) renderAll(); });
function startShelf() {
  document.body.classList.toggle('no-pill', !prefs.get('pill', true));
  applyFabStyle();
  renderShelf();
  cameFromShelf = !location.hash.startsWith('#/read');
  route();
  store.sync().catch(() => {});
}
// 回到前台或恢复联网时自动同步
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && readerHost.hidden && store.isConfigured()) store.sync().catch(() => {});
});
window.addEventListener('online', () => store.sync().catch(() => {}));
// 窗口变窄后，书架旁边自动打开的详情要收起来（手机上它会盖住整个屏幕）
window.addEventListener('resize', () => { if (view.autoDetail && window.innerWidth <= 1180 && els) hideDetail(); });
// 别的设备改过的设置同步过来了：重新套用主题、视图
window.addEventListener('settings-synced', () => {
  applyTheme();
  view.layout = prefs.get('layout', view.layout); view.sort = prefs.get('sort', view.sort);
  document.body.classList.toggle('no-pill', !prefs.get('pill', true));
  applyFabStyle();
  if (els) renderAll();
});
// 阅读器里点“去设置”：回到书架后打开对应的设置页
window.addEventListener('open-settings', (e) => {
  view.settingsTab = e.detail || 'account';
  view.filter = 'settings';
  if (els) renderAll();
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && view.detail && readerHost.hidden && !document.querySelector('dialog[open]')) hideDetail();
  if (els?.shelf && readerHost.hidden && !document.querySelector('dialog[open]') && !e.target.closest?.('input, textarea, select, .shelf3d')) {
    if (e.key === 'ArrowRight') els.shelf.api.next(); else if (e.key === 'ArrowLeft') els.shelf.api.prev();
  }
});
(async () => {
  if (window.__susukoApplePlatform) {
    const { mountAppleInterface } = await import('./apple-interface.js');
    mountAppleInterface(window.__susukoApplePlatform, prefs.get('appleInterfaceSize', 'comfortable'));
  }
  mountWinbar();
  await store.init();
  if (!store.hasStarted()) { if (location.hash.startsWith('#/read')) history.replaceState(null, '', '#/'); renderWelcome(); return; }
  startShelf();
})();
