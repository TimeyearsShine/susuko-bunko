// 数据层：服务器 API、本地缓存（IndexedDB）、进度同步。
import { frontRect, cropBlob, probeLayout } from './pagefit.js';
import { ZipReader, mimeOf, isImageName } from './zip.js';
import { Epub } from './epub.js';

// ---------- 本机设置 ----------
const LS = 'shiori.';
// 跟着账号走的设置：登录后在每台设备上都一样（设备名、缓存之类的本机设置不在其中）
export const SYNCED_PREFS = ['ai', 'tts', 'reader', 'comic', 'comicBooks', 'meta', 'accent', 'theme', 'layout', 'stack', 'pill', 'sort'];
let onSyncedPrefChange = null;
export const prefs = {
  get(key, fallback) {
    try { const v = localStorage.getItem(LS + key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value, { quiet = false } = {}) {
    try { localStorage.setItem(LS + key, JSON.stringify(value)); } catch { /* 存不下就算了 */ }
    if (!quiet && SYNCED_PREFS.includes(key)) onSyncedPrefChange?.();
  },
  remove(key) { try { localStorage.removeItem(LS + key); } catch { /* 忽略 */ } },
};

export const isNativeShell = location.protocol === 'tauri:' || location.hostname === 'tauri.localhost';

function defaultDeviceName() {
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return '安卓设备';
  if (/Windows/i.test(ua)) return 'Windows 电脑';
  if (/Mac/i.test(ua)) return 'Mac';
  return '浏览器';
}
export const deviceName = () => prefs.get('device', '') || defaultDeviceName();

// ---------- IndexedDB ----------
let dbPromise = null;
function idb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open('shiori', 1);
      req.onupgradeneeded = () => {
        for (const name of ['files', 'covers', 'kv']) req.result.createObjectStore(name);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}
async function tx(store, mode, fn) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req && req.result);
    t.onerror = t.onabort = () => reject(t.error || new Error('本地存储失败'));
  });
}
const local = {
  get: (store, key) => tx(store, 'readonly', (s) => s.get(key)),
  put: (store, key, value) => tx(store, 'readwrite', (s) => s.put(value, key)),
  del: (store, key) => tx(store, 'readwrite', (s) => s.delete(key)),
  keys: (store) => tx(store, 'readonly', (s) => s.getAllKeys()),
  clear: (store) => tx(store, 'readwrite', (s) => s.clear()),
};

// ---------- 状态 ----------
export const state = {
  books: {}, collections: {}, progress: {},
  marks: {}, // 书签、页笔记、划线批注：bookId -> { markId: mark }
  stats: {}, // 阅读时长：'YYYY-MM-DD' -> { bookId: 秒 }
  hours: {}, // 一天里几点在读：'YYYY-MM-DD' -> { 小时: 秒 }
  series: {}, // 系列简介：系列名 -> { description }
  downloaded: new Set(), // 已缓存到本机的书
  online: false, syncing: false, lastSync: 0,
};
let pending = {}; // 还没推到服务器的进度
let pendingMarks = []; // 还没推到服务器的记号操作 { op: 'put' | 'del', bookId, id, mark }
let pendingStats = []; // 还没上报的阅读时长 { day, book, seconds }
const listeners = new Set();
export const onChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
let emitQueued = false;
function emit() {
  if (emitQueued) return;
  emitQueued = true;
  queueMicrotask(() => { emitQueued = false; for (const fn of listeners) fn(); });
}

// ---------- 账号 ----------
// 两种用法：只在本机用（书和记录都存在这台设备上），或登录自己服务器上的账号（多端同步）。
// 两者的书库分开保存：退出登录后回到本机书库。
export const account = () => prefs.get('account', null); // { url, token, user }
export const isConfigured = () => !!account();
export const hasStarted = () => isConfigured() || prefs.get('localMode', false);
const libKey = () => (account() ? 'state:' + account().user.id : 'state:local');
const queueKey = () => (account() ? 'queues:' + account().user.id : 'queues:local');

export function profile() {
  const acct = account();
  if (acct) return { nickname: acct.user.nickname || acct.user.username, username: acct.user.username, server: acct.url, avatarAt: acct.user.avatarAt || 0 };
  return { nickname: prefs.get('nickname', '') || '本机读者', username: '', server: '', avatarAt: prefs.get('avatarAt', 0) };
}

const persist = () => local.put('kv', libKey(), {
  books: state.books, collections: state.collections, progress: state.progress, marks: state.marks, stats: state.stats,
  hours: state.hours, series: state.series,
}).catch(() => {});
const persistPending = () => (account() ? local.put('kv', queueKey(), { progress: pending, marks: pendingMarks, stats: pendingStats }).catch(() => {}) : Promise.resolve());
const persistQueues = persistPending;

// ---------- API ----------
export class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}
async function api(path, opts = {}, conf = account()) {
  if (!conf) throw new ApiError('还没有登录服务器', 0);
  let res;
  try {
    res = await fetch(conf.url + path, {
      ...opts, headers: { ...(conf.token ? { Authorization: 'Bearer ' + conf.token } : {}), ...(opts.headers || {}) },
    });
  } catch {
    throw new ApiError('连不上服务器，请检查网络或服务器地址', 0);
  }
  if (!res.ok) {
    let message = `服务器返回 ${res.status}`;
    try { message = (await res.json()).error || message; } catch { /* 非 JSON */ }
    if (res.status === 401 && conf === account()) { state.online = false; state.authLost = true; emit(); }
    throw new ApiError(message, res.status);
  }
  return res;
}
export { api as rawApi };
import * as direct from './cloud-direct.js';
const apiJson = async (path, method, body, conf) => (await api(path, {
  method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
}, conf)).json();

function normalizeUrl(url) {
  url = url.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  return url;
}
async function checkServer(url) {
  const res = await (await api('/api/ping', {}, { url })).json();
  if (res.name !== 'susuko-bunko') throw new ApiError('这个地址不是スス子文庫的同步服务', 0);
  if (!res.accounts) throw new ApiError('服务器版本太旧，请先把服务端更新到 0.5 或以上', 0);
  return res;
}

/** 登录或注册。mode: 'login' | 'register' */
export async function signIn(mode, { url, username, password, invite, nickname }) {
  url = normalizeUrl(url);
  await checkServer(url);
  const body = mode === 'register' ? { username, password, invite, nickname, device: deviceName() } : { username, password, device: deviceName() };
  const { token, user } = await apiJson('/api/auth/' + mode, 'POST', body, { url });
  await switchLibrary(() => prefs.set('account', { url, token, user }));
  await sync().catch(() => {});
}

export async function signOut() {
  const acct = account();
  if (!acct) return;
  await flushNow();
  api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  // 这个账号下载过的书从本机清掉，本机书库的书保留
  const localLib = await local.get('kv', 'state:local').catch(() => null);
  const keep = new Set(Object.keys(localLib?.books || {}));
  for (const id of Object.keys(state.books)) if (!keep.has(id)) { local.del('files', id).catch(() => {}); local.del('covers', id).catch(() => {}); }
  local.del('kv', 'state:' + acct.user.id).catch(() => {});
  local.del('kv', 'queues:' + acct.user.id).catch(() => {});
  await switchLibrary(() => { prefs.remove('account'); prefs.set('localMode', true); });
}

/** 切换书库（本机 ↔ 账号）：保存当前的，载入另一个 */
async function switchLibrary(change) {
  await persist();
  change();
  for (const u of coverUrls.values()) Promise.resolve(u).then((x) => x && URL.revokeObjectURL(x)).catch(() => {});
  coverUrls.clear();
  remotes.clear();
  Object.assign(state, { books: {}, collections: {}, progress: {}, marks: {}, stats: {}, hours: {}, series: {}, online: false, authLost: false });
  pending = {}; pendingMarks = []; pendingStats = [];
  await init();
}

export function useLocally() { prefs.set('localMode', true); emit(); }

export async function init() {
  try {
    const [cached, queues, keys] = await Promise.all([local.get('kv', libKey()), local.get('kv', queueKey()), local.keys('files')]);
    if (cached) Object.assign(state, { books: {}, collections: {}, progress: {}, marks: {}, stats: {}, hours: {}, series: {}, ...cached });
    if (account()) {
      pending = queues?.progress || {}; pendingMarks = queues?.marks || []; pendingStats = queues?.stats || [];
      for (const [id, p] of Object.entries(pending)) state.progress[id] = p;
    }
    state.downloaded = new Set(keys);
    // 0.4 及以前的缓存（单账号、用密钥连接）：数据都在服务器上，直接丢掉，登录后重新同步
    if (prefs.get('server', null)) { prefs.remove('server'); local.del('kv', 'state').catch(() => {}); local.del('kv', 'pending').catch(() => {}); local.del('kv', 'queues').catch(() => {}); }
  } catch { /* 本地存储不可用时只能在线使用 */ }
  emit();
}

// ---------- 个人资料 ----------
const avatarUrls = new Map();
export async function avatarUrl() {
  const acct = account();
  const key = acct ? `avatar:${acct.user.id}` : 'avatar:local';
  const at = profile().avatarAt;
  if (!at) return null;
  const cacheKey = `${key}:${at}`;
  if (avatarUrls.has(cacheKey)) return avatarUrls.get(cacheKey);
  const job = (async () => {
    let cached = await local.get('kv', key).catch(() => null);
    if ((!cached || cached.at !== at) && acct) {
      cached = { at, blob: await (await api('/api/me/avatar')).blob() };
      local.put('kv', key, cached).catch(() => {});
    }
    return cached ? URL.createObjectURL(cached.blob) : null;
  })();
  avatarUrls.set(cacheKey, job);
  job.catch(() => avatarUrls.delete(cacheKey));
  return job;
}
async function squareJpeg(blob, size) {
  const bmp = await createImageBitmap(blob);
  const side = Math.min(bmp.width, bmp.height);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  canvas.getContext('2d').drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, size, size);
  bmp.close?.();
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.88));
}
export async function setAvatar(file) {
  const jpg = await squareJpeg(file, 256);
  const acct = account();
  if (acct) {
    const { user } = await (await api('/api/me/avatar', { method: 'PUT', body: jpg })).json();
    await local.put('kv', `avatar:${user.id}`, { at: user.avatarAt, blob: jpg });
    prefs.set('account', { ...acct, user });
  } else {
    const at = Date.now();
    await local.put('kv', 'avatar:local', { at, blob: jpg });
    prefs.set('avatarAt', at);
  }
  emit();
}
export async function setNickname(name) {
  name = name.trim().slice(0, 40);
  if (!name) return;
  const acct = account();
  if (acct) {
    const { user } = await apiJson('/api/me', 'PATCH', { nickname: name });
    prefs.set('account', { ...acct, user });
  } else prefs.set('nickname', name);
  emit();
}
export async function changePassword(oldPassword, newPassword) {
  await apiJson('/api/me', 'PATCH', { oldPassword, newPassword });
}

// ---------- 同步 ----------
let syncRunning = null;
export function sync() {
  if (!isConfigured()) return Promise.resolve();
  if (!syncRunning) syncRunning = doSync().finally(() => { syncRunning = null; });
  return syncRunning;
}
async function doSync() {
  state.syncing = true; emit();
  try {
    await flushProgress();
    await flushQueues();
    const remote = await (await api('/api/state')).json();
    if (remote.user) prefs.set('account', { ...account(), user: remote.user });
    const before = Object.keys(state.books);
    state.books = remote.books; state.collections = remote.collections;
    state.marks = remote.marks || {}; state.stats = remote.stats || {};
    state.hours = remote.hours || {}; state.series = remote.series || {};
    for (const op of pendingMarks) applyMark(op); // 还没推上去的本地改动继续保留
    for (const it of pendingStats) bumpStat(it);
    await syncSettings(remote.settings);
    const progress = remote.progress;
    for (const [id, p] of Object.entries(pending)) { // 本地更新的进度不被旧数据覆盖
      if (!progress[id] || p.updatedAt > progress[id].updatedAt) progress[id] = p;
    }
    state.progress = progress;
    state.online = true; state.lastSync = Date.now();
    await persist();
    // 这个账号在别的设备上删掉的书，清掉本机缓存（只清这个账号的，本机书库的书不动）
    for (const id of before) {
      if (!state.books[id] && state.downloaded.has(id)) { state.downloaded.delete(id); local.del('files', id).catch(() => {}); local.del('covers', id).catch(() => {}); }
    }
  } catch (e) {
    state.online = false;
    throw e;
  } finally {
    state.syncing = false; emit();
  }
}

async function flushProgress() {
  if (!account()) return;
  for (const [id, p] of Object.entries(pending)) {
    try {
      const res = await apiJson('/api/progress/' + id, 'PUT', p);
      if (pending[id] === p) delete pending[id];
      if (res.progress.updatedAt > p.updatedAt) state.progress[id] = res.progress;
    } catch (e) {
      if (e.status === 404) { delete pending[id]; continue; }
      throw e;
    }
  }
  await persistPending();
}

// ---------- 书签与笔记 ----------
function applyMark(op) {
  const list = state.marks[op.bookId] || (state.marks[op.bookId] = {});
  if (op.op === 'del') delete list[op.id]; else list[op.id] = op.mark;
}
function bumpStat({ day, book, seconds, hour }) {
  const d = state.stats[day] || (state.stats[day] = {});
  d[book] = (d[book] || 0) + seconds;
  if (hour != null) { const hrs = state.hours[day] || (state.hours[day] = {}); hrs[hour] = (hrs[hour] || 0) + seconds; }
}

// ---------- 账号设置同步 ----------
// 本机改了要同步的设置就记一个时间，同步时和服务器上的比，较新的一方覆盖较旧的一方
const settingsStamp = () => prefs.get('settingsAt:' + (account()?.user.id || 'local'), 0);
function collectSettings() {
  const data = {};
  for (const k of SYNCED_PREFS) { const v = prefs.get(k, undefined); if (v !== undefined) data[k] = v; }
  return data;
}
let settingsTimer = null;
onSyncedPrefChange = () => {
  if (!account()) return;
  prefs.set('settingsAt:' + account().user.id, Date.now());
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(() => pushSettings().catch(() => {}), 1500);
};
async function pushSettings(initial = false) {
  if (!account()) return;
  const data = collectSettings();
  if (initial) data.__initial = true;
  await apiJson('/api/me/settings', 'PUT', { data, updatedAt: initial ? 1 : settingsStamp() || Date.now() });
}
async function syncSettings(remote) {
  if (!account()) return;
  const mine = settingsStamp();
  if (remote && remote.data.__initial && !mine) {
    // 两台设备都是第一次同步：合并（这台设备上有的设置优先），免得把另一台还没设置过的空白值盖过来
    const local = collectSettings();
    for (const k of SYNCED_PREFS) if (!(k in local) && k in remote.data) prefs.set(k, remote.data[k], { quiet: true });
    prefs.set('settingsAt:' + account().user.id, Date.now());
    window.dispatchEvent(new CustomEvent('settings-synced'));
    await pushSettings().catch(() => {});
  } else if (remote && remote.updatedAt > mine) {
    for (const k of SYNCED_PREFS) {
      if (k in remote.data) prefs.set(k, remote.data[k], { quiet: true }); else prefs.remove(k);
    }
    prefs.set('settingsAt:' + account().user.id, remote.updatedAt);
    window.dispatchEvent(new CustomEvent('settings-synced'));
  } else if (mine && (!remote || mine > remote.updatedAt)) await pushSettings().catch(() => {});
  else if (!remote) await pushSettings(true).catch(() => {}); // 新账号：把这台设备的设置作为初始值
}

// ---------- 系列简介 ----------
export async function setSeriesDescription(name, description) {
  description = description.trim().slice(0, 8000);
  if (account()) await apiJson('/api/series', 'PUT', { name, description });
  if (description) state.series[name] = { description, updatedAt: Date.now() }; else delete state.series[name];
  persist(); emit();
}
async function flushQueues() {
  if (!account()) return;
  while (pendingMarks.length) {
    const op = pendingMarks[0];
    try {
      if (op.op === 'del') await apiJson(`/api/marks/${op.bookId}/${op.id}`, 'DELETE');
      else await apiJson(`/api/marks/${op.bookId}/${op.id}`, 'PUT', op.mark);
    } catch (e) { if (!(e.status >= 400 && e.status < 500)) throw e; } // 书已删等情况：丢弃这条
    pendingMarks.shift();
  }
  if (pendingStats.length) {
    const batch = pendingStats.slice();
    await apiJson('/api/stats', 'POST', { add: batch });
    pendingStats = pendingStats.slice(batch.length);
  }
  persistQueues();
}
let queueTimer = null;
function flushQueuesSoon(ms = 1500) {
  clearTimeout(queueTimer);
  queueTimer = setTimeout(() => flushQueues().catch(() => {}), ms);
}
const newMarkId = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');

/** 新建或修改一条记号。mark: { id?, type: 'bookmark' | 'note' | 'highlight', loc, percent, chapter, excerpt, text, color } */
export function saveMark(bookId, mark) {
  const full = { createdAt: Date.now(), text: '', excerpt: '', chapter: '', ...mark, id: mark.id || newMarkId(), updatedAt: Date.now() };
  const op = { op: 'put', bookId, id: full.id, mark: full };
  applyMark(op);
  if (account()) { pendingMarks.push(op); persistQueues(); flushQueuesSoon(); }
  persist(); emit();
  return full;
}
export function removeMark(bookId, id) {
  const op = { op: 'del', bookId, id };
  applyMark(op);
  if (account()) { pendingMarks.push(op); persistQueues(); flushQueuesSoon(); }
  persist(); emit();
}
export const marksOf = (bookId) => Object.values(state.marks[bookId] || {}).sort((a, b) => a.percent - b.percent || a.createdAt - b.createdAt);

// ---------- 阅读时长 ----------
// 只在“书开着、窗口可见、三分钟内有翻页或操作”时计时，每 5 秒记一笔。
let reading = null, lastActivity = 0;
export const touchActivity = () => { lastActivity = Date.now(); };
export function dayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function commitReading() {
  if (!reading || reading.acc < 1) return;
  const it = { day: dayKey(), book: reading.bookId, seconds: Math.round(reading.acc), hour: new Date().getHours() };
  reading.acc = 0;
  bumpStat(it);
  if (account()) { pendingStats.push(it); persistQueues(); }
  persist();
}
export function startReading(bookId) {
  stopReading();
  touchActivity();
  reading = { bookId, acc: 0, ticks: 0 };
  reading.timer = setInterval(() => {
    if (!document.hidden && Date.now() - lastActivity < 180000) reading.acc += 5;
    if (++reading.ticks % 6 === 0) { commitReading(); flushQueuesSoon(100); }
  }, 5000);
}
export function stopReading() {
  if (!reading) return;
  clearInterval(reading.timer);
  commitReading();
  reading = null;
  flushQueuesSoon(100); emit();
}
for (const type of ['pointerdown', 'keydown', 'wheel']) window.addEventListener(type, touchActivity, { passive: true, capture: true });
/** 某本书累计读了多少秒 */
export function secondsOf(bookId) {
  let n = 0;
  for (const day of Object.values(state.stats)) n += day[bookId] || 0;
  return n;
}

let flushTimer = null;
export function setProgress(bookId, loc, percent) {
  touchActivity();
  const p = { loc, percent, updatedAt: Date.now(), device: deviceName() };
  state.progress[bookId] = p;
  persist();
  if (!account()) return;
  pending[bookId] = p;
  persistPending();
  clearTimeout(flushTimer);
  flushTimer = setTimeout(() => flushProgress().then(() => { state.online = true; }, () => { state.online = false; }), 2500);
}
export function flushNow() {
  clearTimeout(flushTimer);
  if (!Object.keys(pending).length) return Promise.resolve();
  return flushProgress().catch(() => {});
}
document.addEventListener('visibilitychange', () => { if (document.hidden) { commitReading(); flushNow(); flushQueuesSoon(0); } });

/** 打开书之前拉一次这本书在别的设备上的最新进度 */
export async function freshProgress(bookId) {
  try { await sync(); } catch { /* 离线就用本地的 */ }
  return state.progress[bookId] || null;
}

// ---------- 封面 ----------
const coverUrls = new Map();
export async function coverUrl(book) {
  if (!book.hasCover) return null;
  const key = `${book.id}:${book.coverAt || 0}`;
  if (coverUrls.has(key)) return coverUrls.get(key);
  const job = (async () => {
    let cached = await local.get('covers', book.id).catch(() => null);
    if ((!cached || cached.at !== (book.coverAt || 0)) && account()) {
      const blob = await (await api(`/api/books/${book.id}/cover`)).blob();
      cached = { at: book.coverAt || 0, blob };
      local.put('covers', book.id, cached).catch(() => {});
    }
    return cached ? URL.createObjectURL(cached.blob) : null;
  })();
  coverUrls.set(key, job);
  job.catch(() => coverUrls.delete(key));
  return job;
}

// 漫画第一页是整张书衣（比正面宽很多）时只留正面
const comicRtl = () => prefs.get('comic', {}).rtl !== false;
async function frontOnly(blob) {
  const bmp = await createImageBitmap(blob);
  const wide = bmp.width / bmp.height > 1.2;
  bmp.close?.();
  return wide ? cropBlob(blob, (b) => frontRect(b, comicRtl())) : blob;
}
async function shrinkCover(blob, { wrap = false } = {}) {
  if (wrap) blob = await frontOnly(blob).catch(() => blob);
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(1, 600 / bmp.width);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale); canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close?.();
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
}

// ---------- 书籍文件 ----------
// 没下载的书不用等整本下完：按 512KB 的小块向服务器要正在读的那部分（HTTP Range），
// 空闲时再在后台把剩下的块补齐，补齐后存进本机，之后离线也能读。
const CHUNK = 512 * 1024;
class RemoteSource {
  constructor(book) {
    this.book = book; this.size = book.size;
    this.count = Math.ceil(book.size / CHUNK);
    this.chunks = new Map(); this.inflight = new Map();
    this.demand = 0; this.filling = false; this.saved = false;
    this.watchers = new Set();
  }
  get progress() { return this.chunks.size / this.count; }

  async _fetchRun(first, last) {
    const from = first * CHUNK, to = Math.min((last + 1) * CHUNK, this.size) - 1;
    // 网盘里的书：安卓 / Windows 客户端先试设备直连，不行再经服务器转发
    let buf = this.book.source?.type === 'baidu' ? await direct.directRead(this.book, 'file', from, to, [], this.size) : null;
    let base = first;
    if (!buf) {
      const res = await api(`/api/books/${this.book.id}/file`, { headers: { Range: `bytes=${from}-${to}` } });
      buf = new Uint8Array(await res.arrayBuffer());
      base = res.status === 206 ? first : 0; // 服务器若不支持分段，会直接给整本
      if (this.book.source) direct.setRoute(this.book.id, 'proxy');
    }
    for (let off = 0, i = base; off < buf.length; off += CHUNK, i++) this.chunks.set(i, buf.subarray(off, off + CHUNK));
    for (const fn of this.watchers) fn(this.progress);
    if (this.chunks.size >= this.count) this._save();
  }
  _ensure(first, last) {
    const jobs = [];
    let run = null;
    const flush = () => {
      if (!run) return;
      const [a, z] = run; run = null;
      const job = this._fetchRun(a, z).finally(() => { for (let i = a; i <= z; i++) this.inflight.delete(i); });
      for (let i = a; i <= z; i++) this.inflight.set(i, job);
    };
    for (let i = first; i <= last; i++) {
      if (this.chunks.has(i) || this.inflight.has(i)) { flush(); continue; }
      if (run) run[1] = i; else run = [i, i];
    }
    flush();
    for (let i = first; i <= last; i++) if (this.inflight.has(i)) jobs.push(this.inflight.get(i));
    return Promise.all(jobs);
  }
  async read(start, end) {
    start = Math.max(0, start); end = Math.min(this.size, end);
    if (end <= start) return new ArrayBuffer(0);
    const first = Math.floor(start / CHUNK), last = Math.floor((end - 1) / CHUNK);
    this.demand++;
    try { await this._ensure(first, last); } finally { this.demand--; }
    const out = new Uint8Array(end - start);
    for (let i = first; i <= last; i++) {
      const chunk = this.chunks.get(i);
      if (!chunk) throw new ApiError('这部分内容没有加载出来，请检查网络', 0);
      const cs = i * CHUNK, a = Math.max(start, cs), z = Math.min(end, cs + chunk.length);
      out.set(chunk.subarray(a - cs, z - cs), a - start);
    }
    return out.buffer;
  }
  /** 后台补齐整本。正在读的内容优先，补齐让路。 */
  async fill() {
    if (this.filling || this.saved) return;
    this.filling = true;
    let failures = 0;
    try {
      while (this.filling && this.chunks.size < this.count) {
        if (this.demand > 0) { await sleep(200); continue; }
        let next = 0;
        while (this.chunks.has(next) || this.inflight.has(next)) next++;
        if (next >= this.count) { await sleep(200); continue; }
        try { await this._ensure(next, next); failures = 0; }
        catch (e) { if (++failures >= 5) throw e; await sleep(3000); }
      }
    } finally { this.filling = false; }
  }
  pause() { this.filling = false; }
  _save() {
    if (!this.saving) {
      this.saved = true;
      this.saving = (async () => {
        const blob = new Blob(Array.from({ length: this.count }, (_, i) => this.chunks.get(i)));
        try { await local.put('files', this.book.id, blob); state.downloaded.add(this.book.id); emit(); }
        catch { /* 空间不够时仍可在线阅读 */ }
      })();
    }
    return this.saving;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const remotes = new Map(); // 最近打开的在线书，保留已加载的块
function remoteOf(book) {
  let src = remotes.get(book.id);
  if (!src) {
    src = new RemoteSource(book);
    remotes.set(book.id, src);
    for (const [id, old] of remotes) { // 只留最近两本，其余释放内存
      if (remotes.size <= 2) break;
      if (id !== book.id && !old.filling) remotes.delete(id);
    }
  }
  return src;
}

/** 图片文件夹（百度网盘或挂载）：一页一张图 */
export const isPageDir = (book) => book?.source?.type === 'baidu-dir' || book?.source?.type === 'mount-dir';
/** 网盘里的图片文件夹：一页一张图，按页向服务器要 */
class PageListSource {
  constructor(book) { this.book = book; this.isPageList = true; this.entries = []; }
  async load() {
    const { pages } = await apiJson(`/api/books/${this.book.id}/pages`);
    this.entries = pages.map((p, i) => ({ name: p.name, size: p.size, index: i, isDir: false }));
    return this;
  }
  async blobOf(entry) {
    if (entry.size > 0) {
      const ahead = this.entries.slice(entry.index + 1, entry.index + 9).map((e) => String(e.index));
      const bytes = await direct.directRead(this.book, String(entry.index), 0, entry.size - 1, ahead, entry.size);
      if (bytes) return new Blob([bytes]);
    }
    const res = await api(`/api/books/${this.book.id}/page/${entry.index}`);
    direct.setRoute(this.book.id, 'proxy');
    return res.blob();
  }
}

/** 打开一本书用的数据源：本机有就用本机的，否则边读边从服务器取（网盘里的书由服务器去网盘取） */
export async function bookSource(book) {
  const cached = await local.get('files', book.id).catch(() => null);
  if (cached) { if (book.source) direct.setRoute(book.id, 'local'); return { source: cached, release() {} }; }
  if (!account()) throw new Error('这本书的文件不在这台设备上');
  if (isPageDir(book)) return { source: await new PageListSource(book).load(), release() {} };
  const src = remoteOf(book);
  // 网盘里的漫画往往很大，默认只取正在看的那几页，不在后台把整本拉下来
  if (prefs.get('autoCache', true) && !book.source) src.fill().catch(() => {});
  return { source: src, release() { src.pause(); } };
}

/** 把整本书下载到本机（离线阅读用） */
export async function downloadBook(book, onProgress) {
  if (state.downloaded.has(book.id)) return;
  if (isPageDir(book)) throw new ApiError('网盘 / 挂载里的图片文件夹只能在线看，不能下载到本机', 0);
  const src = remoteOf(book);
  const watch = (p) => onProgress?.(p);
  src.watchers.add(watch);
  try {
    while (src.chunks.size < src.count) {
      if (src.filling) await sleep(300); else await src.fill();
    }
    await src._save();
    if (!state.downloaded.has(book.id)) throw new ApiError('本机空间不够，没能保存', 0);
  } finally { src.watchers.delete(watch); remotes.delete(book.id); }
}

export async function removeLocalCopy(bookId) {
  remotes.delete(bookId);
  await local.del('files', bookId);
  state.downloaded.delete(bookId); emit();
}

/** 阅读状态：手动设过就用手动的，否则按进度判断 */
export function statusOf(book) {
  if (book.status === 'reading' || book.status === 'finished') return book.status;
  const p = state.progress[book.id]?.percent || 0;
  return p >= 0.995 ? 'finished' : p > 0 ? 'reading' : 'unread';
}

export function natural(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

/** 从书名里猜系列和卷号："某某 第3卷" / "某某 03" / "某某 (3)" / "某某 Vol.3" */
export function guessSeries(title) {
  const m = /^(.*?)[\s　_\-—~～:：]*(?:第\s*(\d{1,4}(?:\.\d)?)\s*[卷巻册冊集部]|vol(?:ume)?[.\s]*(\d{1,4}(?:\.\d)?)|[(（\[【](\d{1,3}(?:\.\d)?)[)）\]】]|(?<!\d)(\d{1,3}(?:\.\d)?))\s*$/i.exec(title.trim());
  if (!m) return null;
  const series = m[1].trim();
  const volume = parseFloat(m[2] ?? m[3] ?? m[4] ?? m[5]);
  if (series.length < 2 || !Number.isFinite(volume)) return null;
  return { series, volume };
}
/** 卷号显示成什么：短篇 / 番外用自己的名字（安可短篇集、SSS），否则是数字 */
export const volText = (book) => (book.series ? book.volumeLabel || (book.volume != null ? String(book.volume) : '') : '');
export const volName = (book) => (book.series ? book.volumeLabel || (book.volume != null ? `第 ${book.volume} 卷` : '') : '');
export const seriesLabel = (book) => (book.series ? `${book.series}${volText(book) ? ` ${volText(book)}` : ''}` : book.title);

async function inspect(file, fileName = file.name, { layout = true } = {}) {
  const name = fileName.replace(/\.[^.]+$/, '');
  const ext = fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase();
  if (ext === 'epub') {
    const epub = await Epub.open(file);
    const cover = await epub.coverBlob().catch(() => null);
    const title = epub.title || name;
    const guess = epub.series ? { series: epub.series, volume: epub.volume } : guessSeries(title);
    return { format: 'epub', title, author: epub.author, illustrator: epub.illustrator, publisher: epub.publisher, description: epub.description, published: epub.published, cover, ...guess };
  }
  if (ext === 'cbz' || ext === 'zip') {
    const zip = await ZipReader.open(file);
    const pages = zip.entries.filter((e) => !e.isDir && isImageName(e.name)).sort((a, b) => natural(a.name, b.name));
    if (!pages.length) throw new Error('压缩包里没有找到图片');
    // 本机文件顺便识别版面（哪些页是两页拼图）；网盘里的书等第一次打开时再识别，免得导入时整本下载
    const pageLayout = layout ? await probeLayout(zip, pages).catch(() => '') : '';
    return { format: 'cbz', title: name, author: '', cover: await zip.blobOf(pages[0], mimeOf(pages[0].name)), pageLayout, ...guessSeries(name) };
  }
  throw new Error('只支持 EPUB 和 CBZ / ZIP');
}

const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');

/** 修改书的信息（本机模式下和服务器的规则保持一致） */
function patchLocal(book, body) {
  const str = (v, max) => String(v).trim().slice(0, max);
  for (const [k, max] of [['author', 500], ['illustrator', 200], ['publisher', 200], ['description', 8000], ['review', 5000], ['series', 200]]) {
    if (typeof body[k] === 'string') book[k] = str(body[k], max);
  }
  if (typeof body.title === 'string' && body.title.trim()) book.title = str(body.title, 500);
  if (Number.isInteger(body.rating) && body.rating >= 0 && body.rating <= 5) book.rating = body.rating;
  if (['', 'reading', 'finished'].includes(body.status)) book.status = body.status;
  if (typeof body.imprint === 'string') book.imprint = str(body.imprint, 40);
  if (typeof body.imprintMark === 'string') book.imprintMark = str(body.imprintMark, 60);
  if (Array.isArray(body.tags)) book.tags = (Array.isArray(body.tags) ? [...new Set(body.tags.map((t) => String(t).replace(/^#/, '').trim().slice(0, 30)).filter(Boolean))].slice(0, 40) : []);
  if (typeof body.originalTitle === 'string') book.originalTitle = str(body.originalTitle, 300);
  if (typeof body.bangumiId === 'number' || body.bangumiId === null) book.bangumiId = body.bangumiId;
  if (typeof body.published === 'string') book.published = /^\d{4}(-\d{2}(-\d{2})?)?$/.test(body.published.trim()) ? body.published.trim() : '';
  if (typeof body.spineFace === 'string') book.spineFace = body.spineFace;
  if (typeof body.pageLayout === 'string') book.pageLayout = /^[pwc]{0,20000}$/.test(body.pageLayout) ? body.pageLayout : '';
  if ('volume' in body) book.volume = body.volume === null || body.volume === '' || !Number.isFinite(Number(body.volume)) ? null : Number(body.volume);
  if (typeof body.volumeLabel === 'string') book.volumeLabel = body.volumeLabel.trim().slice(0, 40);
  if (!book.series) { book.volume = null; book.volumeLabel = ''; }
  if (Array.isArray(body.collections)) book.collections = [...new Set(body.collections.filter((c) => state.collections[c]))];
  book.updatedAt = Date.now();
}

/** 导入一本书：本地解析书名、封面和简介 → 账号模式上传到服务器，本机模式直接存下 → 都留一份在本机 */
export async function importBook(file, collectionIds = []) {
  const info = await inspect(file);
  const extra = { description: info.description || '', ...(info.published ? { published: info.published } : {}), ...(info.pageLayout ? { pageLayout: info.pageLayout } : {}) };
  let saved, duplicate = false, jpg = null;
  if (info.cover) jpg = await shrinkCover(info.cover, { wrap: info.format === 'cbz' }).catch(() => null);
  if (account()) {
    const q = new URLSearchParams({
      format: info.format, title: info.title, author: info.author, name: file.name, collections: collectionIds.join(','),
      series: info.series || '', volume: info.volume ?? '', illustrator: info.illustrator || '', publisher: info.publisher || '',
    });
    const res = await (await api('/api/books?' + q, { method: 'POST', body: file })).json();
    saved = res.book; duplicate = !!res.duplicate;
    if (!duplicate) {
      if (jpg) {
        try { saved = (await (await api(`/api/books/${saved.id}/cover`, { method: 'PUT', body: jpg })).json()).book; }
        catch { /* 封面失败不影响书 */ }
      }
      if (extra.description || extra.published || extra.pageLayout) saved = (await apiJson('/api/books/' + saved.id, 'PATCH', extra).catch(() => ({ book: saved }))).book;
    }
  } else {
    const dup = Object.values(state.books).find((b) => b.size === file.size && b.fileName === file.name);
    if (dup) return { book: dup, duplicate: true };
    const now = Date.now();
    saved = {
      id: randomId(), format: info.format, size: file.size, title: info.title, author: info.author || '',
      illustrator: info.illustrator || '', publisher: info.publisher || '', description: extra.description, published: extra.published || '', pageLayout: extra.pageLayout || '', status: '', rating: 0, review: '',
      series: info.series || '', volume: info.volume ?? null, fileName: file.name,
      collections: collectionIds.filter((c) => state.collections[c]), hasCover: !!jpg, coverAt: jpg ? now : 0, addedAt: now, updatedAt: now,
    };
    await local.put('files', saved.id, file.slice()); // 本机模式下文件必须存下来
    state.downloaded.add(saved.id);
  }
  if (jpg && saved.hasCover) local.put('covers', saved.id, { at: saved.coverAt, blob: jpg }).catch(() => {});
  state.books[saved.id] = saved;
  if (account()) { try { await local.put('files', saved.id, file.slice()); state.downloaded.add(saved.id); } catch { /* 忽略 */ } }
  persist(); emit();
  return { book: saved, duplicate };
}

/** 自动查作品资料（经自己的服务器去 Bangumi / AniList / DeepSeek 搜索） */
export const metaLookup = (body) => apiJson('/api/meta/lookup', 'POST', body);
// 在线书库（Novelia），都经自己的服务器转发
const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();
export const novelia = {
  status: () => apiJson('/api/novelia/status', 'GET'),
  login: (username, password) => apiJson('/api/novelia/login', 'POST', { username, password }),
  logout: () => apiJson('/api/novelia/logout', 'POST', {}),
  wenku: (q) => apiJson('/api/novelia/wenku?' + qs(q), 'GET'),
  wenkuOne: (id) => apiJson('/api/novelia/wenku/' + encodeURIComponent(id), 'GET'),
  web: (q) => apiJson('/api/novelia/novel?' + qs(q), 'GET'),
  webOne: (provider, id) => apiJson(`/api/novelia/novel/${encodeURIComponent(provider)}/${encodeURIComponent(id)}`, 'GET'),
  async file(q) {
    const res = await api('/api/novelia/file?' + qs(q));
    const blob = await res.blob();
    let name = 'novelia.epub';
    try { name = decodeURIComponent(res.headers.get('X-File-Name') || name); } catch { /* 用默认名 */ }
    if (!/\.epub$/i.test(name)) name += '.epub';
    return new File([blob], name, { type: 'application/epub+zip' });
  },
};

// ---------- 百度网盘 ----------
direct.useApi(apiJson);
export { direct };
/** 诊断设备直连：随机跳到书里任意位置，直连读一段，再经服务器读同一段逐字节核对 */
export async function diagnoseDirect(book, rounds = 12) {
  const proxyRead = async (key, start, end) => {
    if (book.source.type === 'baidu') {
      const res = await api(`/api/books/${book.id}/file`, { headers: { Range: `bytes=${start}-${end}` } });
      return new Uint8Array(await res.arrayBuffer());
    }
    const res = await api(`/api/books/${book.id}/page/${key}`);
    return new Uint8Array(await res.arrayBuffer()).subarray(start, end + 1);
  };
  return direct.diagnose(book, { rounds, proxyRead });
}
// ---------- 挂载：WebDAV / OPDS / 服务器文件夹 ----------
export const mounts = {
  list: () => apiJson('/api/mounts'),
  create: (body) => apiJson('/api/mounts', 'POST', body),
  update: (id, body) => apiJson('/api/mounts/' + id, 'PUT', body),
  remove: (id) => apiJson('/api/mounts/' + id, 'DELETE'),
  browse: (id, path) => apiJson(`/api/mounts/${id}/list?` + new URLSearchParams({ path: path || '' })),
  /** OPDS 封面：要带登录令牌，所以先取回来再变成本地地址 */
  async coverUrl(id, path) {
    const res = await api(`/api/mounts/${id}/fetch?` + new URLSearchParams({ path, name: 'cover.jpg' }));
    return URL.createObjectURL(await res.blob());
  },
  /** 整个文件取回来（OPDS 用），变成 File 再按普通文件导入 */
  async fetchFile(id, path, name) {
    const res = await api(`/api/mounts/${id}/fetch?` + new URLSearchParams({ path, name }));
    return new File([await res.blob()], name, { type: /\.epub$/i.test(name) ? 'application/epub+zip' : 'application/zip' });
  },
};
/** 把挂载里的文件 / 图片文件夹放上书架：书架上只记位置，然后读出封面和书名 */
export async function addFromMount(mountId, items, collectionIds = [], onStep) {
  const { added } = await apiJson(`/api/mounts/${mountId}/add`, 'POST', { items, collections: collectionIds });
  return finishAdded(added, onStep);
}

export const baidu = {
  status: () => apiJson('/api/cloud/baidu'),
  setApp: (appKey, secretKey) => apiJson('/api/cloud/baidu/app', 'PUT', { appKey, secretKey }),
  device: () => apiJson('/api/cloud/baidu/device', 'POST', {}),
  poll: () => apiJson('/api/cloud/baidu/poll', 'POST', {}),
  disconnect: () => apiJson('/api/cloud/baidu', 'DELETE'),
  list: (dir) => apiJson('/api/cloud/baidu/list?' + new URLSearchParams({ dir })),
};
/** 把网盘里的文件 / 图片文件夹放上书架：书架上只记位置，文件留在网盘里；然后从网盘里读出封面和书名 */
export async function addFromBaidu(items, collectionIds = [], onStep) {
  const { added } = await apiJson('/api/cloud/baidu/add', 'POST', { items, collections: collectionIds });
  return finishAdded(added, onStep);
}
async function finishAdded(added, onStep) {
  for (const { book } of added) state.books[book.id] = book;
  persist(); emit();
  let i = 0;
  for (const { book, duplicate } of added) {
    onStep?.(++i, added.length, book);
    if (duplicate || book.hasCover) continue;
    try { await finishCloudBook(book); } catch { /* 封面取不到不影响阅读 */ }
  }
  return added;
}
async function finishCloudBook(book) {
  let info;
  if (isPageDir(book)) {
    const src = await new PageListSource(book).load();
    info = { format: 'cbz', cover: await src.blobOf(src.entries[0]), ...(book.series ? {} : guessSeries(book.title)) };
  } else {
    const src = remoteOf(book);
    try { info = await inspect(src, book.fileName || `${book.title}.${book.format}`, { layout: false }); }
    finally { remotes.delete(book.id); }
  }
  const patch = {};
  if (book.format === 'epub') {
    for (const k of ['title', 'author', 'illustrator', 'publisher', 'description', 'published']) if (info[k]) patch[k] = info[k];
  }
  if (!book.series && info.series) { patch.series = info.series; patch.volume = info.volume; }
  if (Object.keys(patch).length) state.books[book.id] = (await apiJson('/api/books/' + book.id, 'PATCH', patch)).book;
  if (info.cover) {
    const jpg = await shrinkCover(info.cover, { wrap: info.format === 'cbz' }).catch(() => null);
    if (jpg) {
      const saved = (await (await api(`/api/books/${book.id}/cover`, { method: 'PUT', body: jpg })).json()).book;
      state.books[book.id] = saved;
      local.put('covers', book.id, { at: saved.coverAt, blob: jpg }).catch(() => {});
    }
  }
  persist(); emit();
}

/** 漫画封面重新生成：mode 'front' 只要整张书衣的正面，'full' 用第一页原图 */
export async function remakeComicCover(id, mode = 'front') {
  const book = state.books[id];
  const { source, release } = await bookSource(book);
  let blob;
  try {
    const zip = source.isPageList ? source : await ZipReader.open(source);
    const pages = zip.entries.filter((e) => !e.isDir && isImageName(e.name)).sort((a, b) => natural(a.name, b.name));
    if (!pages.length) throw new Error('没有找到图片');
    blob = await zip.blobOf(pages[0], mimeOf(pages[0].name));
  } finally { release(); }
  if (mode === 'front') blob = await frontOnly(blob);
  const jpg = await shrinkCover(blob);
  if (!jpg) throw new Error('封面生成失败');
  if (account()) {
    state.books[id] = (await (await api(`/api/books/${id}/cover`, { method: 'PUT', body: jpg })).json()).book;
  } else {
    Object.assign(book, { hasCover: true, coverAt: Date.now() });
  }
  local.put('covers', id, { at: state.books[id].coverAt, blob: jpg }).catch(() => {});
  persist(); emit();
}

export async function updateBook(id, patch) {
  if (account()) state.books[id] = (await apiJson('/api/books/' + id, 'PATCH', patch)).book;
  else patchLocal(state.books[id], patch);
  persist(); emit();
}
export async function deleteBook(id) {
  if (account()) await apiJson('/api/books/' + id, 'DELETE');
  delete state.books[id]; delete state.progress[id]; delete pending[id]; delete state.marks[id];
  state.downloaded.delete(id);
  local.del('files', id).catch(() => {}); local.del('covers', id).catch(() => {});
  persist(); emit();
}

// ---------- 合集 ----------
export async function createCollection(name) {
  let collection;
  if (account()) collection = (await apiJson('/api/collections', 'POST', { name })).collection;
  else {
    const now = Date.now();
    const order = Object.values(state.collections).reduce((m, c) => Math.max(m, c.order), 0) + 1;
    collection = { id: randomId(), name: name.trim().slice(0, 60), order, createdAt: now, updatedAt: now };
  }
  state.collections[collection.id] = collection; persist(); emit();
  return collection;
}
export async function renameCollection(id, name) {
  if (account()) state.collections[id] = (await apiJson('/api/collections/' + id, 'PATCH', { name })).collection;
  else Object.assign(state.collections[id], { name: name.trim().slice(0, 60), updatedAt: Date.now() });
  persist(); emit();
}
export async function deleteCollection(id) {
  if (account()) await apiJson('/api/collections/' + id, 'DELETE');
  delete state.collections[id];
  for (const b of Object.values(state.books)) b.collections = b.collections.filter((c) => c !== id);
  persist(); emit();
}

// ---------- 本机书库 → 账号 ----------
/** 本机书库里有多少本书（登录后用来问要不要上传） */
export async function localLibrarySize() {
  const lib = await local.get('kv', 'state:local').catch(() => null);
  return Object.keys(lib?.books || {}).length;
}
/** 把本机书库整个搬到当前账号：书、封面、合集、进度、书签批注、阅读时长 */
export async function uploadLocalLibrary(onStep) {
  const lib = await local.get('kv', 'state:local').catch(() => null);
  if (!lib || !account()) return { moved: 0, failed: 0 };
  const colMap = {};
  for (const c of Object.values(lib.collections || {}).sort((a, b) => a.order - b.order)) {
    const same = Object.values(state.collections).find((x) => x.name === c.name);
    colMap[c.id] = same ? same.id : (await createCollection(c.name)).id;
  }
  const idMap = {};
  let moved = 0, failed = 0;
  const books = Object.values(lib.books);
  for (const [i, b] of books.entries()) {
    onStep?.(i + 1, books.length, b);
    try {
      const file = await local.get('files', b.id);
      if (!file) throw new Error('文件不在本机');
      const q = new URLSearchParams({
        format: b.format, title: b.title, author: b.author || '', name: b.fileName || `${b.title}.${b.format}`,
        series: b.series || '', volume: b.volume ?? '', illustrator: b.illustrator || '', publisher: b.publisher || '', addedAt: b.addedAt,
      });
      let { book } = await (await api('/api/books?' + q, { method: 'POST', body: file })).json();
      const cover = b.hasCover ? await local.get('covers', b.id).catch(() => null) : null;
      if (cover) {
        book = (await (await api(`/api/books/${book.id}/cover`, { method: 'PUT', body: cover.blob })).json()).book;
        local.put('covers', book.id, { at: book.coverAt, blob: cover.blob }).catch(() => {});
      }
      book = (await apiJson('/api/books/' + book.id, 'PATCH', {
        description: b.description || '', status: b.status || '', rating: b.rating || 0, review: b.review || '',
        imprint: b.imprint || '', imprintMark: b.imprintMark || '', published: b.published || '', tags: b.tags || [], originalTitle: b.originalTitle || '',
          ...(b.volumeLabel ? { volumeLabel: b.volumeLabel } : {}),
        collections: (b.collections || []).map((c) => colMap[c]).filter(Boolean),
      })).book;
      idMap[b.id] = book.id;
      if (book.id !== b.id) { await local.put('files', book.id, file); state.downloaded.add(book.id); }
      const p = lib.progress?.[b.id];
      if (p) await apiJson('/api/progress/' + book.id, 'PUT', p);
      for (const m of Object.values(lib.marks?.[b.id] || {})) await apiJson(`/api/marks/${book.id}/${m.id}`, 'PUT', m);
      state.books[book.id] = book;
      moved++;
    } catch (e) { failed++; console.warn('上传失败', b.title, e); }
  }
  const add = [];
  for (const [day, perBook] of Object.entries(lib.stats || {})) {
    for (const [id, seconds] of Object.entries(perBook)) if (idMap[id]) add.push({ day, book: idMap[id], seconds });
  }
  if (add.length) await apiJson('/api/stats', 'POST', { add }).catch(() => {});
  // 搬过去的书从本机书库里拿掉，没搬成功的留着
  for (const [oldId, newId] of Object.entries(idMap)) {
    delete lib.books[oldId]; delete lib.progress?.[oldId]; delete lib.marks?.[oldId];
    if (oldId !== newId) { local.del('files', oldId).catch(() => {}); local.del('covers', oldId).catch(() => {}); }
  }
  if (!Object.keys(lib.books).length) lib.collections = {};
  await local.put('kv', 'state:local', lib);
  await sync().catch(() => {});
  return { moved, failed };
}
export const sortedCollections = () => Object.values(state.collections).sort((a, b) => a.order - b.order);

export async function localUsage() {
  try { const e = await navigator.storage.estimate(); return e.usage || 0; } catch { return 0; }
}
