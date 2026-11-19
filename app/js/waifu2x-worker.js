// waifu2x 后台线程：收到一张漫画页（Blob），用 onnxruntime-web 跑降噪模型，回一张处理好的图（Blob）。
// 分块处理的方法照 nagadomi/nunif 的 unlimited_waifu2x（MIT）：边缘复制填充、分块推理、
// 块与块之间 16px 渐变混合消接缝。全部在这个线程里做，翻页、滚动不会被卡住。
const BLEND = 16;
const ARCH = {
  // 输入块大小：swin_unet 要求 (t-16) 同时被 12 和 16 整除；cunet 输出比输入每边少 28px
  swin_unet: { offset: 8, tile: 256 },
  cunet: { offset: 28, tile: 296 },
};
const MAX_PIXELS = 12e6; // 太大的图（比如超长条漫拼图）跳过，内存吃不消

let ort = null, base = '', backend = '';
const sessions = new Map();
let current = null; // 正在处理的任务 id，用于取消

async function init(server) {
  if (ort) return;
  base = server.replace(/\/+$/, '');
  ort = await import(`${base}/w2x/ort/ort.webgpu.min.mjs`);
  ort.env.wasm.wasmPaths = `${base}/w2x/ort/`;
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
  ort.env.logLevel = 'error';
}

async function session(model) {
  if (!sessions.has(model)) {
    sessions.set(model, (async () => {
      const res = await fetch(`${base}/w2x/models/${model}.onnx`);
      if (!res.ok) throw new Error(`模型下载失败（${res.status}）`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const tries = 'gpu' in navigator ? [['webgpu'], ['wasm']] : [['wasm']];
      let lastErr;
      for (const ep of tries) {
        try {
          const s = await ort.InferenceSession.create(bytes, { executionProviders: ep, graphOptimizationLevel: 'all' });
          backend = ep[0];
          return s;
        } catch (e) { lastErr = e; }
      }
      throw lastErr;
    })());
    sessions.get(model).catch(() => sessions.delete(model));
  }
  return sessions.get(model);
}

// RGBA → 加了边的 CHW 浮点数组（边缘像素往外复制）
function padInput(rgba, W, H, left, top, PW, PH) {
  const plane = PW * PH, out = new Float32Array(plane * 3);
  for (let y = 0; y < PH; y++) {
    const sy = Math.min(H - 1, Math.max(0, y - top));
    for (let x = 0; x < PW; x++) {
      const sx = Math.min(W - 1, Math.max(0, x - left));
      const si = (sy * W + sx) * 4, di = y * PW + x;
      out[di] = rgba[si] / 255; out[plane + di] = rgba[si + 1] / 255; out[2 * plane + di] = rgba[si + 2] / 255;
    }
  }
  return out;
}

function crop(src, PW, PH, x0, y0, t) {
  const plane = PW * PH, out = new Float32Array(t * t * 3);
  let single = true;
  const r0 = src[y0 * PW + x0], g0 = src[plane + y0 * PW + x0], b0 = src[2 * plane + y0 * PW + x0];
  for (let c = 0; c < 3; c++) {
    for (let y = 0; y < t; y++) {
      const si = c * plane + (y0 + y) * PW + x0, di = c * t * t + y * t;
      for (let x = 0; x < t; x++) out[di + x] = src[si + x];
    }
  }
  for (let i = 0, n = t * t; i < n && single; i++) {
    if (out[i] !== r0 || out[n + i] !== g0 || out[2 * n + i] !== b0) single = false;
  }
  return { data: out, single: single ? [r0, g0, b0] : null };
}

// 混合权重：中间是 1，往外 16 圈依次减小
function blendFilter(size) {
  const f = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.min(x, y, size - 1 - x, size - 1 - y);
      f[y * size + x] = d >= BLEND ? 1 : 1 - (BLEND - d) / (BLEND + 1);
    }
  }
  return f;
}

async function enhance(id, blob, model) {
  const arch = ARCH[model.split('/')[0]];
  const bmp = await createImageBitmap(blob);
  const W = bmp.width, H = bmp.height;
  if (W * H > MAX_PIXELS || W < 16 || H < 16) { bmp.close(); return null; }
  const cv = new OffscreenCanvas(W, H);
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0); bmp.close();
  const img = ctx.getImageData(0, 0, W, H);
  const ses = await session(model);

  const { offset, tile } = arch;
  const step = tile - (offset * 2 + BLEND); // 相邻两块输入起点的间距
  const outSize = tile - offset * 2;        // 每块输出的边长
  let hb = 0, wb = 0, PH = 0, PW = 0;
  while (PH < H + offset * 2) { PH = hb * step + tile; hb++; }
  while (PW < W + offset * 2) { PW = wb * step + tile; wb++; }
  const input = padInput(img.data, W, H, offset, offset, PW, PH);
  const BH = PH - offset * 2, BW = PW - offset * 2; // 输出缓冲（比原图稍大）
  const pixels = new Float32Array(BH * BW * 3), weights = new Float32Array(BH * BW);
  const filter = blendFilter(outSize);
  const plane = BH * BW, n = outSize * outSize;

  for (let i = 0; i < hb; i++) {
    for (let j = 0; j < wb; j++) {
      if (current !== id) throw new Error('cancelled');
      const { data, single } = crop(input, PW, PH, j * step, i * step, tile);
      let y;
      if (single) {
        y = new Float32Array(n * 3);
        y.fill(single[0], 0, n); y.fill(single[1], n, 2 * n); y.fill(single[2], 2 * n);
      } else {
        const out = await ses.run({ x: new ort.Tensor('float32', data, [1, 3, tile, tile]) });
        const t = out.y || out[Object.keys(out)[0]];
        y = t.data instanceof Float32Array ? t.data : Float32Array.from(t.data);
        t.dispose?.();
      }
      const oy = i * step, ox = j * step;
      for (let yy = 0; yy < outSize; yy++) {
        const row = (oy + yy) * BW + ox, frow = yy * outSize;
        for (let xx = 0; xx < outSize; xx++) {
          const bi = row + xx, fw = filter[frow + xx];
          const old = weights[bi], next = old + fw, keep = old / next, add = 1 - keep;
          const ti = frow + xx;
          pixels[bi] = pixels[bi] * keep + y[ti] * add;
          pixels[plane + bi] = pixels[plane + bi] * keep + y[n + ti] * add;
          pixels[2 * plane + bi] = pixels[2 * plane + bi] * keep + y[2 * n + ti] * add;
          weights[bi] = next;
        }
      }
    }
  }

  const rgba = img.data;
  for (let yy = 0; yy < H; yy++) {
    for (let xx = 0; xx < W; xx++) {
      const bi = yy * BW + xx, di = (yy * W + xx) * 4;
      rgba[di] = Math.round(Math.min(1, Math.max(0, pixels[bi])) * 255);
      rgba[di + 1] = Math.round(Math.min(1, Math.max(0, pixels[plane + bi])) * 255);
      rgba[di + 2] = Math.round(Math.min(1, Math.max(0, pixels[2 * plane + bi])) * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  // 用无损 PNG：有损压缩会把刚去掉的噪点又带回来一些
  return cv.convertToBlob({ type: 'image/png' });
}

self.onmessage = async ({ data }) => {
  if (data.type === 'cancel') { if (current === data.id) current = null; return; }
  if (data.type !== 'run') return;
  current = data.id;
  try {
    await init(data.server);
    const t0 = performance.now();
    const out = await enhance(data.id, data.blob, data.model);
    self.postMessage({ id: data.id, blob: out, skipped: !out, ms: Math.round(performance.now() - t0), backend });
  } catch (e) {
    self.postMessage({ id: data.id, error: e?.message === 'cancelled' ? 'cancelled' : String(e?.message || e), backend });
  } finally {
    if (current === data.id) current = null;
  }
};
