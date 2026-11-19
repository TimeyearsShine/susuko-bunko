#!/usr/bin/env node
// スス子文庫（Susuko Bunko）同步服务端 —— 零依赖，Node.js 18+ 即可运行
//   SHIORI_KEY=你的邀请码 node server.js
// 环境变量：
//   SHIORI_KEY   必填。注册账号时要填的邀请码（防止陌生人注册）；旧版客户端也可以直接用它登录第一个账号
//   PORT         默认 8787        HOST      默认 127.0.0.1
//   DATA_DIR     默认 ./data      MAX_BOOK_MB 单本上限，默认 2048
//   OPEN_SIGNUP  设为 1 时注册不需要邀请码
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const meta = require('./meta.js');
const novelia = require('./novelia.js');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const KEY = process.env.SHIORI_KEY || '';
const OPEN_SIGNUP = process.env.OPEN_SIGNUP === '1';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const APP_DIR = path.resolve(process.env.APP_DIR || path.join(__dirname, '..', 'app'));
const MAX_BOOK_BYTES = Number(process.env.MAX_BOOK_MB || 2048) * 1024 * 1024;
const VERSION = '0.12.2';
// 百度网盘开放平台应用（也可以每个账号在设置里自己填）
const BAIDU_APP_KEY = process.env.BAIDU_APP_KEY || '';
const BAIDU_SECRET_KEY = process.env.BAIDU_SECRET_KEY || '';
const BAIDU_OPENAPI = process.env.BAIDU_OPENAPI || 'https://openapi.baidu.com'; // 只在测试时换成模拟服务器
const BAIDU_PAN = process.env.BAIDU_PAN || 'https://pan.baidu.com';

if (!KEY || KEY.length < 8) {
  console.error('请先设置邀请码（至少 8 位）：SHIORI_KEY=xxxxxxxx node server.js');
  process.exit(1);
}

const BOOKS_DIR = path.join(DATA_DIR, 'books');
const COVERS_DIR = path.join(DATA_DIR, 'covers');
const AVATARS_DIR = path.join(DATA_DIR, 'avatars');
const DB_FILE = path.join(DATA_DIR, 'db.json');
for (const d of [DATA_DIR, BOOKS_DIR, COVERS_DIR, AVATARS_DIR]) fs.mkdirSync(d, { recursive: true });

// ---------- 数据库（一个 JSON 文件，原子写入） ----------
// 结构：{ version: 2, users: { uid: 用户 }, tokens: { 令牌哈希: { uid } }, libs: { uid: 书库 }, legacy?: 旧版单人书库 }
const emptyLib = () => ({ books: {}, collections: {}, progress: {}, marks: {}, stats: {}, hours: {}, series: {}, settings: null, cloud: {}, cloudPages: {} });
let db = { version: 2, users: {}, tokens: {}, libs: {} };
if (fs.existsSync(DB_FILE)) {
  const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  if (raw.version === 2) db = Object.assign(db, raw);
  else { // 0.4 及以前：整个文件就是一个人的书库，留给第一个注册的账号
    db.legacy = Object.assign(emptyLib(), raw);
    console.log('检测到旧版书库，第一个注册的账号会自动接管它');
  }
}
let saveTimer = null, saving = Promise.resolve();
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saving = saving.then(flush).catch((e) => console.error('保存失败', e));
  }, 200);
}
async function flush() {
  const tmp = DB_FILE + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(db));
  await fsp.rename(tmp, DB_FILE);
}
function shutdown() {
  if (saveTimer) { clearTimeout(saveTimer); fs.writeFileSync(DB_FILE, JSON.stringify(db)); }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ---------- 工具 ----------
const newId = () => crypto.randomBytes(8).toString('hex');
const isId = (s) => /^[a-f0-9]{16}$/.test(s);
const FORMATS = new Set(['epub', 'cbz']);
const MARK_TYPES = new Set(['bookmark', 'note', 'highlight']);
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const safeEqual = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type,Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range,Content-Length,Accept-Ranges');
  res.setHeader('Access-Control-Max-Age', '86400');
}
function json(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(s);
}
const fail = (res, code, message) => json(res, code, { error: message });

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) { reject(Object.assign(new Error('请求体过大'), { code: 413 })); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req, limit) {
  const buf = await readBody(req, limit);
  try { return JSON.parse(buf.toString('utf8') || '{}'); }
  catch { throw Object.assign(new Error('JSON 格式错误'), { code: 400 }); }
}
const str = (v, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
function volumeOf(v) { // 卷号：允许 7.5 这样的番外卷；空值表示没有卷号
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n < 100000 ? n : null;
}

function sendFile(req, res, file, type, downloadName) {
  fs.stat(file, (err, st) => {
    if (err) return fail(res, 404, '文件不存在');
    const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=0' };
    if (downloadName) headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`;
    let start = 0, end = st.size - 1, code = 200;
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (m && (m[1] || m[2])) {
      if (m[1]) { start = Number(m[1]); if (m[2]) end = Math.min(end, Number(m[2])); }
      else start = Math.max(0, st.size - Number(m[2]));
      if (start > end || start >= st.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end();
      }
      code = 206; headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
    }
    headers['Content-Length'] = end - start + 1;
    res.writeHead(code, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file, { start, end }).pipe(res);
  });
}

// ---------- 账号 ----------
const hashPassword = (password, salt) => crypto.scryptSync(password, salt, 64).toString('hex');
const publicUser = (u) => ({ id: u.id, username: u.username, nickname: u.nickname, avatarAt: u.avatarAt || 0, createdAt: u.createdAt });
function issueToken(uid, device) {
  const token = crypto.randomBytes(24).toString('base64url');
  db.tokens[sha256(token)] = { uid, device: str(device, 40), createdAt: Date.now() };
  save();
  return token;
}
/** 从请求头找出是哪个账号。旧版客户端发来的 SHIORI_KEY 视为第一个账号。 */
function userOf(req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token) return null;
  const t = db.tokens[sha256(token)];
  if (t && db.users[t.uid]) return db.users[t.uid];
  if (safeEqual(token, KEY)) return Object.values(db.users).sort((a, b) => a.createdAt - b.createdAt)[0] || null;
  return null;
}
// 登录失败太多次就暂时拒绝（按 IP）
const failures = new Map();
function tooMany(ip) {
  const f = failures.get(ip);
  return f && f.count >= 8 && Date.now() - f.at < 10 * 60 * 1000;
}
function noteFailure(ip) {
  const f = failures.get(ip);
  if (f && Date.now() - f.at < 10 * 60 * 1000) f.count++; else failures.set(ip, { count: 1, at: Date.now() });
}

async function auth(req, res, seg) {
  const ip = req.socket.remoteAddress;
  if (seg[1] === 'register' && req.method === 'POST') {
    const body = await readJson(req);
    if (tooMany(ip)) return fail(res, 429, '尝试太多次了，请十分钟后再试');
    if (!OPEN_SIGNUP && !safeEqual(str(body.invite, 200), KEY)) { noteFailure(ip); return fail(res, 403, '邀请码不对。邀请码就是启动服务端时设置的 SHIORI_KEY'); }
    const username = str(body.username, 32).toLowerCase();
    if (!/^[a-z0-9_.\-぀-ヿ一-鿿]{2,32}$/.test(username)) return fail(res, 400, '用户名需要 2～32 个字符，可以用字母、数字、中文、日文和 _ . -');
    if (typeof body.password !== 'string' || body.password.length < 6) return fail(res, 400, '密码至少 6 位');
    if (Object.values(db.users).some((u) => u.username === username)) return fail(res, 409, '这个用户名已经有人用了');
    const salt = crypto.randomBytes(16).toString('hex');
    const user = {
      id: newId(), username, nickname: str(body.nickname, 40) || username,
      salt, hash: hashPassword(body.password, salt), avatarAt: 0, createdAt: Date.now(),
    };
    db.users[user.id] = user;
    db.libs[user.id] = db.legacy || emptyLib(); // 第一个账号接管旧版书库
    delete db.legacy;
    save();
    return json(res, 201, { token: issueToken(user.id, body.device), user: publicUser(user) });
  }
  if (seg[1] === 'login' && req.method === 'POST') {
    const body = await readJson(req);
    if (tooMany(ip)) return fail(res, 429, '尝试太多次了，请十分钟后再试');
    const user = Object.values(db.users).find((u) => u.username === str(body.username, 32).toLowerCase());
    if (!user || typeof body.password !== 'string' || !safeEqual(hashPassword(body.password, user.salt), user.hash)) {
      noteFailure(ip);
      return fail(res, 401, '用户名或密码不对');
    }
    failures.delete(ip);
    return json(res, 200, { token: issueToken(user.id, body.device), user: publicUser(user) });
  }
  if (seg[1] === 'logout' && req.method === 'POST') {
    const h = req.headers.authorization || '';
    delete db.tokens[sha256(h.startsWith('Bearer ') ? h.slice(7) : '')];
    save();
    return json(res, 200, { ok: true });
  }
  fail(res, 404, '接口不存在');
}

// ---------- 书库 API（都在当前账号的书库里操作） ----------
const bookFile = (b) => path.join(BOOKS_DIR, `${b.id}.${b.format}`);
const coverFile = (id) => path.join(COVERS_DIR, `${id}.jpg`);
const avatarFile = (uid) => path.join(AVATARS_DIR, `${uid}.jpg`);

async function uploadBook(req, res, q, lib) {
  const format = str(q.get('format'), 8).toLowerCase();
  if (!FORMATS.has(format)) return fail(res, 400, '只支持 epub 和 cbz/zip');
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > MAX_BOOK_BYTES) return fail(res, 413, '文件超过大小上限');

  const id = newId();
  const tmp = path.join(BOOKS_DIR, `${id}.part`);
  const hash = crypto.createHash('sha256');
  let size = 0;
  try {
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(tmp);
      req.on('data', (c) => {
        size += c.length; hash.update(c);
        if (size > MAX_BOOK_BYTES) { req.destroy(); reject(Object.assign(new Error('文件超过大小上限'), { code: 413 })); }
      });
      req.on('aborted', () => reject(new Error('上传中断')));
      req.on('error', reject); out.on('error', reject); out.on('finish', resolve);
      req.pipe(out);
    });
  } catch (e) {
    await fsp.rm(tmp, { force: true });
    return fail(res, e.code === 413 ? 413 : 400, e.message);
  }
  if (!size) { await fsp.rm(tmp, { force: true }); return fail(res, 400, '空文件'); }

  const sha = hash.digest('hex');
  const dup = Object.values(lib.books).find((b) => b.sha256 === sha);
  if (dup) { await fsp.rm(tmp, { force: true }); return json(res, 200, { book: dup, duplicate: true }); }

  const now = Date.now();
  const cols = (q.get('collections') || '').split(',').filter((c) => lib.collections[c]);
  const book = {
    id, format, size, sha256: sha,
    title: str(q.get('title')) || str(q.get('name')) || '未命名',
    author: str(q.get('author')),
    illustrator: str(q.get('illustrator'), 200), publisher: str(q.get('publisher'), 200), status: '',
    rating: 0, review: '', description: '',
    series: str(q.get('series'), 200), volume: volumeOf(q.get('volume')),
    fileName: str(q.get('name')),
    collections: cols, hasCover: false, addedAt: Number(q.get('addedAt')) || now, updatedAt: now,
  };
  await fsp.rename(tmp, bookFile(book));
  lib.books[id] = book; save();
  json(res, 201, { book });
}

// 出版时间：只收 2024 / 2024-07 / 2024-07-18 这三种写法
const dateOf = (v) => (/^\d{4}(-\d{2}(-\d{2})?)?$/.test(String(v).trim()) ? String(v).trim() : '');
function patchBook(book, body, lib) {
  if (typeof body.title === 'string' && str(body.title)) book.title = str(body.title);
  if (typeof body.author === 'string') book.author = str(body.author);
  if (typeof body.illustrator === 'string') book.illustrator = str(body.illustrator, 200);
  if (typeof body.publisher === 'string') book.publisher = str(body.publisher, 200);
  if (typeof body.description === 'string') book.description = str(body.description, 8000);
  if (Number.isInteger(body.rating) && body.rating >= 0 && body.rating <= 5) book.rating = body.rating; // 0 = 没评分
  if (typeof body.review === 'string') book.review = str(body.review, 5000);
  if (['', 'reading', 'finished'].includes(body.status)) book.status = body.status; // 空 = 按进度自动判断
  if (typeof body.series === 'string') book.series = str(body.series, 200);
  if (typeof body.imprint === 'string') book.imprint = str(body.imprint, 40);
  if (typeof body.imprintMark === 'string') book.imprintMark = str(body.imprintMark, 60);
  if (Array.isArray(body.tags)) book.tags = (Array.isArray(body.tags) ? [...new Set(body.tags.map((t) => String(t).replace(/^#/, '').trim().slice(0, 30)).filter(Boolean))].slice(0, 40) : []);
  if (typeof body.originalTitle === 'string') book.originalTitle = str(body.originalTitle, 300);
  if (typeof body.bangumiId === 'number' || body.bangumiId === null) book.bangumiId = body.bangumiId;
  if (typeof body.published === 'string') book.published = dateOf(body.published);
  if (typeof body.spineFace === 'string') book.spineFace = /^(none|[01](\.\d{1,3})?,[01](\.\d{1,3})?)?$/.test(body.spineFace) ? body.spineFace : '';
  if ('volume' in body) book.volume = volumeOf(body.volume);
  if (!book.series) book.volume = null;
  if (Array.isArray(body.collections)) book.collections = [...new Set(body.collections.filter((c) => lib.collections[c]))];
  book.updatedAt = Date.now();
}

/** 把 AI 请求转发到用户自己配置的接口（避开浏览器的跨域限制），原样流式返回 */
async function aiProxy(req, res) {
  const body = await readJson(req, 2 * 1024 * 1024);
  let target;
  try { target = new URL(body.url); } catch { return fail(res, 400, '接口地址格式不对'); }
  if (!/^https?:$/.test(target.protocol)) return fail(res, 400, '接口地址必须是 http 或 https');
  const ctrl = new AbortController();
  req.on('close', () => ctrl.abort());
  let upstream;
  try {
    upstream = await fetch(target, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', ...(body.key ? { Authorization: 'Bearer ' + body.key } : {}) },
      body: JSON.stringify(body.payload ?? {}),
    });
  } catch (e) {
    return fail(res, 502, `服务器连不上这个接口：${e.message}`);
  }
  res.writeHead(upstream.status, {
    'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream', 'Cache-Control': 'no-store',
  });
  if (!upstream.body) return res.end();
  Readable.fromWeb(upstream.body).on('error', () => res.destroy()).pipe(res);
}

// ---------- 百度网盘 ----------
// 授权用“设备码模式”：服务器向百度要一个用户码，用户在手机或电脑上扫码 / 输入用户码同意，服务器轮询拿到令牌。
// 令牌只存在服务器上，不发给客户端。读书时服务器带着令牌去百度取文件，按需转发（支持 Range，只取要看的那几页）。
const BAIDU_UA = 'pan.baidu.com'; // 百度要求下载时用这个 User-Agent，大文件不带会被拒
const dlinkCache = new Map(); // fsid → { url, at }，百度的下载地址 8 小时有效

class BaiduError extends Error {
  constructor(message, status = 502, code = '') { super(message); this.status = status; this.code = code; }
}
const baiduApp = (lib) => {
  const c = lib.cloud.baidu || {};
  return { key: c.appKey || BAIDU_APP_KEY, secret: c.secretKey || BAIDU_SECRET_KEY, own: !!c.appKey };
};
async function baiduFetch(url, opts = {}) {
  let r;
  try { r = await fetch(url, { ...opts, headers: { 'User-Agent': BAIDU_UA, ...(opts.headers || {}) } }); }
  catch (e) { throw new BaiduError(`服务器连不上百度网盘：${e.message}`); }
  return r;
}
async function baiduJson(url, opts) {
  const r = await baiduFetch(url, opts);
  const data = await r.json().catch(() => ({}));
  const errno = data.errno ?? data.error_code;
  if (errno === -6 || errno === 111 || errno === 110 || data.error === 'invalid_grant' || data.error === 'expired_token') {
    throw new BaiduError('百度网盘的授权失效了，请在设置里重新连接', 401, 'auth');
  }
  if (errno === 31034 || errno === 42213) throw new BaiduError('百度网盘接口调用太频繁，稍等一会儿再试', 429);
  if (errno && errno !== 0) throw new BaiduError(`百度网盘返回错误（${errno}${data.errmsg ? '：' + data.errmsg : ''}）`);
  if (data.error) throw new BaiduError(data.error_description || data.error, 400, data.error);
  return data;
}
async function baiduOAuth(params) {
  const r = await baiduFetch(`${BAIDU_OPENAPI}/oauth/2.0/token?${new URLSearchParams(params)}`);
  return r.json().catch(() => ({}));
}
function keepTokens(c, t) {
  c.accessToken = t.access_token; c.refreshToken = t.refresh_token || c.refreshToken;
  c.expiresAt = Date.now() + (Number(t.expires_in) || 2592000) * 1000;
}
/** 拿一个能用的 access_token：快过期（剩不到一天）就先用 refresh_token 换新的 */
async function baiduToken(lib) {
  const c = lib.cloud.baidu;
  if (!c?.accessToken) throw new BaiduError('还没有连接百度网盘', 401, 'auth');
  if (c.expiresAt - Date.now() > 86400000) return c.accessToken;
  const app = baiduApp(lib);
  const t = await baiduOAuth({ grant_type: 'refresh_token', refresh_token: c.refreshToken, client_id: app.key, client_secret: app.secret });
  if (!t.access_token) throw new BaiduError('百度网盘的授权过期了，请在设置里重新连接', 401, 'auth');
  keepTokens(c, t); save();
  return c.accessToken;
}
async function baiduDlink(lib, fsid, fresh = false) {
  const hit = dlinkCache.get(fsid);
  if (!fresh && hit && Date.now() - hit.at < 7 * 3600000) return hit.url;
  const token = await baiduToken(lib);
  const data = await baiduJson(`${BAIDU_PAN}/rest/2.0/xpan/multimedia?${new URLSearchParams({ method: 'filemetas', access_token: token, fsids: JSON.stringify([Number(fsid)]), dlink: '1' })}`);
  const dlink = data.list?.[0]?.dlink;
  if (!dlink) throw new BaiduError('网盘里找不到这个文件，可能已经被移动或删除', 404);
  const url = `${dlink}&access_token=${encodeURIComponent(token)}`;
  dlinkCache.set(fsid, { url, at: Date.now() });
  if (dlinkCache.size > 2000) dlinkCache.delete(dlinkCache.keys().next().value);
  return url;
}
async function baiduPrefetch(lib, fsids) {
  const need = fsids.filter((f) => { const hit = dlinkCache.get(f); return !hit || Date.now() - hit.at > 6 * 3600000; }).slice(0, 100);
  if (!need.length) return;
  const token = await baiduToken(lib);
  const data = await baiduJson(`${BAIDU_PAN}/rest/2.0/xpan/multimedia?${new URLSearchParams({ method: 'filemetas', access_token: token, fsids: JSON.stringify(need.map(Number)), dlink: '1' })}`);
  for (const f of data.list || []) if (f.dlink) dlinkCache.set(String(f.fs_id), { url: `${f.dlink}&access_token=${encodeURIComponent(token)}`, at: Date.now() });
}
// ---------- 设备直连 ----------
// 安卓 / Windows 客户端可以自己去百度的下载服务器取文件（更快，不走服务器流量）。
// 百度的 dlink 必须带 access_token 才能下载，所以不能把 dlink 发给客户端。
// 服务器先带着令牌请求一次 dlink（只取 1 个字节），拿到百度 302 跳转后的 CDN 地址：
// 那是一个自带签名、会过期的地址，里面没有令牌。只把这个地址发给客户端；如果跳转后的地址里还带着令牌，就拒绝直连、让客户端走转发。
// 这些地址只放在内存里，不写数据库、不写日志。
const directCache = new Map(); // fsid → { url, at }
const DIRECT_TTL = 10 * 60 * 1000; // 发给客户端后按 10 分钟算过期（百度没有公开 CDN 地址的有效期，取保守值）
const ALLOWED_HOST = process.env.BAIDU_DIRECT_HOST_RE ? new RegExp(process.env.BAIDU_DIRECT_HOST_RE) : /(^|\.)(baidu\.com|baidupcs\.com|bcebos\.com|bdstatic\.com)$/i; // 环境变量只给测试用
async function baiduDirect(lib, fsid) {
  const hit = directCache.get(fsid);
  if (hit && Date.now() - hit.at < DIRECT_TTL / 2) return hit.url;
  for (let attempt = 0; attempt < 2; attempt++) {
    let url = await baiduDlink(lib, fsid, attempt > 0);
    let hops = 0, status = 0;
    for (; hops < 6; hops++) {
      const r = await baiduFetch(url, { redirect: 'manual', headers: { Range: 'bytes=0-0' } });
      status = r.status;
      const loc = r.headers.get('location');
      await r.body?.cancel().catch(() => {});
      if (status >= 300 && status < 400 && loc) { url = new URL(loc, url).href; continue; }
      break;
    }
    if (status === 403 || status === 401 || status === 404) continue; // dlink 过期了，重新要一个再试
    if (status !== 206 && status !== 200) throw new BaiduError(`百度没有给出直连地址（${status}）`, 502, 'no-direct');
    const u = new URL(url);
    if (!hops || /access_token=/i.test(u.search) || !ALLOWED_HOST.test(u.hostname)) {
      throw new BaiduError('这个文件百度没有给出可以安全交给设备的地址，只能经服务器转发', 409, 'no-direct');
    }
    directCache.set(fsid, { url, at: Date.now() });
    if (directCache.size > 3000) directCache.delete(directCache.keys().next().value);
    return url;
  }
  throw new BaiduError('百度拒绝了下载请求', 502, 'no-direct');
}

/** 把网盘里的文件按需转发给客户端，Range 原样带过去 */
async function baiduStream(req, res, lib, fsid, name, cacheable = false) {
  const ctrl = new AbortController();
  req.on('close', () => ctrl.abort());
  const headers = req.headers.range ? { Range: req.headers.range } : {};
  try {
    let r;
    for (let attempt = 0; attempt < 2; attempt++) {
      const url = await baiduDlink(lib, fsid, attempt > 0);
      r = await baiduFetch(url, { headers, signal: ctrl.signal, redirect: 'follow', method: req.method === 'HEAD' ? 'HEAD' : 'GET' });
      if (r.status !== 403 && r.status !== 401 && r.status !== 404) break; // 下载地址过期了就重新要一个
      await r.body?.cancel().catch(() => {});
    }
    if (!r.ok) return fail(res, 502, `百度网盘拒绝了下载（${r.status}）`);
    const out = {
      'Content-Type': mimeByName(name), 'Accept-Ranges': 'bytes',
      'Cache-Control': cacheable ? 'private, max-age=86400' : 'no-store',
    };
    for (const k of ['content-length', 'content-range']) { const v = r.headers.get(k); if (v) out[k] = v; }
    res.writeHead(r.status, out);
    if (req.method === 'HEAD' || !r.body) return res.end();
    Readable.fromWeb(r.body).on('error', () => res.destroy()).pipe(res);
  } catch (e) {
    if (ctrl.signal.aborted) return;
    return fail(res, e.status || 502, e.message);
  }
}
const mimeByName = (n = '') => ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', bmp: 'image/bmp', epub: 'application/epub+zip' })[String(n).split('.').pop().toLowerCase()] || 'application/octet-stream';
const IMAGE_RE = /\.(jpe?g|png|webp|gif|avif|bmp)$/i;
const naturalCmp = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

async function baiduList(lib, dir) {
  const token = await baiduToken(lib);
  const all = [];
  for (let start = 0; start < 20000; start += 1000) {
    const data = await baiduJson(`${BAIDU_PAN}/rest/2.0/xpan/file?${new URLSearchParams({ method: 'list', access_token: token, dir, order: 'name', start: String(start), limit: '1000', web: '0' })}`);
    const list = data.list || [];
    all.push(...list.map((f) => ({ fsid: String(f.fs_id), name: f.server_filename, path: f.path, size: f.size || 0, isDir: f.isdir === 1, mtime: (f.server_mtime || 0) * 1000 })));
    if (list.length < 1000) break;
  }
  return all.sort((a, b) => (b.isDir - a.isDir) || naturalCmp(a.name, b.name));
}

async function baiduApi(req, res, seg, q, lib) {
  const M = req.method;
  const c = lib.cloud.baidu || (lib.cloud.baidu = {});
  try {
    if (!seg.length && M === 'GET') {
      const app = baiduApp(lib);
      return json(res, 200, {
        configured: !!(app.key && app.secret), ownApp: app.own, appKey: app.own ? c.appKey : '', serverApp: !!(BAIDU_APP_KEY && BAIDU_SECRET_KEY),
        connected: !!c.accessToken, name: c.name || '', avatar: c.avatar || '', quota: c.quota || null,
      });
    }
    if (seg[0] === 'app' && M === 'PUT') { // 自己的应用：AppKey + SecretKey
      const body = await readJson(req);
      const key = str(body.appKey, 100), secret = str(body.secretKey, 100);
      if (!key || !secret) return fail(res, 400, 'AppKey 和 SecretKey 都要填');
      if (key !== c.appKey) Object.assign(c, { accessToken: '', refreshToken: '', expiresAt: 0, name: '', avatar: '' });
      c.appKey = key; c.secretKey = secret; save();
      return json(res, 200, { ok: true });
    }
    if (!seg.length && M === 'DELETE') { // 断开：只清令牌，保留应用信息
      Object.assign(c, { accessToken: '', refreshToken: '', expiresAt: 0, name: '', avatar: '', quota: null, device: null }); save();
      return json(res, 200, { ok: true });
    }
    if (seg[0] === 'device' && M === 'POST') { // 第一步：要用户码和二维码
      const app = baiduApp(lib);
      if (!app.key) return fail(res, 400, '先填好百度网盘应用的 AppKey 和 SecretKey');
      const r = await baiduFetch(`${BAIDU_OPENAPI}/oauth/2.0/device/code?${new URLSearchParams({ response_type: 'device_code', client_id: app.key, scope: 'basic,netdisk' })}`);
      const d = await r.json().catch(() => ({}));
      if (!d.device_code) return fail(res, 400, `百度没有给出授权码：${d.error_description || d.error || r.status}（检查 AppKey 是否正确）`);
      c.device = { code: d.device_code, expiresAt: Date.now() + (d.expires_in || 1800) * 1000 };
      return json(res, 200, {
        userCode: d.user_code, qrcodeUrl: d.qrcode_url, interval: d.interval || 5, expiresIn: d.expires_in || 1800,
        verificationUrl: `https://openapi.baidu.com/device?display=mobile&code=${encodeURIComponent(d.user_code)}`,
      });
    }
    if (seg[0] === 'poll' && M === 'POST') { // 第二步：用户同意了没有
      if (!c.device || c.device.expiresAt < Date.now()) return json(res, 200, { status: 'expired' });
      const app = baiduApp(lib);
      const t = await baiduOAuth({ grant_type: 'device_token', code: c.device.code, client_id: app.key, client_secret: app.secret });
      if (t.error === 'authorization_pending' || t.error === 'slow_down') return json(res, 200, { status: 'pending' });
      if (!t.access_token) return json(res, 200, { status: 'failed', message: t.error_description || t.error || '授权失败' });
      keepTokens(c, t); c.device = null;
      try {
        const u = await baiduJson(`${BAIDU_PAN}/rest/2.0/xpan/nas?method=uinfo&access_token=${encodeURIComponent(c.accessToken)}`);
        c.name = u.netdisk_name || u.baidu_name || ''; c.avatar = u.avatar_url || '';
        const qd = await baiduJson(`${BAIDU_PAN}/api/quota?access_token=${encodeURIComponent(c.accessToken)}`).catch(() => null);
        if (qd) c.quota = { used: qd.used, total: qd.total };
      } catch { /* 用户信息拿不到不影响使用 */ }
      save();
      return json(res, 200, { status: 'ok', name: c.name });
    }
    if (seg[0] === 'list' && M === 'GET') {
      const dir = q.get('dir') || '/';
      return json(res, 200, { dir, items: await baiduList(lib, dir) });
    }
    if (seg[0] === 'direct' && M === 'POST') { // 给客户端几个短时效的直连地址（整本书一个，图片文件夹每页一个）
      const body = await readJson(req);
      const book = lib.books[str(body.bookId, 40)];
      if (!book?.source) return fail(res, 404, '没有这本书');
      let targets;
      if (book.source.type === 'baidu') targets = [{ key: 'file', fsid: book.source.fsid, size: book.size }];
      else {
        const pages = lib.cloudPages[book.id] || [];
        const want = (Array.isArray(body.pages) ? body.pages : []).map(Number).filter((n) => Number.isInteger(n) && pages[n]).slice(0, 12);
        targets = want.map((n) => ({ key: String(n), fsid: pages[n].fsid, size: pages[n].size }));
        await baiduPrefetch(lib, targets.map((t) => t.fsid)).catch(() => {});
      }
      const items = [];
      for (const t of targets) {
        try { items.push({ key: t.key, url: await baiduDirect(lib, t.fsid), size: t.size, ttl: DIRECT_TTL }); }
        catch (e) { items.push({ key: t.key, error: e.code === 'no-direct' ? 'no-direct' : 'failed', message: e.message }); }
      }
      res.setHeader('Cache-Control', 'no-store');
      return json(res, 200, { items });
    }
    if (seg[0] === 'add' && M === 'POST') { // 把网盘里的文件 / 图片文件夹放上书架（不下载、不占服务器空间）
      const body = await readJson(req, 512 * 1024);
      const added = [];
      const now = Date.now();
      for (const it of (Array.isArray(body.items) ? body.items : []).slice(0, 200)) {
        const base = {
          id: newId(), author: '', illustrator: '', publisher: '', status: '', rating: 0, review: '', description: '',
          series: str(it.series, 200), volume: volumeOf(it.volume), collections: (Array.isArray(body.collections) ? body.collections : []).filter((x) => lib.collections[x]),
          hasCover: false, addedAt: now, updatedAt: now,
        };
        if (it.kind === 'file') {
          const ext = String(it.name || '').split('.').pop().toLowerCase();
          const format = ext === 'epub' ? 'epub' : (ext === 'cbz' || ext === 'zip') ? 'cbz' : '';
          if (!format || !it.fsid) continue;
          const dup = Object.values(lib.books).find((b) => b.source?.fsid === String(it.fsid));
          if (dup) { added.push({ book: dup, duplicate: true }); continue; }
          const book = { ...base, format, size: Number(it.size) || 0, title: str(it.title, 500) || String(it.name).replace(/\.[^.]+$/, ''), fileName: str(it.name), source: { type: 'baidu', fsid: String(it.fsid), path: str(it.path, 2000) } };
          lib.books[book.id] = book; added.push({ book });
        } else if (it.kind === 'dir') {
          const dir = str(it.path, 2000);
          const dup = Object.values(lib.books).find((b) => b.source?.type === 'baidu-dir' && b.source.path === dir);
          if (dup) { added.push({ book: dup, duplicate: true }); continue; }
          const pages = (await baiduList(lib, dir)).filter((f) => !f.isDir && IMAGE_RE.test(f.name)).slice(0, 5000);
          if (!pages.length) continue;
          const book = { ...base, format: 'cbz', size: pages.reduce((n, p) => n + p.size, 0), title: str(it.title, 500) || dir.split('/').pop(), fileName: dir.split('/').pop(), source: { type: 'baidu-dir', path: dir, count: pages.length } };
          lib.books[book.id] = book;
          lib.cloudPages[book.id] = pages.map((p) => ({ fsid: p.fsid, name: p.name, size: p.size }));
          added.push({ book });
        }
      }
      save();
      return json(res, 200, { added });
    }
    return fail(res, 404, '没有这个接口');
  } catch (e) {
    if (e instanceof BaiduError) return fail(res, e.status, e.message);
    throw e;
  }
}

async function api(req, res, url) {
  const seg = url.pathname.split('/').filter(Boolean).slice(1); // 去掉 "api"
  const M = req.method;
  const q = url.searchParams;

  if (seg[0] === 'ping' && M === 'GET') {
    return json(res, 200, { ok: true, name: 'susuko-bunko', version: VERSION, accounts: true, users: Object.keys(db.users).length, openSignup: OPEN_SIGNUP });
  }
  if (seg[0] === 'auth') return auth(req, res, seg);

  const user = userOf(req);
  if (!user) return fail(res, 401, '登录已失效，请重新登录');
  const lib = db.libs[user.id] || (db.libs[user.id] = emptyLib());
  for (const [k, v] of Object.entries(emptyLib())) if (!(k in lib)) lib[k] = v; // 旧书库补上新字段

  if (seg[0] === 'me') {
    if (seg.length === 1 && M === 'GET') return json(res, 200, { user: publicUser(user) });
    if (seg.length === 1 && M === 'PATCH') {
      const body = await readJson(req);
      if (typeof body.nickname === 'string' && str(body.nickname, 40)) user.nickname = str(body.nickname, 40);
      if (body.newPassword !== undefined) {
        if (typeof body.oldPassword !== 'string' || !safeEqual(hashPassword(body.oldPassword, user.salt), user.hash)) return fail(res, 403, '原密码不对');
        if (typeof body.newPassword !== 'string' || body.newPassword.length < 6) return fail(res, 400, '新密码至少 6 位');
        user.salt = crypto.randomBytes(16).toString('hex');
        user.hash = hashPassword(body.newPassword, user.salt);
      }
      save();
      return json(res, 200, { user: publicUser(user) });
    }
    // 账号设置（阅读器排版、主题色、阅读助手接口等）：整份覆盖，以较新的为准
    if (seg[1] === 'settings' && M === 'GET') return json(res, 200, { settings: lib.settings });
    if (seg[1] === 'settings' && M === 'PUT') {
      const body = await readJson(req, 256 * 1024);
      if (!body.data || typeof body.data !== 'object') return fail(res, 400, '设置格式不对');
      const updatedAt = Math.min(Number(body.updatedAt) || Date.now(), Date.now() + 60000);
      if (!lib.settings || updatedAt >= lib.settings.updatedAt) { lib.settings = { data: body.data, updatedAt }; save(); }
      return json(res, 200, { settings: lib.settings });
    }
    if (seg[1] === 'avatar' && (M === 'GET' || M === 'HEAD')) return sendFile(req, res, avatarFile(user.id), 'image/jpeg');
    if (seg[1] === 'avatar' && M === 'PUT') {
      const buf = await readBody(req, 2 * 1024 * 1024);
      if (!buf.length) return fail(res, 400, '空图片');
      await fsp.writeFile(avatarFile(user.id), buf);
      user.avatarAt = Date.now(); save();
      return json(res, 200, { user: publicUser(user) });
    }
  }

  if (seg[0] === 'state' && M === 'GET') {
    const { cloud, cloudPages, ...rest } = lib;
    return json(res, 200, { ...rest, user: publicUser(user), serverTime: Date.now() });
  }
  if (seg[0] === 'cloud' && seg[1] === 'baidu') return baiduApi(req, res, seg.slice(2), q, lib);
  if (seg[0] === 'novelia') return novelia.handle(req, res, seg.slice(1), q, lib, { json, fail, readJson, save, str });
  if (seg[0] === 'ai' && M === 'POST') return aiProxy(req, res);
  if (seg[0] === 'meta' && seg[1] === 'lookup' && M === 'POST') { // 自动查作品资料
    const body = await readJson(req, 64 * 1024);
    let ai = null;
    if (body.ai?.url) { try { const u = new URL(body.ai.url); if (/^https?:$/.test(u.protocol)) ai = { url: u.href, key: str(body.ai.key, 300), model: str(body.ai.model, 100) }; } catch { /* 地址不对就不用模型 */ } }
    try {
      return json(res, 200, await meta.lookup({
        query: str(body.query, 200), kind: body.kind, author: str(body.author, 100),
        bangumiToken: str(body.bangumiToken, 200), dsKey: str(body.dsKey, 200), ai,
      }));
    } catch (e) { return fail(res, e.status === 400 ? 400 : 502, e.message); }
  }

  if (seg[0] === 'books') {
    if (seg.length === 1 && M === 'POST') return uploadBook(req, res, q, lib);
    const book = isId(seg[1] || '') ? lib.books[seg[1]] : null;
    if (!book) return fail(res, 404, '没有这本书');

    if (seg.length === 2 && M === 'PATCH') {
      patchBook(book, await readJson(req), lib); save();
      return json(res, 200, { book });
    }
    if (seg.length === 2 && M === 'DELETE') {
      delete lib.books[book.id]; delete lib.progress[book.id]; delete lib.marks[book.id]; delete lib.cloudPages[book.id]; save();
      if (!book.source) await fsp.rm(bookFile(book), { force: true }); // 网盘里的书只删书架上的记录，网盘文件不动
      await fsp.rm(coverFile(book.id), { force: true });
      return json(res, 200, { ok: true });
    }
    if (book.source?.type === 'baidu' && seg[2] === 'file' && (M === 'GET' || M === 'HEAD')) return baiduStream(req, res, lib, book.source.fsid, book.fileName);
    if (book.source?.type === 'baidu-dir' && seg[2] === 'pages' && M === 'GET') {
      return json(res, 200, { pages: (lib.cloudPages[book.id] || []).map((p) => ({ name: p.name, size: p.size })) });
    }
    if (book.source?.type === 'baidu-dir' && seg[2] === 'page' && M === 'GET') {
      const all = lib.cloudPages[book.id] || [], n = Number(seg[3]);
      const pg = all[n];
      if (!pg) return fail(res, 404, '没有这一页');
      // 一次向百度要后面几十页的下载地址，翻页时就不用一页问一次
      if (!dlinkCache.has(pg.fsid)) await baiduPrefetch(lib, all.slice(Math.max(0, n - 4), n + 60).map((p) => p.fsid)).catch(() => {});
      return baiduStream(req, res, lib, pg.fsid, pg.name, true);
    }
    if (seg[2] === 'file' && (M === 'GET' || M === 'HEAD')) {
      return sendFile(req, res, bookFile(book), 'application/octet-stream', book.fileName || `${book.title}.${book.format}`);
    }
    if (seg[2] === 'cover' && (M === 'GET' || M === 'HEAD')) return sendFile(req, res, coverFile(book.id), 'image/jpeg');
    if (seg[2] === 'cover' && M === 'PUT') {
      const buf = await readBody(req, 4 * 1024 * 1024);
      if (!buf.length) return fail(res, 400, '空封面');
      await fsp.writeFile(coverFile(book.id), buf);
      book.hasCover = true; book.coverAt = Date.now(); book.updatedAt = Date.now(); save();
      return json(res, 200, { book });
    }
  }

  if (seg[0] === 'collections') {
    if (seg.length === 1 && M === 'POST') {
      const body = await readJson(req);
      const name = str(body.name, 60);
      if (!name) return fail(res, 400, '合集需要一个名字');
      const now = Date.now();
      const order = Object.values(lib.collections).reduce((m, c) => Math.max(m, c.order), 0) + 1;
      const col = { id: newId(), name, order, createdAt: now, updatedAt: now };
      lib.collections[col.id] = col; save();
      return json(res, 201, { collection: col });
    }
    const col = isId(seg[1] || '') ? lib.collections[seg[1]] : null;
    if (!col) return fail(res, 404, '没有这个合集');
    if (M === 'PATCH') {
      const body = await readJson(req);
      if (typeof body.name === 'string' && str(body.name, 60)) col.name = str(body.name, 60);
      if (Number.isFinite(body.order)) col.order = body.order;
      col.updatedAt = Date.now(); save();
      return json(res, 200, { collection: col });
    }
    if (M === 'DELETE') { // 只删合集，不删书
      delete lib.collections[col.id];
      for (const b of Object.values(lib.books)) {
        if (b.collections.includes(col.id)) { b.collections = b.collections.filter((c) => c !== col.id); b.updatedAt = Date.now(); }
      }
      save();
      return json(res, 200, { ok: true });
    }
  }

  if (seg[0] === 'progress' && seg.length === 2 && M === 'PUT') {
    if (!lib.books[seg[1]]) return fail(res, 404, '没有这本书');
    const body = await readJson(req);
    const incoming = {
      loc: body.loc && typeof body.loc === 'object' ? body.loc : {},
      percent: Math.min(1, Math.max(0, Number(body.percent) || 0)),
      updatedAt: Math.min(Number(body.updatedAt) || Date.now(), Date.now() + 60000),
      device: str(body.device, 40),
    };
    if (JSON.stringify(incoming.loc).length > 2000) return fail(res, 400, '进度数据过大');
    const cur = lib.progress[seg[1]];
    if (!cur || incoming.updatedAt >= cur.updatedAt) { lib.progress[seg[1]] = incoming; save(); } // 以最新时间为准
    return json(res, 200, { progress: lib.progress[seg[1]] });
  }

  // 书签、页笔记、划线批注：每条由客户端生成 id，整条覆盖写入
  if (seg[0] === 'marks' && seg.length === 3 && /^[a-f0-9]{8,32}$/.test(seg[2])) {
    if (!lib.books[seg[1]]) return fail(res, 404, '没有这本书');
    const list = lib.marks[seg[1]] || (lib.marks[seg[1]] = {});
    if (M === 'PUT') {
      const body = await readJson(req);
      const mark = {
        id: seg[2], type: MARK_TYPES.has(body.type) ? body.type : 'bookmark',
        loc: body.loc && typeof body.loc === 'object' ? body.loc : {},
        percent: Math.min(1, Math.max(0, Number(body.percent) || 0)),
        chapter: str(body.chapter, 200), excerpt: str(body.excerpt, 2000), text: str(body.text, 5000),
        color: str(body.color, 16),
        createdAt: Number(body.createdAt) || Date.now(), updatedAt: Date.now(),
      };
      if (JSON.stringify(mark.loc).length > 2000) return fail(res, 400, '位置数据过大');
      if (!list[mark.id] && Object.keys(list).length >= 5000) return fail(res, 400, '这本书的记号太多了');
      list[mark.id] = mark; save();
      return json(res, 200, { mark });
    }
    if (M === 'DELETE') { delete list[seg[2]]; save(); return json(res, 200, { ok: true }); }
  }

  // 系列简介
  if (seg[0] === 'series' && seg.length === 1 && M === 'PUT') {
    const body = await readJson(req);
    const name = str(body.name, 200);
    if (!name) return fail(res, 400, '缺少系列名');
    if (str(body.description, 8000)) lib.series[name] = { description: str(body.description, 8000), updatedAt: Date.now() };
    else delete lib.series[name];
    save();
    return json(res, 200, { series: lib.series[name] || null });
  }

  // 阅读时长：客户端上报增量，服务器按“日期 → 书”累加，多台设备不会互相覆盖
  if (seg[0] === 'stats' && seg.length === 1 && M === 'POST') {
    const body = await readJson(req);
    for (const it of Array.isArray(body.add) ? body.add.slice(0, 2000) : []) {
      const seconds = Math.round(Number(it.seconds));
      if (!/^\d{4}-\d{2}-\d{2}$/.test(it.day) || !lib.books[it.book] || !(seconds > 0) || seconds > 86400) continue;
      const day = lib.stats[it.day] || (lib.stats[it.day] = {});
      day[it.book] = Math.min(86400, (day[it.book] || 0) + seconds);
      if (Number.isInteger(it.hour) && it.hour >= 0 && it.hour < 24) { // 一天里几点在读，统计页的节律图用
        const hrs = lib.hours[it.day] || (lib.hours[it.day] = {});
        hrs[it.hour] = Math.min(3600, (hrs[it.hour] || 0) + seconds);
      }
    }
    save();
    return json(res, 200, { ok: true });
  }

  fail(res, 404, '接口不存在');
}

// ---------- 静态文件（网页版客户端） ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};
function serveStatic(req, res, url) {
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch { return fail(res, 400, '路径错误'); }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.join(APP_DIR, rel);
  if (file !== APP_DIR && !file.startsWith(APP_DIR + path.sep)) return fail(res, 403, '禁止访问');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Content-Length': st.size, 'Cache-Control': 'no-cache',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

http.createServer(async (req, res) => {
  cors(res);
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { return fail(res, 400, '地址错误'); }
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, '不支持的方法');
    serveStatic(req, res, url);
  } catch (e) {
    if (!e.code) console.error(e);
    if (!res.headersSent) fail(res, typeof e.code === 'number' ? e.code : 500, e.message || '服务器出错');
    else res.destroy();
  }
}).listen(PORT, HOST, () => {
  console.log(`スス子文庫 服务端 ${VERSION} 已启动：http://${HOST}:${PORT}  数据目录：${DATA_DIR}`);
});
