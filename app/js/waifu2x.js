// 漫画画质增强（waifu2x 降噪）：后台线程排队处理“当前页 + 后面 10 页”，处理好的页自动替换上去。
// 模型和运行库由自己的服务器提供（见 server/waifu2x.js），只在第一次用到时下载。
export const W2X_MODES = {
  scan: { model: 'swin_unet/art_scan/noise3', label: '高画质', sub: '扫描漫画模型（swin_unet art_scan），降噪 3 级' },
  fast: { model: 'cunet/art/noise3', label: '快速', sub: 'CUNet 模型，降噪 3 级，速度快一些' },
};
export const W2X_AHEAD = 10;

export function w2xSupported() {
  return typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap !== 'undefined' && typeof WebAssembly !== 'undefined';
}

/**
 * server：服务器地址；mode：W2X_MODES 的键；getBlob(i) → Promise<Blob>；onDone(i, url)；onStatus(status)
 */
export function createW2x({ server, mode, getBlob, onDone, onStatus }) {
  const model = W2X_MODES[mode].model;
  const worker = new Worker(new URL('./waifu2x-worker.js', import.meta.url), { type: 'module' });
  const done = new Map();     // 页 → objectURL
  const skipped = new Set();  // 太大、处理失败的页，不再排队
  let queue = [], running = null, seq = 0, dead = false;
  const status = { backend: '', done: 0, queued: 0, running: null, lastMs: 0, error: '' };
  const emit = () => { status.done = done.size; status.queued = queue.length; status.running = running?.page ?? null; onStatus?.({ ...status }); };

  worker.onmessage = ({ data }) => {
    const job = running;
    if (!job || data.id !== job.id) return;
    running = null;
    if (data.backend) status.backend = data.backend;
    if (data.blob) {
      const url = URL.createObjectURL(data.blob);
      done.set(job.page, url);
      status.lastMs = data.ms;
      onDone?.(job.page, url);
    } else if (data.skipped) skipped.add(job.page);
    else if (data.error && data.error !== 'cancelled') {
      skipped.add(job.page);
      // 运行库或模型都下不来，再试也没用，直接停掉
      if (/下载|import|fetch|Failed to/i.test(data.error) && !done.size) { status.error = data.error; dead = true; queue = []; }
    }
    emit(); pump();
  };
  worker.onerror = (e) => { status.error = e.message || '后台线程出错'; dead = true; running = null; queue = []; emit(); };

  async function pump() {
    if (running || dead || !queue.length) return;
    const page = queue.shift();
    const job = running = { id: ++seq, page };
    emit();
    let blob;
    try { blob = await getBlob(page); } catch { blob = null; }
    if (running !== job) return;
    if (!blob) { running = null; skipped.add(page); pump(); return; }
    worker.postMessage({ type: 'run', id: job.id, blob, model, server });
  }

  return {
    get status() { return { ...status }; },
    url: (i) => done.get(i),
    // 以 page 为起点重新排队：当前页最先，然后往后 10 页；离开窗口的任务取消、结果释放
    focus(page, total) {
      if (dead) return;
      const want = [];
      for (let i = page; i < Math.min(total, page + W2X_AHEAD + 1); i++) if (!done.has(i) && !skipped.has(i)) want.push(i);
      queue = want.filter((i) => i !== running?.page);
      if (running && (running.page < page - 1 || running.page > page + W2X_AHEAD)) {
        worker.postMessage({ type: 'cancel', id: running.id });
        running = null;
      }
      for (const [i, url] of done) {
        if (i < page - 4 || i > page + W2X_AHEAD + 2) { done.delete(i); URL.revokeObjectURL(url); }
      }
      emit(); pump();
    },
    destroy() {
      dead = true; queue = []; running = null;
      worker.terminate();
      for (const url of done.values()) URL.revokeObjectURL(url);
      done.clear();
    },
  };
}
