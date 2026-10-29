'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');

// Only a type crosses IPC. Never inspect a renderer-supplied local file or URL.
function normalize(type) {
  if (type === '$folder' || type === '') return type;
  const value = typeof type === 'string' ? type.toLowerCase() : '';
  return /^[a-z0-9][a-z0-9_-]{0,15}$/.test(value) ? value : '';
}

function createService({ app, platform = process.platform, timeoutMs = 2500 }) {
  const cache = new Map(), pending = new Map();
  let markerDirectory;
  const namespace = 'soduwork-file-type-icons-' + randomUUID();
  async function lookup(type) {
    let timer;
    try {
      const temp = app.getPath('temp');
      let target = temp;
      if (type !== '$folder') {
        // Windows resolves the registered file type without opening a document
        // or its shell extension. An empty, existing PDF can invoke a handler.
        target = path.join(temp, namespace, 'type.' + (type || 'soduwork-unassociated-file'));
        if (platform !== 'win32') {
          markerDirectory ||= fs.mkdtemp(path.join(temp, 'soduwork-file-type-icons-'));
          target = path.join(await markerDirectory, 'type' + (type ? '.' + type : ''));
          await fs.writeFile(target, '', { flag: 'a' });
        }
      }
      const icon = await Promise.race([
        app.getFileIcon(target, { size: 'normal' }),
        new Promise(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); }),
      ]);
      return icon && !icon.isEmpty() ? icon.toDataURL() : '';
    } catch (_) { return ''; }
    finally { clearTimeout(timer); }
  }
  async function get(raw) {
    const type = normalize(raw), saved = cache.get(type);
    if (saved && saved.expires > Date.now()) return saved.result;
    if (pending.has(type)) return pending.get(type);
    const request = (async () => {
      let dataUrl = await lookup(type);
      const fallback = !dataUrl && type !== '';
      if (fallback) dataUrl = (await get('')).dataUrl;
      const result = { ok: Boolean(dataUrl), type, dataUrl, fallback };
      if (dataUrl) {
        if (cache.size >= 256) cache.delete(cache.keys().next().value);
        cache.set(type, { result, expires: Date.now() + (fallback ? 30000 : 3600000) });
      }
      return result;
    })();
    pending.set(type, request);
    try { return await request; } finally { pending.delete(type); }
  }
  return { get };
}

function install({ app, ipcMain }) {
  const service = createService({ app });
  ipcMain.handle('file-type-icon', (_event, type) => service.get(type));
  return service;
}
module.exports = { normalize, createService, install };
