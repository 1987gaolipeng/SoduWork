'use strict';

// The OS supplies paths; renderers can only claim an existing request ID.
// Nothing is executed, extracted, sent to a model, or made a default file handler.
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { fileURLToPath } = require('node:url');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const { createReadStream, createWriteStream } = require('node:fs');
const MAX_BYTES = 256 * 1024 * 1024;
const PREVIEW = /\.(?:html?|pdf|md|markdown|txt|csv|json|ya?ml|xml|js|jsx|ts|tsx|css|scss|py|java|go|rs|sql|sh|ps1|png|jpe?g|gif|webp|svg|mp4|m4v|webm|mov|ogv)$/i;

function commandFiles(argv, cwd, packaged = true) {
  const args = Array.isArray(argv) ? argv : [];
  const explicit = args.indexOf('--soduwork-open-file');
  const candidates = explicit >= 0 ? args.slice(explicit + 1, explicit + 2)
    : args.slice(packaged ? 1 : 2).filter(value => path.isAbsolute(String(value)));
  return [...new Set(candidates.map(value => {
    let raw = String(value || '');
    if (!raw || /[\x00-\x1f]/.test(raw) || raw.startsWith('-')) return '';
    if (/^file:/i.test(raw)) { try { raw = fileURLToPath(raw); } catch { return ''; } }
    if (!path.isAbsolute(raw) && explicit < 0) return '';
    return path.resolve(cwd || process.cwd(), raw);
  }).filter(Boolean))].slice(0, 20);
}

function instanceData(argv, cwd, packaged = true) {
  // Capture the original arguments in the launching process. Chromium can move
  // switches ahead of positional arguments before emitting second-instance.
  return { soduworkOpenFiles: { version: 1, files: commandFiles(argv, cwd, packaged) } };
}

function instanceFiles(argv, cwd, packaged = true, additionalData) {
  if (additionalData && Object.prototype.hasOwnProperty.call(additionalData, 'soduworkOpenFiles')) {
    const request = additionalData.soduworkOpenFiles;
    if (request?.version !== 1 || !Array.isArray(request.files)) return [];
    return [...new Set(request.files.slice(0, 20).filter(file =>
      typeof file === 'string' && path.isAbsolute(file) && !/[\x00-\x1f]/.test(file)))];
  }
  // Keep the legacy path conservative: never guess which trailing argument is
  // the user's file rather than an Electron entry point or a profile directory.
  return commandFiles(argv, cwd, packaged);
}

function create(deps) {
  const { app, ipcMain, getWorkspace, revealWorkspace, identityOf, ownerOf } = deps;
  const pending = new Map();
  const claims = new Map();
  const trusted = event => {
    const win = getWorkspace();
    return Boolean(win && !win.isDestroyed() && event?.sender === win.webContents &&
      event.senderFrame === event.sender.mainFrame && !event.sender.isDestroyed() &&
      require('./access-control/preferences').isTrusted(event));
  };
  const owner = async () => {
    const identity = await identityOf();
    const key = identity && ownerOf(identity);
    if (!key) throw Error('请先登录 SoduWork，再打开文件');
    return key;
  };
  const signal = () => {
    if (!app.isReady()) return;
    revealWorkspace();
    const win = getWorkspace();
    if (win && !win.isDestroyed()) win.webContents.send('file-open-pending');
  };
  function enqueue(files) {
    for (const value of files || []) {
      const file = String(value || '');
      if (!file || !path.isAbsolute(file) || /[\x00-\x1f]/.test(file)) continue;
      if ([...pending.values()].some(row => row.source === file)) continue;
      if (pending.size >= 20) break;
      const id = randomUUID();
      pending.set(id, { id, source: file, name: path.basename(file), owner: '', prepared: null });
    }
    if (pending.size) signal();
    return pending.size;
  }
  async function prepare(row) {
    const scope = await owner();
    if (row.owner && row.owner !== scope) throw Error('登录账号已变化，请从文件右键重新打开');
    row.owner = scope;
    if (row.prepared) return row.prepared;
    const source = await fs.realpath(row.source);
    const stat = await fs.stat(source);
    if (!stat.isFile()) throw Error('请选择一个文件');
    if (stat.size > MAX_BYTES) throw Error('文件超过 256 MB，请选择较小的文件');
    const textFile = /\.(?:md|markdown|txt|csv|json|ya?ml|xml|js|jsx|ts|tsx|css|scss|py|java|go|rs|sql|sh|ps1)$/i.test(source);
    const preview = PREVIEW.test(source) && (!textFile || stat.size <= 2 * 1024 * 1024);
    let target = source;
    if (!preview) {
      const dir = path.join(app.getPath('userData'), 'file-inputs',
        createHash('sha256').update(scope).digest('hex'), row.id);
      const { assertNoLinks } = require('./plugin-resources');
      assertNoLinks(app.getPath('userData'), dir);
      await fs.mkdir(dir, { recursive: true });
      assertNoLinks(app.getPath('userData'), dir);
      target = path.join(dir, path.basename(source));
      assertNoLinks(dir, target);
      let bytes = 0;
      await pipeline(createReadStream(source), new Transform({
        transform(chunk, _encoding, next) {
          bytes += chunk.length;
          next(bytes > MAX_BYTES ? Error('文件超过 256 MB，请选择较小的文件') : null, chunk);
        },
      }), createWriteStream(target, { mode: 0o600 }));
      const copied = await fs.stat(target);
      if (copied.size > MAX_BYTES || copied.size !== stat.size) throw Error('文件正在变化，请重新打开');
    }
    if (await owner() !== scope) throw Error('登录账号已变化，请重新打开文件');
    const file = { name: path.basename(source), path: target, size: stat.size,
      lastModified: stat.mtimeMs, kind: /\.pdf$/i.test(source) ? 'pdf' : 'file',
      nativeReference: true };
    row.prepared = { id: row.id, file, preview, cwd: preview ? path.dirname(source) : '',
      title: path.basename(source) };
    return row.prepared;
  }
  ipcMain.handle('file-open-list', async event => {
    if (!trusted(event)) return { ok: false, reason: '请在主工作区中打开文件' };
    try {
      const scope = await owner();
      if (!trusted(event)) return { ok: false, reason: '打开文件的窗口已变化' };
      for (const row of pending.values()) if (row.owner && row.owner !== scope) pending.delete(row.id);
      return { ok: true, items: [...pending.values()].map(({ id, name }) => ({ id, name })) };
    } catch { return { ok: false, reason: '请先登录 SoduWork，再打开文件' }; }
  });
  ipcMain.handle('file-open-claim', async (event, id) => {
    if (!trusted(event)) return { ok: false, reason: '请在主工作区中打开文件' };
    const row = pending.get(String(id || ''));
    if (!row) return { ok: false, reason: '文件打开请求已失效，请重新打开' };
    try {
      if (!claims.has(row.id)) claims.set(row.id, prepare(row));
      const result = await claims.get(row.id);
      if (!trusted(event) || await owner() !== row.owner) throw Error('打开文件的窗口或账号已变化');
      return { ok: true, ...result };
    } catch (error) {
      return { ok: false, reason: error.code === 'ENOENT' ? '文件已移动或删除，请重新选择'
        : String(error.message || '文件无法读取') };
    } finally { claims.delete(row.id); }
  });
  ipcMain.handle('file-open-ack', (event, id) => {
    if (!trusted(event)) return { ok: false };
    pending.delete(String(id || ''));
    return { ok: true };
  });
  app.on('open-file', (event, file) => { event.preventDefault(); enqueue([file]); });
  return { enqueue, signal, fromCommand: (argv, cwd) => enqueue(commandFiles(argv, cwd, app.isPackaged)) };
}

module.exports = { create, commandFiles, instanceData, instanceFiles, PREVIEW, MAX_BYTES };
