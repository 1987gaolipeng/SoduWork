'use strict';
const cache = new Map(), pending = new Map();
const { signature } = require('./library-index-cache.cjs');
let active = 0;
const waiters = [];
async function create(store, target, nativeImage) {
  store.guard();
  const stat = await store.checkedFile(target);
  if (stat.size > 16 * 1024 * 1024 || !nativeImage?.createThumbnailFromPath) return { ok: true, unavailable: true };
  const key = target + ':' + signature(stat);
  if (cache.has(key)) { const result = cache.get(key); cache.delete(key); cache.set(key, result); return result; }
  if (!pending.has(key)) {
    if (pending.size >= 16) throw Error('LIBRARY_THUMBNAIL_BUSY');
    const task = (async () => {
      if (active >= 2) await new Promise(resolve => waiters.push(resolve));
      else active++;
      try {
        store.guard();
        const image = await nativeImage.createThumbnailFromPath(target, { width: 256, height: 256 });
        store.guard();
        if (signature(await store.checkedFile(target)) !== signature(stat) || image.isEmpty()) return { ok: true, unavailable: true };
        const dimensions = image.getSize();
        // Windows scales height proportionally. Bound the returned buffer too.
        const small = dimensions.height > 256 ? image.resize({ height: 256 }) : image;
        const bytes = small.toPNG();
        if (bytes.length > 512 * 1024) return { ok: true, unavailable: true };
        const result = { ok: true, data: bytes.toString('base64'), mimeType: 'image/png', size: bytes.length };
        cache.set(key, result);
        // At most 32 * 512KiB before base64 (about 21.4MiB encoded), partitioned by absolute
        // account-owned paths; guard and stat are checked even on cache hits.
        while (cache.size > 32) cache.delete(cache.keys().next().value);
        return result;
      } finally {
        if (waiters.length) waiters.shift()(); else active--;
      }
    })().finally(() => pending.delete(key));
    pending.set(key, task);
  }
  // A stalled OS thumbnail provider must not hold the renderer's queue forever.
  // Keep its native execution slot until completion: releasing it on timeout
  // would let repeated requests create unbounded native work.
  let timer;
  try {
    const result = await Promise.race([pending.get(key), new Promise(resolve => {
      timer = setTimeout(() => resolve({ ok: true, unavailable: true }), 30000);
      timer.unref?.();
    })]);
    store.guard(); return result;
  } finally { clearTimeout(timer); }
}
module.exports = { create };
