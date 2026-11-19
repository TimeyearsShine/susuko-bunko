// waifu2x 画质增强要用的文件：onnxruntime-web 运行库 + waifu2x 的 ONNX 模型。
// 客户端（浏览器 / App 里的 Web Worker）自己跑模型，服务器只负责第一次用到时从上游下载一份、
// 存进数据目录，之后都从这里发。这样各台设备不用各自翻墙下载，也不用把几十 MB 的文件打进安装包。
//
// 模型来自 nagadomi/nunif（MIT 许可），默认从 Hugging Face 上的 deepghs/waifu2x_onnx 镜像取；
// 运行库默认从 jsDelivr 取。下不动的话可以用环境变量换镜像，或者把文件手动放进
//   数据目录/waifu2x/ort/       （ort.webgpu.min.mjs、ort-wasm-*.mjs / .wasm 等）
//   数据目录/waifu2x/models/    （swin_unet/art_scan/noise3.onnx 这样的目录结构）
//   WAIFU2X_ORT_BASE    运行库地址（默认 jsDelivr 上的 onnxruntime-web@ORT_VERSION/dist）
//   WAIFU2X_MODEL_BASE  模型地址（默认 Hugging Face deepghs/waifu2x_onnx 的 20230504 版）
'use strict';
const fs = require('fs');
const path = require('path');

const ORT_VERSION = '1.20.1';
const ORT_BASE = (process.env.WAIFU2X_ORT_BASE || `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist`).replace(/\/+$/, '');
const MODEL_BASE = (process.env.WAIFU2X_MODEL_BASE || 'https://huggingface.co/deepghs/waifu2x_onnx/resolve/main/20230504/onnx_models').replace(/\/+$/, '');

// 只放行这些文件，免得服务器被当成任意下载的跳板
const MODELS = new Set();
for (const n of [0, 1, 2, 3]) {
  MODELS.add(`swin_unet/art_scan/noise${n}.onnx`);
  MODELS.add(`swin_unet/art/noise${n}.onnx`);
  MODELS.add(`cunet/art/noise${n}.onnx`);
}
const ORT_FILE = /^ort[\w.-]*\.(mjs|js|wasm)$/;
const TYPES = { '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.wasm': 'application/wasm', '.onnx': 'application/octet-stream' };

function createWaifu2x({ dataDir, fail }) {
  const DIR = path.join(dataDir, 'waifu2x');
  const pending = new Map();

  async function download(url, file) {
    if (pending.has(file)) return pending.get(file);
    const job = (async () => {
      let res;
      try { res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'susuko-bunko (self-hosted reader)' } }); }
      catch { throw Object.assign(new Error(`服务器连不上下载地址：${new URL(url).host}（可以设置 WAIFU2X_ORT_BASE / WAIFU2X_MODEL_BASE 换镜像，或手动放文件）`), { code: 502 }); }
      if (!res.ok) throw Object.assign(new Error(`下载失败（上游返回 ${res.status}）：${url}`), { code: 502 });
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) throw Object.assign(new Error('下载到的文件是空的'), { code: 502 });
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.part`;
      await fs.promises.writeFile(tmp, buf);
      await fs.promises.rename(tmp, file);
    })();
    pending.set(file, job);
    try { await job; } finally { pending.delete(file); }
  }

  function send(req, res, file) {
    fs.stat(file, (err, st) => {
      if (err) return fail(res, 404, '文件不存在');
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
        'Content-Length': st.size,
        // 文件名里没有版本号，但同一个名字的内容不会变（换版本时换 ORT_VERSION / 模型目录）
        'Cache-Control': 'public, max-age=2592000',
        'Cross-Origin-Resource-Policy': 'cross-origin',
      });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).pipe(res);
    });
  }

  // GET /w2x/ort/<文件>、/w2x/models/<arch>/<style>/<noiseN>.onnx。不需要登录：内容都是公开的开源文件
  async function route(req, res, url) {
    const rel = decodeURIComponent(url.pathname.slice('/w2x/'.length));
    let file, upstream;
    if (rel.startsWith('ort/') && ORT_FILE.test(rel.slice(4))) {
      file = path.join(DIR, 'ort', ORT_VERSION, rel.slice(4));
      upstream = `${ORT_BASE}/${rel.slice(4)}`;
    } else if (rel.startsWith('models/') && MODELS.has(rel.slice(7))) {
      file = path.join(DIR, 'models', ...rel.slice(7).split('/'));
      upstream = `${MODEL_BASE}/${rel.slice(7)}`;
    } else return fail(res, 404, '没有这个文件');
    // 手动放进去的（不带版本号目录）也认
    const manual = rel.startsWith('ort/') ? path.join(DIR, 'ort', rel.slice(4)) : null;
    if (manual && fs.existsSync(manual)) return send(req, res, manual);
    if (!fs.existsSync(file)) await download(upstream, file);
    send(req, res, file);
  }

  return { route, ORT_VERSION };
}

module.exports = { createWaifu2x };
