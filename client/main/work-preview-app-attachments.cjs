'use strict';

// App pages receive opaque IDs only. Disk-backed selections stay in place until
// the ordinary conversation attachment pipeline copies them at send time.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const states = new WeakMap(), leases = new Map(), watched = new WeakSet();
const appOwner = require('./work-preview-app-owner.cjs');
const MAX_FILES = 20, MAX_BYTES = 256 * 1024 * 1024, CHUNK_BYTES = 1024 * 1024;
const prefix = 'app-input:';
const mimeTypes = { '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.mp4':'video/mp4','.mov':'video/quicktime','.webm':'video/webm','.mp3':'audio/mpeg','.wav':'audio/wav','.pdf':'application/pdf','.txt':'text/plain','.md':'text/markdown','.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
const safeName = value => (path.basename(String(value || 'attachment')).replace(/[\x00-\x1f<>:"/\\|?*]/g, '_').slice(0, 180) || 'attachment');
const publicRow = row => ({ id: row.id, name: row.name, type: row.type, size: row.size });

function state(item) {
  appOwner.assertCurrent(item);
  let value = states.get(item);
  if (value) return value;
  value = { rows: new Map(), closed: false, tail: Promise.resolve(), dir: '', picking: false,
    assertActive: () => appOwner.assertCurrent(item) };
  states.set(item, value);
  const wc = item.view?.webContents;
  if (wc && !watched.has(item)) {
    watched.add(item);
    wc.once('destroyed', () => { void dispose(item).catch(() => {}); });
    wc.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) void dispose(item).catch(() => {});
    });
  }
  return value;
}
function serial(value, action) {
  const result = value.tail.then(action);
  value.tail = result.catch(() => {});
  return result;
}
function checkOpen(value) { value.assertActive(); if (value.closed) throw Error('应用页面已关闭，请重新选择附件'); }
function capacity(value, count, bytes) {
  const rows = [...value.rows.values()];
  if (rows.length + count > MAX_FILES || rows.reduce((sum, row) => sum + row.size, 0) + bytes > MAX_BYTES)
    throw Error('最多选择20个文件，附件总大小不能超过256 MB');
}
async function sweep(value) {
  for (const [id, row] of value.rows) {
    if (!row.removed || row.pins) continue;
    if (row.temporary) await fs.unlink(row.path).catch(error => { if (error.code !== 'ENOENT') throw error; });
    value.rows.delete(id);
  }
  if (value.dir && ![...value.rows.values()].some(row => row.temporary)) {
    await fs.rmdir(value.dir).catch(error => { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error; });
    value.dir = '';
  }
}
async function dispose(item) {
  const value = states.get(item);
  if (!value) return;
  value.closed = true;
  states.delete(item);
  return serial(value, async () => { for (const row of value.rows.values()) row.removed = true; await sweep(value); });
}
function ids(value) {
  if (!Array.isArray(value) || value.length > MAX_FILES || new Set(value).size !== value.length ||
      value.some(id => typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id))) throw Error('附件引用无效');
  return value;
}
async function inspect(value, attachmentIds) {
  checkOpen(value);
  const rows = ids(attachmentIds).map(id => {
    const row = value.rows.get(id);
    if (!row || row.removed || !row.ready) throw Error('附件引用已失效或尚未准备好，请重新选择');
    return row;
  });
  for (const row of rows) {
    const handle = await fs.open(row.path, 'r').catch(() => { throw Error('无法读取附件：' + row.name); });
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== row.size || stat.mtimeMs !== row.mtime)
        throw Error('附件已经变化，请重新选择：' + row.name);
    } finally { await handle.close(); }
  }
  checkOpen(value);
  return rows;
}
async function handle(item, method, params, deps = {}) {
  try {
    const value = state(item);
    if (method === 'attachments.pick') {
      checkOpen(value);
      if (value.picking) throw Error('文件选择窗口已打开');
      value.picking = true;
      try {
        const dialog = deps.dialog || require('electron').dialog;
        const win = item.appWindowRoot?.detachedWin || item.detachedWin;
        const options = { properties: ['openFile', 'multiSelections'] };
        const picked = win && !win.isDestroyed() ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
        return await serial(value, async () => {
          checkOpen(value);
          if (picked.canceled) return { ok: true, items: [] };
          const rows = [];
          for (const file of picked.filePaths || []) {
            const stat = await fs.stat(file);
            if (!stat.isFile()) throw Error('请选择文件');
            rows.push({ id: randomUUID(), name: safeName(file), path: file, type: mimeTypes[path.extname(file).toLowerCase()] || 'application/octet-stream', size: stat.size, mtime: stat.mtimeMs, ready: true, pins: 0 });
          }
          checkOpen(value);
          capacity(value, rows.length, rows.reduce((sum, row) => sum + row.size, 0));
          rows.forEach(row => value.rows.set(row.id, row));
          return { ok: true, items: rows.map(publicRow) };
        });
      } finally { value.picking = false; }
    }
    return await serial(value, async () => {
      checkOpen(value);
      if (method === 'attachments.begin') {
        capacity(value, 1, params.size);
        value.dir ||= await fs.mkdtemp(path.join(os.tmpdir(), 'soduwork-app-inputs-'));
        checkOpen(value);
        const id = randomUUID(), target = path.join(value.dir, id + '-' + safeName(params.name));
        await fs.writeFile(target, Buffer.alloc(0), { flag: 'wx', mode: 0o600 });
        try { checkOpen(value); } catch (error) { await fs.unlink(target); throw error; }
        const row = { id, name: safeName(params.name), type: params.type, size: params.size, path: target, written: 0, temporary: true, pins: 0, ready: false };
        value.rows.set(id, row);
        return { ok: true, id, chunkBytes: CHUNK_BYTES };
      }
      if (method === 'attachments.release') {
        for (const id of ids(params.ids)) { const row = value.rows.get(id); if (row) row.removed = true; }
        await sweep(value);
        checkOpen(value);
        return { ok: true };
      }
      if (method === 'attachments.check') {
        const rows = await inspect(value, params.ids);
        return { ok: true, items: rows.map(publicRow) };
      }
      const row = value.rows.get(params.id);
      if (!row || row.removed || !row.temporary || row.ready) throw Error('暂存附件已失效');
      if (method === 'attachments.append') {
        const data = Buffer.from(params.data);
        if (params.offset !== row.written || data.length > CHUNK_BYTES || row.written + data.length > row.size) throw Error('附件分块顺序或大小无效');
        await fs.appendFile(row.path, data);
        checkOpen(value);
        row.written += data.length;
        return { ok: true, written: row.written };
      }
      if (method === 'attachments.finish') {
        if (row.written !== row.size) throw Error('附件尚未传输完整');
        row.mtime = (await fs.stat(row.path)).mtimeMs;
        checkOpen(value);
        row.ready = true;
        return { ok: true, item: publicRow(row) };
      }
      throw Error('附件方法未开放');
    });
  } catch (error) { return { ok: false, reason: error.code ? '无法读取或暂存附件，请重新选择文件' : error.message }; }
}
async function checkout(item, attachmentIds) {
  const value = state(item);
  return serial(value, async () => {
    const rows = await inspect(value, attachmentIds);
    const token = randomUUID();
    rows.forEach(row => row.pins++);
    const lease = { rows, value, holds: 1 };
    leases.set(token, lease);
    return { files: rows.map(row => ({ name: row.name, size: row.size, type: row.type, path: row.path, attachmentId: row.id, sourceRef: prefix + token, ...(row.temporary ? {appTemporary:true} : {}) })),
      release: () => releaseLease(token) };
  });
}
async function releaseLease(token) {
  const lease = leases.get(token);
  if (!lease || --lease.holds) return;
  leases.delete(token);
  return serial(lease.value, async () => { lease.rows.forEach(row => row.pins--); await sweep(lease.value); });
}
// The ordinary copy pipeline holds its own lease, even if the composer is
// destroyed while its already admitted IPC is copying a large video.
function protect(files) {
  const tokens = new Set();
  for (const file of Array.isArray(files) ? files : []) {
    if (!file) continue;
    if (!String(file.sourceRef || '').startsWith(prefix)) continue;
    const token = file.sourceRef.slice(prefix.length), lease = leases.get(token);
    if (!lease || !lease.rows.some(row => row.id === file.attachmentId && row.path === file.path)) throw Error('应用附件交接已失效');
    tokens.add(token);
  }
  tokens.forEach(token => leases.get(token).holds++);
  return async () => { for (const token of tokens) await releaseLease(token); };
}
module.exports = { handle, checkout, protect, dispose, ids, limits: { MAX_FILES, MAX_BYTES, CHUNK_BYTES } };
