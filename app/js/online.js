// 在线书库：Novelia（轻小说机翻机器人）。文库小说按封面宫格，网络小说按列表。
// 点开看详情，“加入书架”会让自己的服务器去 Novelia 取 EPUB，拿回来按普通文件导入。
import { h, icon, loader, toast, dialog, confirmDialog } from './ui.js';
import * as store from './store.js';

// 分级、筛选和 Novelia 网站上的一致；R18 那几项要登录后才会出现
const LEVELS = [[0, '全部'], [1, '轻小说'], [2, '轻文学'], [3, '文学'], [4, '非小说'], [5, 'R18男性向', true], [6, 'R18女性向', true]];
const WEB_TYPES = [[0, '全部'], [1, '连载中'], [2, '已完结'], [3, '短篇']];
const WEB_LEVELS = [[0, '全部', true], [1, '一般向'], [2, 'R18', true]];
const WEB_TRANSLATE = [[0, '全部'], [1, 'GPT'], [2, 'Sakura']];
const WEB_SORT = [[0, '更新'], [1, '点击'], [2, '相关']];
const PROVIDERS = ['kakuyomu', 'syosetu', 'novelup', 'hameln', 'pixiv', 'alphapolis'];
const PROVIDER_NAMES = { kakuyomu: 'Kakuyomu', syosetu: '成为小说家吧', novelup: 'Novelup', hameln: 'Hameln', pixiv: 'Pixiv', alphapolis: 'Alphapolis' };
const TRANSLATOR_NAMES = { sakura: 'Sakura', gpt: 'GPT', youdao: '有道', baidu: '百度' };

const st = {
  tab: store.prefs.get('onlineTab', 'wenku'), query: '', level: 0, type: 0,
  providers: [...PROVIDERS], wlevel: null, translate: 0, sort: 0,
  items: [], page: 0, pages: 1, loading: false, error: '', token: 0, account: null,
};

/** 文库小说标题里常带“（1）”“第2卷”，拆成系列名，导入后能和同系列的放在一起 */
const seriesOf = (title) => String(title || '').replace(/\s*[(（【\[]?\s*(第?\s*[0-9０-９一二三四五六七八九十]+\s*[卷巻集册]?)\s*[)）】\]]?\s*$/, '').trim();

export function renderOnline(body, { importFiles, popMenu }) {
  body.className = 'body online-page';
  if (!store.isConfigured()) {
    body.replaceChildren(h('div.ol-empty', h('p', '在线书库要通过你自己的服务器转发（Novelia 不允许网页直接跨站请求）。'), h('p.muted', '先在 设置 → 账号 里连上服务器就能用了。')));
    return;
  }
  const search = h('input.field.ol-search', {
    type: 'search', placeholder: st.tab === 'wenku' ? '搜文库小说：书名、作者、标签' : '搜网络小说：书名、作者、标签', value: st.query, 'aria-label': '搜索在线书库',
    onkeydown: (e) => { if (e.key === 'Enter') { st.query = search.value.trim(); reload(); } },
  });
  const ctx = { importFiles };
  const tabBtn = (v, label) => h('button' + (st.tab === v ? '.is-on' : ''), { type: 'button', onclick: () => {
    if (st.tab === v) return;
    st.tab = v; store.prefs.set('onlineTab', v); st.items = []; st.token++; st.loading = false;
    io.disconnect(); renderOnline(body, ctx); // 两边的筛选条件不一样，整页重画
  } }, label);
  const signedIn = () => !!st.account?.signedIn;
  // 一行筛选：点了立刻重画这一块（以前只改了数据没重画，要切出去再切回来才看得到高亮）
  const row = (label, list, get, set) => h('div.ol-filter', h('span.ol-filter-label', label), h('div.ol-chips', list
    .filter(([, , needLogin]) => !needLogin || signedIn())
    .map(([v, text]) => h('button.tag-chip' + (get() === v ? '.is-on' : ''), {
      type: 'button', 'aria-pressed': String(get() === v), onclick: () => { if (get() === v) return; set(v); drawFilters(); reload(); },
    }, text))));
  const filters = h('div.ol-filters');
  function drawFilters() {
    if (st.tab === 'wenku') {
      if (!signedIn() && st.level >= 5) st.level = 0;
      filters.replaceChildren(row('分级', LEVELS, () => st.level, (v) => { st.level = v; }));
      return;
    }
    if (st.wlevel == null || (!signedIn() && st.wlevel !== 1)) st.wlevel = signedIn() ? 0 : 1;
    const on = (p) => st.providers.includes(p);
    filters.replaceChildren(
      h('div.ol-filter', h('span.ol-filter-label', '来源'), h('div.ol-chips',
        PROVIDERS.map((p) => h('button.tag-chip' + (on(p) ? '.is-on' : ''), {
          type: 'button', 'aria-pressed': String(on(p)),
          onclick: () => { st.providers = on(p) ? st.providers.filter((x) => x !== p) : [...st.providers, p]; if (!st.providers.length) st.providers = [p]; drawFilters(); reload(); },
        }, PROVIDER_NAMES[p])),
        h('button.icon-btn.is-small', { type: 'button', title: '反选来源', 'aria-label': '反选来源', onclick: () => { const inv = PROVIDERS.filter((p) => !on(p)); st.providers = inv.length ? inv : [...PROVIDERS]; drawFilters(); reload(); } }, icon('sync', 16)))),
      row('类型', WEB_TYPES, () => st.type, (v) => { st.type = v; }),
      row('分级', WEB_LEVELS, () => st.wlevel, (v) => { st.wlevel = v; }),
      row('翻译', WEB_TRANSLATE, () => st.translate, (v) => { st.translate = v; }),
      row('排序', WEB_SORT, () => st.sort, (v) => { st.sort = v; }));
  }
  const acct = h('div.ol-account');
  const results = h('div.ol-results');
  const more = h('div.ol-more');
  const head = h('div.ol-head',
    h('div.segmented.ol-tabs', { role: 'group', 'aria-label': '书库' }, tabBtn('wenku', '文库小说'), tabBtn('web', '网络小说')),
    h('form.ol-searchbox', { onsubmit: (e) => { e.preventDefault(); st.query = search.value.trim(); reload(); } }, icon('search', 18), search),
    acct);
  body.replaceChildren(head, filters, results, more, h('p.ol-credit', '内容来自 ', h('a', { href: 'https://n.novelia.cc', target: '_blank', rel: 'noopener' }, 'Novelia 轻小说机翻机器人'), '，译文是机器翻译。'));

  // 已登录时点账号只弹出菜单，退出要再确认一次，免得误点就掉线
  function drawAccount() {
    const a = st.account;
    acct.replaceChildren(a?.signedIn
      ? h('button.btn.is-soft.is-small', { type: 'button', title: 'Novelia 账号', 'aria-haspopup': 'menu', onclick: (e) => accountMenu(e.currentTarget) }, icon('user', 16), a.username || '已登录')
      : h('button.btn.is-soft.is-small', { type: 'button', onclick: loginDialog }, '登录 Novelia'));
  }
  async function logout() {
    if (!await confirmDialog('退出 Novelia', '退出后 R18 分级会隐藏，需要重新输入密码才能再登录。', { ok: '退出登录', danger: true })) return;
    st.account = await store.novelia.logout().catch(() => ({ signedIn: false }));
    drawAccount(); drawFilters(); reload();
  }
  function accountMenu(anchor) {
    const a = st.account || {};
    const items = [
      { icon: 'globe', label: '打开 Novelia 网站', sub: 'n.novelia.cc', onclick: () => window.open('https://n.novelia.cc', '_blank', 'noopener') },
      { icon: 'logout', label: '退出登录', onclick: logout },
    ];
    if (popMenu) popMenu(anchor, [{ title: a.username ? `已登录：${a.username}` : '已登录 Novelia', items }]);
    else logout();
  }
  async function loginDialog() {
    await dialog('登录 Novelia', (close) => {
      const u = h('input.field', { type: 'text', autocomplete: 'username', placeholder: '用户名或邮箱', 'aria-label': 'Novelia 用户名' });
      const p = h('input.field', { type: 'password', autocomplete: 'current-password', placeholder: '密码', 'aria-label': 'Novelia 密码' });
      const msg = h('p.form-error', { hidden: true });
      setTimeout(() => u.focus(), 30);
      return h('form.dialog-body', {
        onsubmit: async (e) => {
          e.preventDefault(); msg.hidden = true;
          try { st.account = await store.novelia.login(u.value.trim(), p.value); close(true); }
          catch (err) { msg.textContent = err.message; msg.hidden = false; }
        },
      },
      h('p.dialog-text', '不登录也能浏览和下载大部分作品。登录后账号令牌只保存在你自己的服务器上，不会存进这台设备。'),
      u, p, msg,
      h('div.dialog-actions', h('button.btn', { type: 'button', onclick: () => close() }, '取消'), h('button.btn.is-primary', { type: 'submit' }, '登录')));
    });
    drawAccount(); drawFilters(); reload();
  }

  function draw() {
    if (!body.isConnected) return;
    if (st.error && !st.items.length) { results.replaceChildren(h('div.ol-empty', h('p', st.error), h('button.btn.is-soft', { type: 'button', onclick: reload }, '重试'))); }
    else if (st.tab === 'wenku') {
      results.replaceChildren(h('div.ol-grid', st.items.map((x) => h('button.ol-card', { type: 'button', onclick: () => openWenku(x.id, importFiles) },
        h('span.ol-cover', x.cover ? h('img', { src: x.cover, alt: '', loading: 'lazy', referrerPolicy: 'no-referrer', onerror: (e) => e.target.remove() }) : '', h('span.ol-cover-fallback', x.title.slice(0, 12))),
        h('span.ol-title', x.title), x.titleJp && x.titleJp !== x.title ? h('span.ol-sub', x.titleJp) : ''))));
    } else {
      results.replaceChildren(h('div.ol-list', st.items.map((x) => h('button.ol-row', { type: 'button', onclick: () => openWeb(x.provider, x.id, importFiles) },
        h('span.ol-row-main',
          h('span.ol-title', x.title),
          x.titleJp && x.titleJp !== x.title ? h('span.ol-sub', x.titleJp) : '',
          h('span.ol-meta', [PROVIDER_NAMES[x.provider] || x.provider, x.type, x.total ? `${x.translated} / ${x.total} 章已译` : '', x.updateAt ? fmtDate(x.updateAt) + ' 更新' : ''].filter(Boolean).join(' · ')),
          x.keywords.length ? h('span.ol-kw', x.keywords.slice(0, 6).map((k) => h('span.tag-chip.is-tiny', k))) : ''),
        h('span.ol-ring', { style: `--p:${x.total ? x.translated / x.total : 0}`, title: '翻译进度' })))));
    }
    if (!st.items.length && !st.loading && !st.error) results.replaceChildren(h('div.ol-empty', h('p', st.query ? `没找到“${st.query}”` : '这里还什么都没有')));
    more.replaceChildren(st.loading ? loader('正在加载') : st.page < st.pages && st.items.length ? h('button.btn.is-soft', { type: 'button', onclick: loadMore }, '加载更多') : '');
  }
  async function fetchPage(page) {
    const token = ++st.token;
    st.loading = true; st.error = ''; draw();
    try {
      const data = st.tab === 'wenku'
        ? await store.novelia.wenku({ page, pageSize: 24, query: st.query, level: st.level })
        : await store.novelia.web({ page, pageSize: 30, query: st.query, type: st.type, provider: st.providers.join(','), level: st.wlevel ?? 1, translate: st.translate, sort: st.sort });
      if (token !== st.token) return;
      st.items = page === 0 ? data.items : [...st.items, ...data.items];
      st.page = page + 1; st.pages = data.pages || 1;
    } catch (e) {
      if (token !== st.token) return;
      st.error = e.message;
    }
    st.loading = false; draw();
  }
  function reload() { st.items = []; st.page = 0; fetchPage(0); }
  function loadMore() { if (!st.loading) fetchPage(st.page); }
  // 滑到底自动加载下一页
  const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting) && st.page < st.pages && st.items.length && !st.loading) loadMore(); }, { rootMargin: '400px' });
  io.observe(more);

  draw(); drawAccount(); drawFilters();
  if (!st.account) store.novelia.status().then((a) => { st.account = a; drawAccount(); drawFilters(); }).catch(() => {});
  if (!st.items.length || st.lastTab !== st.tab) { st.lastTab = st.tab; reload(); }
}

const fmtDate = (t) => { const d = new Date(t > 1e12 ? t : t * 1000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const pct = (n, total) => (total ? Math.round((n / total) * 100) : 0);

/** 下载格式：中文 / 中日对照，存在偏好里 */
function formatRow() {
  const cur = store.prefs.get('noveliaMode', 'zh');
  const seg = h('div.segmented', { role: 'group', 'aria-label': '下载格式' }, [['zh', '中文'], ['zh-jp', '中日对照']].map(([v, t]) => h('button' + (cur === v ? '.is-on' : ''), {
    type: 'button', onclick: (e) => { store.prefs.set('noveliaMode', v); for (const b of seg.children) b.classList.toggle('is-on', b === e.currentTarget); },
  }, t)));
  return h('div.ol-format', h('span', '下载格式'), seg);
}

async function addToShelf(btn, query, meta, importFiles) {
  const old = [...btn.childNodes];
  btn.disabled = true; btn.replaceChildren(loader('正在下载'), h('span', '正在取回…'));
  try {
    const file = await store.novelia.file({ ...query, mode: store.prefs.get('noveliaMode', 'zh') });
    const ids = await importFiles([file], meta);
    btn.replaceChildren(icon('check', 18), h('span', ids?.length ? '已加入书架' : '已在书架上'));
    btn.classList.add('is-done');
  } catch (e) {
    toast(e.message, { error: true });
    btn.disabled = false; btn.replaceChildren(...old);
  }
}

async function openWenku(id, importFiles) {
  await dialog('文库小说', () => {
    const box = h('div.dialog-body.ol-detail', h('div.ol-detail-loading', loader('正在加载')));
    store.novelia.wenkuOne(id).then((x) => {
      const metaFor = (vol) => ({
        series: seriesOf(x.title) || x.title, author: x.authors.join('、'), illustrator: x.artists.join('、'),
        publisher: x.imprint || x.publisher, tags: x.keywords.slice(0, 8), description: x.introduction, originalTitle: x.titleJp,
        title: vol,
      });
      const files = x.files.filter((f) => f.sakura || f.gpt || f.youdao || f.baidu);
      box.replaceChildren(
        h('div.ol-detail-top',
          h('span.ol-cover.is-big', x.cover ? h('img', { src: x.cover, alt: '', referrerPolicy: 'no-referrer' }) : h('span.ol-cover-fallback', x.title)),
          h('div.ol-detail-info',
            h('h3', x.title), x.titleJp && x.titleJp !== x.title ? h('p.ol-sub', x.titleJp) : '',
            h('p.ol-meta', [x.authors.join('、'), x.artists.length ? '插画 ' + x.artists.join('、') : '', x.imprint || x.publisher, x.level].filter(Boolean).join(' · ')),
            x.keywords.length ? h('div.ol-kw', x.keywords.slice(0, 14).map((k) => h('span.tag-chip.is-tiny', k))) : '')),
        x.introduction ? h('p.ol-intro', x.introduction) : '',
        formatRow(),
        h('h4', `可以下载的卷（${files.length}）`),
        files.length
          ? h('div.ol-vols', files.map((f) => {
            const name = f.volumeId.replace(/\.(epub|txt)$/i, '');
            const best = Math.max(f.sakura, f.gpt, f.youdao, f.baidu);
            const btn = h('button.btn.is-primary.is-small', { type: 'button', onclick: () => addToShelf(btn, { kind: 'wenku', id, volume: f.volumeId }, metaFor(name), importFiles) }, icon('plus', 16), h('span', '加入书架'));
            return h('div.ol-vol',
              h('div.ol-vol-main', h('b', name),
                h('small', Object.keys(TRANSLATOR_NAMES).filter((t) => f[t]).map((t) => `${TRANSLATOR_NAMES[t]} ${pct(f[t], f.total)}%`).join(' · ') || '还没有翻译')),
              best < f.total ? h('span.ol-partial', { title: '没翻完的段落会显示日文原文' }, '未译完') : '',
              btn);
          }))
          : h('p.muted', x.signedIn ? '这部作品还没有可下载的译文。' : '这部作品还没有可下载的译文。有些作品要登录 Novelia 才能看到。'));
    }).catch((e) => box.replaceChildren(h('p.form-error', e.message)));
    return box;
  }, { wide: true });
}

async function openWeb(provider, id, importFiles) {
  await dialog('网络小说', () => {
    const box = h('div.dialog-body.ol-detail', h('div.ol-detail-loading', loader('正在加载')));
    store.novelia.webOne(provider, id).then((x) => {
      const best = Math.max(x.sakura, x.gpt, x.youdao, x.baidu);
      const btn = h('button.btn.is-primary', { type: 'button', onclick: () => addToShelf(btn, { kind: 'web', provider, id, title: x.title }, {
        title: x.title, author: x.authors.join('、'), tags: x.keywords.slice(0, 8), description: x.introduction, originalTitle: x.titleJp,
      }, importFiles) }, icon('plus', 18), h('span', '整本加入书架'));
      box.replaceChildren(
        h('h3', x.title), x.titleJp && x.titleJp !== x.title ? h('p.ol-sub', x.titleJp) : '',
        h('p.ol-meta', [x.authors.join('、'), PROVIDER_NAMES[provider] || provider, x.type, `${x.chapters} 章`, x.totalCharacters ? `${Math.round(x.totalCharacters / 10000)} 万字` : ''].filter(Boolean).join(' · ')),
        x.keywords.length ? h('div.ol-kw', x.keywords.slice(0, 16).map((k) => h('span.tag-chip.is-tiny', k))) : '',
        x.introduction ? h('p.ol-intro', x.introduction) : '',
        h('p.ol-progress', `已翻译 ${best} / ${x.jp || x.chapters} 章`, Object.keys(TRANSLATOR_NAMES).filter((t) => x[t]).map((t) => h('span.tag-chip.is-tiny', `${TRANSLATOR_NAMES[t]} ${x[t]}`))),
        formatRow(),
        h('div.ol-actions', btn),
        best < (x.jp || x.chapters) ? h('p.muted', '没翻译的章节会以日文原文出现在 EPUB 里。网络小说还在更新时，过一阵再加一次就是新的一份。') : '',
        x.toc.length ? h('details.ol-toc', h('summary', `目录（${x.chapters} 章）`), h('ol', x.toc.slice(0, 400).map((t) => h('li' + (t.chapterId ? '' : '.is-vol'), t.title)))) : '');
    }).catch((e) => box.replaceChildren(h('p.form-error', e.message)));
    return box;
  }, { wide: true });
}
