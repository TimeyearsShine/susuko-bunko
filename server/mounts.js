// 挂载：把别处的书放上书架，文件留在原处，看的时候由服务器按需去取。
//   webdav —— WebDAV（坚果云、Nextcloud、群晖 / 威联通、AList / OpenList 等）。
//             阿里云盘、115、123 云盘、OneDrive、Dropbox 这些网盘可以先用 AList / OpenList 挂上，再按 WebDAV 接进来。
//   opds   —— OPDS 书目（Calibre、Calibre-Web、Komga、Kavita……）。只浏览和下载：“加入书架”会把书取回来按普通文件导入。
//   folder —— 服务器上的文件夹。SMB / NAS 共享先在服务器上挂成一个目录（比如 mount -t cifs），再选这个目录。
//             为了安全，只能选环境变量 MOUNT_ROOTS 里列出的目录（多个用冒号分隔），没设置就不能用。
// 账号密码只存在服务器上，不会下发给客户端。
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { Readable } = require('node:stream');

const ROOTS = (process.env.MOUNT_ROOTS || '').split(path.delimiter).map((s) => s.trim()).filter(Boolean).map((p) => path.resolve(p));
const UA = 'susuko-bunko/0.13';
const BOOK_RE = /\.(epub|cbz|zip)$/i;

const err = (status, message) => Object.assign(new Error(message), { status });
const xmlText = (s) => String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, '&').trim();
/** 取 XML 里某个标签（不管带什么命名空间前缀）的所有块 */
const blocks = (xml, tag) => [...String(xml).matchAll(new RegExp(`<(?:[\\w-]+:)?${tag}\\b[^>]*?(?:/>|>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>)`, 'gi'))].map((m) => ({ all: m[0], inner: m[1] || '' }));
const first = (xml, tag) => blocks(xml, tag)[0]?.inner ?? '';
const attr = (tagText, name) => { const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tagText); return m ? xmlText(m[2] ?? m[3]) : ''; };

function checkUrl(u) {
  let url;
  try { url = new URL(u); } catch { throw err(400, '地址格式不对，要以 http:// 或 https:// 开头'); }
  if (!/^https?:$/.test(url.protocol)) throw err(400, '只支持 http:// 或 https:// 地址');
  return url;
}
const authHeader = (m) => (m.username ? { Authorization: 'Basic ' + Buffer.from(`${m.username}:${m.password || ''}`).toString('base64') } : {});

// ---------- WebDAV ----------
const davBase = (m) => { const u = checkUrl(m.url); if (!u.pathname.endsWith('/')) u.pathname += '/'; return u; };
const davUrl = (m, p) => {
  const base = davBase(m);
  const rel = String(p || '/').split('/').filter(Boolean).map(encodeURIComponent).join('/');
  return new URL(rel, base).toString();
};
async function davList(m, dir) {
  const url = davUrl(m, dir) + (dir && dir !== '/' && !/\/$/.test(dir) ? '/' : '');
  const res = await fetch(url, {
    method: 'PROPFIND', redirect: 'follow', signal: AbortSignal.timeout(30000),
    headers: { ...authHeader(m), Depth: '1', 'Content-Type': 'application/xml; charset=utf-8', 'User-Agent': UA },
    body: '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:getcontentlength/><d:resourcetype/><d:getlastmodified/></d:prop></d:propfind>',
  }).catch((e) => { throw err(502, `连不上 WebDAV：${e.cause?.code || e.message}`); });
  if (res.status === 401) throw err(400, 'WebDAV 用户名或密码不对');
  if (res.status === 404) throw err(404, '这个文件夹不存在');
  if (res.status !== 207 && !res.ok) throw err(502, `WebDAV 返回 ${res.status}`);
  const xml = await res.text();
  const basePath = decodeURIComponent(davBase(m).pathname);
  const here = decodeURIComponent(new URL(url).pathname).replace(/\/+$/, '');
  const items = [];
  for (const r of blocks(xml, 'response')) {
    let href = xmlText(first(r.inner, 'href'));
    try { href = decodeURIComponent(new URL(href, url).pathname); } catch { continue; }
    if (href.replace(/\/+$/, '') === here) continue; // 文件夹自己
    const isDir = /<(?:[\w-]+:)?collection\b/i.test(first(r.inner, 'resourcetype'));
    const rel = '/' + href.slice(basePath.length).replace(/^\/+|\/+$/g, '');
    const name = xmlText(first(r.inner, 'displayname')) || rel.split('/').pop();
    items.push({ name, path: rel, isDir, size: Number(xmlText(first(r.inner, 'getcontentlength'))) || 0, mtime: Date.parse(xmlText(first(r.inner, 'getlastmodified'))) || 0 });
  }
  return items;
}

// ---------- 服务器上的文件夹 ----------
function folderPath(m, p) {
  const root = path.resolve(m.url);
  if (!ROOTS.some((r) => root === r || root.startsWith(r + path.sep))) throw err(403, '这个目录不在服务器允许挂载的范围里（MOUNT_ROOTS）');
  const full = path.resolve(root, '.' + path.sep + String(p || '/').replace(/^\/+/, ''));
  if (full !== root && !full.startsWith(root + path.sep)) throw err(400, '路径不对');
  return full;
}
async function folderList(m, dir) {
  const full = folderPath(m, dir);
  const ents = await fsp.readdir(full, { withFileTypes: true }).catch(() => { throw err(404, '这个文件夹不存在或没有权限读取'); });
  const out = [];
  for (const e of ents.slice(0, 5000)) {
    if (e.name.startsWith('.')) continue;
    const st = await fsp.stat(path.join(full, e.name)).catch(() => null);
    if (!st) continue;
    out.push({ name: e.name, path: (dir.replace(/\/+$/, '') + '/' + e.name).replace(/^\/*/, '/'), isDir: st.isDirectory(), size: st.isFile() ? st.size : 0, mtime: st.mtimeMs });
  }
  return out;
}

// ---------- OPDS ----------
async function opdsFeed(m, href) {
  const base = checkUrl(m.url);
  const url = href ? new URL(href, base) : base;
  if (url.host !== base.host) throw err(400, '只能浏览同一个 OPDS 站点里的内容');
  const res = await fetch(url, { headers: { ...authHeader(m), Accept: 'application/atom+xml, application/xml;q=0.9, */*;q=0.5', 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(30000) })
    .catch((e) => { throw err(502, `连不上 OPDS：${e.cause?.code || e.message}`); });
  if (res.status === 401) throw err(400, 'OPDS 用户名或密码不对');
  if (!res.ok) throw err(502, `OPDS 返回 ${res.status}`);
  const xml = await res.text();
  if (!/<feed\b/i.test(xml)) throw err(502, '这个地址返回的不是 OPDS 书目（应该是 Atom 格式）');
  const abs = (h) => { try { return new URL(h, url).toString(); } catch { return ''; } };
  const links = (x) => blocks(x, 'link').map((l) => ({ rel: attr(l.all, 'rel'), href: abs(attr(l.all, 'href')), type: attr(l.all, 'type').toLowerCase(), title: attr(l.all, 'title') }));
  const feedHead = xml.replace(/<entry\b[\s\S]*$/i, '');
  const next = links(feedHead).find((l) => l.rel === 'next')?.href || '';
  const search = links(feedHead).find((l) => l.rel === 'search')?.href || '';
  const items = [];
  for (const e of blocks(xml, 'entry')) {
    const ls = links(e.inner);
    const title = xmlText(first(e.inner, 'title'));
    const author = blocks(e.inner, 'author').map((a) => xmlText(first(a.inner, 'name'))).filter(Boolean).join('、');
    const cover = (ls.find((l) => /opds-spec\.org\/image\/thumbnail/.test(l.rel)) || ls.find((l) => /opds-spec\.org\/image|opds-spec\.org\/cover/.test(l.rel)))?.href || '';
    const acq = ls.filter((l) => /acquisition/.test(l.rel) || /epub|cbz|comicbook|zip/.test(l.type));
    const book = acq.find((l) => /epub/.test(l.type)) || acq.find((l) => /cbz|comicbook|zip/.test(l.type));
    const nav = ls.find((l) => /atom\+xml|opds-catalog/.test(l.type) && !/acquisition/.test(l.rel) && l.rel !== 'alternate' || l.rel === 'subsection');
    if (book) {
      const ext = /epub/.test(book.type) ? 'epub' : 'cbz';
      items.push({ name: title, title, author, path: book.href, isDir: false, kind: 'book', format: ext, fileName: `${title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 120) || 'book'}.${ext}`, cover, summary: xmlText(first(e.inner, 'summary') || first(e.inner, 'content')).slice(0, 600) });
    } else if (nav) items.push({ name: title, path: nav.href, isDir: true, summary: xmlText(first(e.inner, 'content')).slice(0, 200) });
  }
  return { title: xmlText(first(feedHead, 'title')), items, next, search };
}

module.exports = function createMounts({ json, fail, readJson, save, str, newId, volumeOf, mimeByName, sendFile, IMAGE_RE, naturalCmp }) {
  const mountsOf = (lib) => lib.cloud.mounts || (lib.cloud.mounts = {});
  const pub = (m) => ({ id: m.id, kind: m.kind, name: m.name, url: m.url, username: m.username || '', addedAt: m.addedAt });
  const sortItems = (items) => items.sort((a, b) => (b.isDir - a.isDir) || naturalCmp(a.name, b.name));
  async function list(m, p) {
    if (m.kind === 'webdav') return { items: sortItems(await davList(m, p)) };
    if (m.kind === 'folder') return { items: sortItems(await folderList(m, p)) };
    if (m.kind === 'opds') return opdsFeed(m, p);
    throw err(400, '不认识的挂载方式');
  }

  /** 把挂载里的文件按需转发给客户端，Range 原样带过去 */
  async function stream(req, res, m, p, name, cacheable = false) {
    if (!m) return fail(res, 404, '这个挂载已经被删掉了，书架上的这本书暂时打不开');
    if (m.kind === 'folder') {
      let full;
      try { full = folderPath(m, p); } catch (e) { return fail(res, e.status, e.message); }
      return sendFile(req, res, full, mimeByName(name || p));
    }
    const ctrl = new AbortController();
    req.on('close', () => ctrl.abort());
    try {
      const url = m.kind === 'webdav' ? davUrl(m, p) : (() => { const u = new URL(p, checkUrl(m.url)); if (u.host !== checkUrl(m.url).host) throw err(400, '地址不对'); return u.toString(); })();
      const r = await fetch(url, {
        method: req.method === 'HEAD' ? 'HEAD' : 'GET', redirect: 'follow', signal: ctrl.signal,
        headers: { ...authHeader(m), 'User-Agent': UA, ...(req.headers.range ? { Range: req.headers.range } : {}) },
      });
      if (r.status === 401) return fail(res, 502, `${m.name}：用户名或密码不对，请在设置里重新填写`);
      if (!r.ok) return fail(res, 502, `${m.name} 返回 ${r.status}`);
      const out = { 'Content-Type': mimeByName(name || p), 'Accept-Ranges': 'bytes', 'Cache-Control': cacheable ? 'private, max-age=86400' : 'no-store' };
      for (const k of ['content-length', 'content-range']) { const v = r.headers.get(k); if (v) out[k] = v; }
      res.writeHead(r.status, out);
      if (req.method === 'HEAD' || !r.body) return res.end();
      Readable.fromWeb(r.body).on('error', () => res.destroy()).pipe(res);
    } catch (e) {
      if (ctrl.signal.aborted) return;
      return fail(res, e.status || 502, e.message);
    }
  }

  async function api(req, res, seg, q, lib) {
    const M = req.method;
    const all = mountsOf(lib);
    try {
      if (!seg.length && M === 'GET') return json(res, 200, { mounts: Object.values(all).map(pub), folderRoots: ROOTS });
      if (!seg.length && M === 'POST') {
        const b = await readJson(req, 16 * 1024);
        const kind = ['webdav', 'opds', 'folder'].includes(b.kind) ? b.kind : '';
        if (!kind) return fail(res, 400, '挂载方式不对');
        if (Object.keys(all).length >= 30) return fail(res, 400, '挂载太多了');
        const m = { id: newId(), kind, name: str(b.name, 60), url: str(b.url, 1000), username: str(b.username, 200), password: typeof b.password === 'string' ? b.password.slice(0, 500) : '', addedAt: Date.now() };
        if (!m.url) return fail(res, 400, kind === 'folder' ? '请选择服务器上的目录' : '请填写地址');
        if (kind === 'folder') {
          if (!ROOTS.length) return fail(res, 400, '服务器没有开放可以挂载的目录：要在启动服务器时设置环境变量 MOUNT_ROOTS');
          m.url = path.resolve(m.url);
        } else checkUrl(m.url);
        await list(m, kind === 'opds' ? '' : '/'); // 先连一次，连不上就不保存
        if (!m.name) m.name = kind === 'folder' ? path.basename(m.url) : new URL(m.url).host;
        all[m.id] = m; save();
        return json(res, 200, { mount: pub(m) });
      }
      const m = all[seg[0]];
      if (!m) return fail(res, 404, '没有这个挂载');
      if (seg.length === 1 && M === 'DELETE') { delete all[m.id]; save(); return json(res, 200, { ok: true }); }
      if (seg.length === 1 && M === 'PUT') {
        const b = await readJson(req, 16 * 1024);
        const next = { ...m, name: str(b.name, 60) || m.name, username: typeof b.username === 'string' ? str(b.username, 200) : m.username };
        if (typeof b.password === 'string' && b.password) next.password = b.password.slice(0, 500);
        await list(next, m.kind === 'opds' ? '' : '/');
        all[m.id] = next; save();
        return json(res, 200, { mount: pub(next) });
      }
      if (seg[1] === 'list' && M === 'GET') return json(res, 200, await list(m, q.get('path') || (m.kind === 'opds' ? '' : '/')));
      if (seg[1] === 'fetch' && M === 'GET') return stream(req, res, m, q.get('path') || '', q.get('name') || '');
      if (seg[1] === 'add' && M === 'POST') { // 放上书架：只记位置，文件留在原处
        if (m.kind === 'opds') return fail(res, 400, 'OPDS 里的书请用“加入书架”下载导入');
        const body = await readJson(req, 512 * 1024);
        const added = [], now = Date.now();
        for (const it of (Array.isArray(body.items) ? body.items : []).slice(0, 200)) {
          const base = {
            id: newId(), author: '', illustrator: '', publisher: '', status: '', rating: 0, review: '', description: '',
            series: str(it.series, 200), volume: volumeOf(it.volume), collections: (Array.isArray(body.collections) ? body.collections : []).filter((x) => lib.collections[x]),
            hasCover: false, addedAt: now, updatedAt: now,
          };
          const p = str(it.path, 2000);
          if (!p) continue;
          if (it.kind === 'file') {
            const ext = p.split('.').pop().toLowerCase();
            const format = ext === 'epub' ? 'epub' : (ext === 'cbz' || ext === 'zip') ? 'cbz' : '';
            if (!format) continue;
            const dup = Object.values(lib.books).find((x) => x.source?.type === 'mount' && x.source.mount === m.id && x.source.path === p);
            if (dup) { added.push({ book: dup, duplicate: true }); continue; }
            const name = p.split('/').pop();
            const book = { ...base, format, size: Number(it.size) || 0, title: str(it.title, 500) || name.replace(/\.[^.]+$/, ''), fileName: name, source: { type: 'mount', mount: m.id, kind: m.kind, path: p } };
            lib.books[book.id] = book; added.push({ book });
          } else if (it.kind === 'dir') {
            const dup = Object.values(lib.books).find((x) => x.source?.type === 'mount-dir' && x.source.mount === m.id && x.source.path === p);
            if (dup) { added.push({ book: dup, duplicate: true }); continue; }
            const pages = (await list(m, p)).items.filter((f) => !f.isDir && IMAGE_RE.test(f.name)).slice(0, 5000);
            if (!pages.length) continue;
            const book = { ...base, format: 'cbz', size: pages.reduce((n, x) => n + x.size, 0), title: str(it.title, 500) || p.split('/').pop(), fileName: p.split('/').pop(), source: { type: 'mount-dir', mount: m.id, kind: m.kind, path: p, count: pages.length } };
            lib.books[book.id] = book;
            lib.cloudPages[book.id] = pages.map((x) => ({ path: x.path, name: x.name, size: x.size }));
            added.push({ book });
          }
        }
        save();
        return json(res, 200, { added });
      }
      return fail(res, 404, '没有这个接口');
    } catch (e) {
      return fail(res, e.status && e.status < 600 ? e.status : 502, e.message || '挂载出错了');
    }
  }

  /** 书的路由：挂载里的单个文件 / 图片文件夹 */
  function bookRoute(req, res, seg, lib, book) {
    const M = req.method, src = book.source, m = mountsOf(lib)[src.mount];
    if (src.type === 'mount' && seg[2] === 'file' && (M === 'GET' || M === 'HEAD')) return stream(req, res, m, src.path, book.fileName), true;
    if (src.type === 'mount-dir' && seg[2] === 'pages' && M === 'GET') return json(res, 200, { pages: (lib.cloudPages[book.id] || []).map((p) => ({ name: p.name, size: p.size })) }), true;
    if (src.type === 'mount-dir' && seg[2] === 'page' && M === 'GET') {
      const pg = (lib.cloudPages[book.id] || [])[Number(seg[3])];
      if (!pg) return fail(res, 404, '没有这一页'), true;
      return stream(req, res, m, pg.path, pg.name, true), true;
    }
    return false;
  }

  return { api, bookRoute, ROOTS, BOOK_RE };
};
