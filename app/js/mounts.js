// 挂载：WebDAV、OPDS、服务器上的文件夹（SMB / NAS）。网盘（阿里云盘、115、123、OneDrive、Dropbox）经 AList / OpenList 转成 WebDAV。
import { h, icon, loader, toast, dialog, confirmDialog, fmtSize } from './ui.js';
import * as store from './store.js';

const BOOK_RE = /\.(epub|cbz|zip)$/i;
const IMG_RE = /\.(jpe?g|png|webp|gif|avif|bmp)$/i;
const KIND_NAME = { webdav: 'WebDAV', opds: 'OPDS', folder: '服务器文件夹' };
const KIND_ICON = { webdav: 'cloud', opds: 'books', folder: 'folder' };

/** 新建挂载时的各种入口：服务器协议 + 经 AList 的网盘 */
const PRESETS = {
  webdav: { kind: 'webdav', title: 'WebDAV', hint: '坚果云、Nextcloud、群晖 / 威联通 NAS、AList / OpenList 都支持 WebDAV。', examples: [
    ['坚果云', 'https://dav.jianguoyun.com/dav/', '用户名是坚果云账号，密码要用“第三方应用密码”（坚果云网页版 → 账户信息 → 安全选项）'],
    ['AList / OpenList', 'http://你的服务器:5244/dav', '用 AList 的账号密码'],
    ['Nextcloud', 'https://你的域名/remote.php/dav/files/用户名/', ''],
    ['群晖 NAS', 'https://NAS地址:5006/', '先在“套件中心”装 WebDAV Server'],
  ] },
  smb: { kind: 'folder', title: 'SMB / NAS 共享', hint: '浏览器和手机不能直接连 SMB。先在服务器上把共享挂成一个目录，再选这个目录：', code: 'sudo mount -t cifs //NAS地址/共享名 /mnt/nas -o username=用户名,password=密码,iocharset=utf8,uid=$(id -u)' },
  folder: { kind: 'folder', title: '服务器上的文件夹', hint: '直接读服务器硬盘上的书，不占书库空间。' },
  opds: { kind: 'opds', title: 'OPDS 书目', hint: 'Calibre、Calibre-Web、Komga、Kavita 等书库软件都能提供 OPDS。浏览后点“加入书架”会把书下载导入。', examples: [
    ['Calibre-Web', 'http://你的服务器:8083/opds', '用 Calibre-Web 的账号密码'],
    ['Calibre 内容服务器', 'http://你的服务器:8080/opds', ''],
    ['Komga', 'http://你的服务器:25600/opds/v1.2/catalog', '用 Komga 的邮箱和密码'],
  ] },
};
const NETDISKS = [['aliyun', '阿里云盘'], ['115', '115 网盘'], ['123', '123 云盘'], ['onedrive', 'OneDrive'], ['dropbox', 'Dropbox'], ['quark', '夸克网盘']];

/** 导入菜单里的“服务器”“网盘”两组 */
export function importMenuSections({ openBaidu, onChanged, importFiles }) {
  const known = cachedMounts;
  return [
    known.length ? { title: '已挂载', items: known.map((m) => ({ icon: KIND_ICON[m.kind], label: m.name, sub: KIND_NAME[m.kind], onclick: () => openMountBrowser(m, { importFiles }) })) } : null,
    { title: '服务器', items: [
      { icon: 'cloud', label: 'WebDAV', sub: '坚果云、NAS、AList', onclick: () => openMountForm('webdav', { onChanged, importFiles }) },
      { icon: 'folder', label: 'SMB / NAS', sub: '先挂到服务器上的目录', onclick: () => openMountForm('smb', { onChanged, importFiles }) },
      { icon: 'books', label: 'OPDS', sub: 'Calibre、Komga 等书库', onclick: () => openMountForm('opds', { onChanged, importFiles }) },
    ] },
    { title: '网盘', items: [
      { icon: 'cloud', label: '百度网盘', sub: '直接连接', onclick: openBaidu },
      ...NETDISKS.map(([id, name]) => ({ icon: 'cloud', label: name, sub: '经 AList / OpenList', onclick: () => openMountForm('webdav', { onChanged, importFiles, netdisk: name }) })),
    ] },
  ].filter(Boolean);
}

let cachedMounts = [];
let folderRoots = [];
export async function refreshMounts() {
  if (!store.account()) { cachedMounts = []; return cachedMounts; }
  try { const r = await store.mounts.list(); cachedMounts = r.mounts; folderRoots = r.folderRoots || []; } catch { /* 离线时用上次的 */ }
  return cachedMounts;
}

/** 新建挂载 */
export async function openMountForm(preset, { onChanged, importFiles, netdisk } = {}) {
  if (!store.account()) { toast('挂载需要登录账号：连接和读取都由你自己的服务器完成', { error: true }); return; }
  const p = PRESETS[preset];
  if (p.kind === 'folder') await refreshMounts();
  const created = await dialog(netdisk ? `挂载${netdisk}` : `添加 ${p.title}`, (close) => {
    const name = h('input.field', { type: 'text', placeholder: '名字（可不填）', 'aria-label': '名字', value: netdisk || '' });
    const url = h('input.field', { type: 'url', placeholder: p.kind === 'opds' ? 'OPDS 地址' : 'WebDAV 地址', 'aria-label': '地址', autocomplete: 'off' });
    const user = h('input.field', { type: 'text', placeholder: '用户名（没有就不填）', 'aria-label': '用户名', autocomplete: 'off' });
    const pass = h('input.field', { type: 'password', placeholder: '密码', 'aria-label': '密码', autocomplete: 'new-password' });
    const msg = h('p.form-error', { hidden: true });
    const submit = h('button.btn.is-primary', { type: 'submit' }, '连接并保存');
    let rootSel = null, sub = null;
    const fields = [];
    if (netdisk) fields.push(h('div.mount-note', icon('info', 18), h('div',
      h('p', `${netdisk}没有开放给第三方阅读器的标准接口。推荐在你的服务器上装 `, h('a', { href: 'https://github.com/OpenListTeam/OpenList', target: '_blank', rel: 'noopener' }, 'OpenList'), '（AList 的社区版），在里面添加', netdisk, '，然后把 OpenList 的 WebDAV 地址填在下面。'),
      h('p.muted', 'OpenList 默认的 WebDAV 地址是 http://服务器地址:5244/dav，用户名密码就是 OpenList 的账号。'))));
    else if (p.hint) fields.push(h('p.mount-hint', p.hint));
    if (p.code) fields.push(h('pre.mount-code', p.code), h('p.muted', '然后把 /mnt/nas 加进服务器的 MOUNT_ROOTS 环境变量，重启服务器，在下面选这个目录。'));
    if (p.kind === 'folder') {
      if (!folderRoots.length) {
        fields.push(h('div.mount-note', icon('info', 18), h('div', h('p', '服务器还没有开放可以挂载的目录。'), h('p.muted', '启动服务器时设置环境变量 MOUNT_ROOTS（多个目录用冒号分隔），例如：'), h('pre.mount-code', 'MOUNT_ROOTS=/mnt/nas:/srv/books node server.js'))));
        submit.disabled = true;
      } else {
        rootSel = h('select.field', { 'aria-label': '服务器上的目录' }, folderRoots.map((r) => h('option', { value: r }, r)));
        sub = h('input.field', { type: 'text', placeholder: '子目录（可不填），例如 漫画/连载', 'aria-label': '子目录' });
        fields.push(h('label.mount-label', '目录'), rootSel, sub, name);
      }
    } else {
      fields.push(name, url, user, pass);
      if (p.examples && !netdisk) fields.push(h('div.mount-examples', h('span.muted', '常见地址：'), p.examples.map(([t, u, tip]) => h('button.tag-chip', { type: 'button', title: tip || u, onclick: () => { url.value = u; if (!name.value) name.value = t; msg.hidden = !tip; msg.className = 'mount-tip'; msg.textContent = tip; url.focus(); if (/你的|NAS地址|用户名/.test(u)) url.setSelectionRange(u.search(/你的|NAS地址|用户名/), u.length); } }, t))));
      if (netdisk) url.value = 'http://';
    }
    setTimeout(() => (url.isConnected ? url : rootSel || name).focus(), 30);
    return h('form.dialog-body.mount-form', {
      onsubmit: async (e) => {
        e.preventDefault(); msg.hidden = true; msg.className = 'form-error';
        submit.disabled = true; submit.replaceChildren(loader('正在连接'), h('span', '正在连接…'));
        try {
          const body = p.kind === 'folder'
            ? { kind: 'folder', name: name.value.trim(), url: rootSel.value.replace(/\/+$/, '') + (sub.value.trim() ? '/' + sub.value.trim().replace(/^\/+/, '') : '') }
            : { kind: p.kind, name: name.value.trim(), url: url.value.trim(), username: user.value.trim(), password: pass.value };
          const { mount } = await store.mounts.create(body);
          close(mount);
        } catch (err) { msg.textContent = err.message; msg.hidden = false; submit.disabled = false; submit.replaceChildren('连接并保存'); }
      },
    }, ...fields, msg, h('div.dialog-actions', h('button.btn', { type: 'button', onclick: () => close() }, '取消'), submit));
  });
  if (created) {
    await refreshMounts(); onChanged?.();
    toast(`已挂载“${created.name}”`);
    openMountBrowser(created, { importFiles });
  }
}

/** 把选中的文件 / 文件夹变成要放上书架的条目（和百度网盘的规则一样） */
async function planItems(mount, selected) {
  const out = [];
  for (const it of selected) {
    if (!it.isDir) { out.push({ kind: 'file', path: it.path, size: it.size, ...(store.guessSeries(it.name.replace(/\.[^.]+$/, '')) || {}) }); continue; }
    const { items } = await store.mounts.browse(mount.id, it.path);
    if (items.some((x) => !x.isDir && IMG_RE.test(x.name))) { out.push({ kind: 'dir', path: it.path, title: it.name, ...(store.guessSeries(it.name) || {}) }); continue; }
    items.filter((x) => x.isDir || BOOK_RE.test(x.name)).forEach((x, i) => {
      const title = x.name.replace(/\.[^.]+$/, '');
      const num = store.guessSeries(title)?.volume ?? (Number((title.match(/\d+(\.\d+)?/) || [])[0]) || i + 1);
      out.push(x.isDir ? { kind: 'dir', path: x.path, title, series: it.name, volume: num } : { kind: 'file', path: x.path, size: x.size, series: it.name, volume: num });
    });
  }
  return out;
}

const kindIcon = (it) => (it.isDir ? 'folder' : /\.epub$/i.test(it.name) || it.format === 'epub' ? 'books' : 'pages');

/** 浏览一个挂载。WebDAV / 文件夹：勾选后放上书架（文件留在原处）；OPDS：一本本“加入书架”（下载导入） */
export async function openMountBrowser(mount, { importFiles, collections = [] } = {}) {
  const opds = mount.kind === 'opds';
  await dialog(mount.name, (close) => {
    const key = 'mountDir:' + mount.id;
    let cur = opds ? '' : store.prefs.get(key, '/');
    const trail = []; // OPDS 没有路径，只能记走过的地址
    const picked = new Map();
    const crumbs = h('nav.cd-crumbs', { 'aria-label': '当前位置' });
    const list = h('div.cd-list', { role: 'list' });
    const count = h('span.cd-count');
    const addBtn = h('button.btn.is-primary', { type: 'button', disabled: true, onclick: add }, '放上书架');
    const drawCount = () => { count.textContent = picked.size ? `已选 ${picked.size} 项` : '勾选 EPUB、CBZ / ZIP，或者整个漫画文件夹'; addBtn.disabled = !picked.size; };

    const drawCrumbs = () => {
      if (opds) {
        crumbs.replaceChildren(h('button', { type: 'button', onclick: () => { trail.length = 0; go(''); } }, mount.name),
          ...trail.flatMap((t, i) => [h('span', '/'), h('button', { type: 'button', onclick: () => { trail.length = i + 1; go(t.href, true); } }, t.title)]));
        return;
      }
      const parts = cur.split('/').filter(Boolean);
      crumbs.replaceChildren(h('button', { type: 'button', onclick: () => go('/') }, mount.name),
        ...parts.flatMap((p, i) => [h('span', '/'), h('button', { type: 'button', onclick: () => go('/' + parts.slice(0, i + 1).join('/')) }, p)]));
    };
    async function go(path, keepTrail = false, title = '') {
      if (opds && !keepTrail && path) trail.push({ href: path, title: title || '…' });
      cur = path; if (!opds) store.prefs.set(key, path);
      drawCrumbs();
      list.replaceChildren(h('div.cd-loading', loader('正在读取')));
      let data;
      try { data = await store.mounts.browse(mount.id, path); }
      catch (e) {
        if (!opds && path !== '/') { store.prefs.set(key, '/'); return go('/'); }
        list.replaceChildren(h('p.cd-empty.form-error', e.message)); return;
      }
      if (cur !== path) return;
      render(data, false);
    }
    function render(data, append) {
      const rows = opds ? data.items.map(opdsRow) : fileRows(data.items);
      if (!append) list.replaceChildren(...(rows.length ? rows : [h('p.cd-empty', opds ? '这里是空的。' : '这里没有可以添加的书（支持 EPUB、CBZ / ZIP 和装着图片的文件夹）。')]));
      else list.querySelector('.cd-more')?.replaceWith(...rows);
      if (opds && data.next) {
        const more = h('button.btn.is-soft.cd-more', { type: 'button', onclick: async () => {
          more.disabled = true; more.replaceChildren(loader('正在加载'));
          try { render(await store.mounts.browse(mount.id, data.next), true); } catch (e) { toast(e.message, { error: true }); more.disabled = false; more.textContent = '加载更多'; }
        } }, '加载更多');
        list.append(more);
      }
    }
    function fileRows(items) {
      const usable = items.filter((it) => it.isDir || BOOK_RE.test(it.name));
      const images = items.filter((it) => !it.isDir && IMG_RE.test(it.name)).length;
      return [
        images > 0 ? h('div.cd-hint', icon('pages', 18), `这个文件夹里有 ${images} 张图片。勾选上一级里的这个文件夹，就能把它当成一本漫画放上书架。`) : '',
        ...usable.map((it) => {
          const box = h('input', { type: 'checkbox', checked: picked.has(it.path), 'aria-label': `选择 ${it.name}`, onchange: () => { if (box.checked) picked.set(it.path, it); else picked.delete(it.path); drawCount(); } });
          return h('div.cd-row' + (it.isDir ? '.is-dir' : ''), { role: 'listitem' }, box,
            h('button.cd-name', { type: 'button', onclick: () => (it.isDir ? go(it.path) : (box.checked = !box.checked, box.dispatchEvent(new Event('change')))) },
              h('span.cd-icon', icon(kindIcon(it), 20)), h('span.cd-label', it.name), h('small', it.isDir ? '' : fmtSize(it.size)), it.isDir && icon('chevronRight', 16)));
        })].filter(Boolean);
    }
    function opdsRow(it) {
      if (it.isDir) return h('div.cd-row.is-dir', { role: 'listitem' }, h('button.cd-name', { type: 'button', onclick: () => go(it.path, false, it.name) },
        h('span.cd-icon', icon('folder', 20)), h('span.cd-label', it.name, it.summary ? h('small.cd-sum', it.summary) : ''), icon('chevronRight', 16)));
      const btn = h('button.btn.is-soft.is-small', { type: 'button', onclick: async () => {
        btn.disabled = true; btn.replaceChildren(loader('正在下载'));
        try {
          const file = await store.mounts.fetchFile(mount.id, it.path, it.fileName);
          const ids = await importFiles([file], it.author ? { author: it.author } : null);
          btn.replaceChildren(icon('check', 16), ids?.length ? '已加入' : '已在书架上'); btn.classList.add('is-done');
        } catch (e) { toast(e.message, { error: true }); btn.disabled = false; btn.replaceChildren(icon('plus', 16), '加入书架'); }
      } }, icon('plus', 16), '加入书架');
      return h('div.cd-row.is-book', { role: 'listitem' },
        coverOf(it),
        h('span.cd-label', h('b', it.title), h('small.cd-sum', [it.author, it.format?.toUpperCase()].filter(Boolean).join(' · '))), btn);
    }
    function coverOf(it) {
      const el = h('span.cd-cover', icon(kindIcon(it), 20));
      if (it.cover) store.mounts.coverUrl(mount.id, it.cover).then((u) => el.replaceChildren(h('img', { src: u, alt: '', onload: () => setTimeout(() => URL.revokeObjectURL(u), 1000) }))).catch(() => {});
      return el;
    }
    async function add() {
      addBtn.disabled = true; addBtn.textContent = '正在整理…';
      try {
        const items = await planItems(mount, [...picked.values()]);
        if (!items.length) { toast('选中的内容里没有能看的书', { error: true }); addBtn.textContent = '放上书架'; drawCount(); return; }
        close(true);
        const t = toast('', { sticky: true });
        t.update(`正在添加 ${items.length} 项…`);
        const added = await store.addFromMount(mount.id, items, collections, (i, n, b) => t.update(`正在读取封面 ${i} / ${n}：${store.seriesLabel(b)}`));
        const dup = added.filter((a) => a.duplicate).length;
        t.done(`已添加 ${added.length - dup} 本${dup ? `，${dup} 本已在书架上` : ''}`);
      } catch (e) { toast(e.message, { error: true }); addBtn.textContent = '放上书架'; drawCount(); }
    }
    drawCount(); go(cur);
    return h('div.dialog-body.cloud-browser', crumbs, list,
      h('p.field-hint', opds ? '点“加入书架”会把这本书下载下来，像本机文件一样导入。' : '文件不会复制到你的服务器，看书时按需读取。'),
      opds ? h('div.dialog-actions', h('button.btn', { type: 'button', onclick: () => close() }, '完成'))
        : h('div.dialog-actions', count, h('button.btn', { type: 'button', onclick: () => close() }, '取消'), addBtn));
  }, { wide: true });
}

/** 设置 → 网盘 里的“挂载”卡片：看已有的挂载，改密码、删除 */
export function mountsCard({ importFiles, rerender }) {
  const card = h('section.set-card', h('h2', '挂载'), h('p.set-sub', 'WebDAV、OPDS 和服务器上的文件夹。账号密码只保存在你的服务器上。'));
  const body = h('div.mount-list', h('p.muted', '正在读取…'));
  card.append(body);
  if (!store.account()) { body.replaceChildren(h('p.muted', '挂载需要登录账号后使用。')); return card; }
  refreshMounts().then((ms) => {
    const books = Object.values(store.state.books);
    body.replaceChildren(...(ms.length ? ms.map((m) => {
      const n = books.filter((b) => b.source?.mount === m.id).length;
      return h('div.mount-row',
        h('span.cloud-logo', icon(KIND_ICON[m.kind], 20)),
        h('div.mount-info', h('b', m.name), h('small', `${KIND_NAME[m.kind]} · ${m.url}${m.username ? ' · ' + m.username : ''}${n ? ` · 书架上 ${n} 本` : ''}`)),
        h('button.btn.is-small', { type: 'button', onclick: () => openMountBrowser(m, { importFiles }) }, '浏览'),
        m.kind !== 'folder' && h('button.btn.is-small', { type: 'button', onclick: () => editPassword(m) }, '改密码'),
        h('button.btn.is-small.is-danger-text', { type: 'button', onclick: async () => {
          if (!await confirmDialog(`删除挂载“${m.name}”`, n ? `书架上有 ${n} 本书来自这里，删除后它们会打不开（书架上的记录和进度还在，重新添加同一个地址不能自动恢复）。` : '只删除挂载，不会动原来的文件。', { ok: '删除', danger: true })) return;
          try { await store.mounts.remove(m.id); toast('已删除'); rerender(); } catch (e) { toast(e.message, { error: true }); }
        } }, '删除'));
    }) : [h('p.muted', '还没有挂载。点书架右上角的“导入”，选 WebDAV、SMB / NAS 或 OPDS。')]));
  });
  async function editPassword(m) {
    await dialog(`修改“${m.name}”的账号`, (close) => {
      const user = h('input.field', { type: 'text', value: m.username, placeholder: '用户名', 'aria-label': '用户名' });
      const pass = h('input.field', { type: 'password', placeholder: '新密码', 'aria-label': '新密码', autocomplete: 'new-password' });
      const msg = h('p.form-error', { hidden: true });
      return h('form.dialog-body', { onsubmit: async (e) => {
        e.preventDefault();
        try { await store.mounts.update(m.id, { username: user.value.trim(), password: pass.value }); close(true); toast('已保存'); rerender(); }
        catch (err) { msg.textContent = err.message; msg.hidden = false; }
      } }, user, pass, msg, h('div.dialog-actions', h('button.btn', { type: 'button', onclick: () => close() }, '取消'), h('button.btn.is-primary', { type: 'submit' }, '保存')));
    });
  }
  return card;
}
