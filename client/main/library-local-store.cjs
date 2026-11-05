'use strict';
// Account-scoped files and one atomically replaced metadata index. Never adopt
// the old Hub download cache: it has no trustworthy local account ownership.
const fs = require('node:fs');
const io = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const replacement = require('./verified-file-replace.cjs');
const OWNER = /^[a-f0-9]{32}$/;
const ITEM = /^local-[a-f0-9-]{36}$/;
const FOLDER = /^local-folder-[a-f0-9-]{36}$/;
const OBJECT = /^objects\/[a-f0-9-]{36}\/[^/\\]+$/;
const MAX_BYTES = 64 * 1024 * 1024;
const queues = new Map();
function error(code, message) { const e = Error(message); e.code = code; return e; }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function regular(stat) {
  if (!stat.isFile() || stat.isSymbolicLink()) throw error('LOCAL_LIBRARY_UNSAFE_PATH', '资料路径不是普通文件，或包含链接');
  return stat;
}
async function copyLegacyTree(source, target, guard) {
  let stat;
  try { stat = await io.lstat(source); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw error('LOCAL_LIBRARY_UNSAFE_PATH', '旧资料库目录包含链接或不是目录');
  await io.mkdir(target, { recursive: true, mode: 0o700 }); guard();
  for (const entry of await io.readdir(source, { withFileTypes: true })) {
    guard();
    const from = path.join(source, entry.name), to = path.join(target, entry.name);
    if (entry.isDirectory()) await copyLegacyTree(from, to, guard);
    else if (entry.isFile()) {
      try { await io.copyFile(from, to, require('node:fs').constants.COPYFILE_EXCL); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    } else throw error('LOCAL_LIBRARY_UNSAFE_PATH', '旧资料库包含不支持的文件类型');
  }
  return true;
}

function create(app, owner, guard, configuredWorkRoot = '') {
  if (!OWNER.test(owner)) throw error('LOCAL_LIBRARY_OWNER_REQUIRED', '请先登录当前账号');
  const base = path.resolve(String(configuredWorkRoot || app.getPath('userData')));
  const libraryRoot = path.join(base, 'SoduWorkLibrary');
  const root = path.join(libraryRoot, 'accounts', owner);
  const legacyRoot = path.join(path.resolve(app.getPath('userData')), 'library', 'accounts', owner);
  const indexPath = path.join(root, 'index.json');
  let staged = false;
  const awaited = async promise => { const value = await promise; guard(); return value; };
  async function directories(target, make = false) {
    const relative = path.relative(base, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw error('LOCAL_LIBRARY_UNSAFE_PATH', '资料路径超出本机目录');
    let current = base;
    for (const part of ['', ...relative.split(path.sep).filter(Boolean)]) {
      if (part) current = path.join(current, part);
      let stat;
      try { stat = await awaited(io.lstat(current)); }
      catch (e) {
        if (e.code !== 'ENOENT' || !make) throw e;
        await awaited(io.mkdir(current, { mode: 0o700 }).catch(e => { if (e.code !== 'EEXIST') throw e; }));
        stat = await awaited(io.lstat(current));
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw error('LOCAL_LIBRARY_UNSAFE_PATH', '本机资料目录包含链接或不是目录');
    }
  }
  async function checkedFile(target, optional = false) {
    await directories(path.dirname(target)); guard();
    try { return regular(await awaited(io.lstat(target))); }
    catch (e) { if (optional && e.code === 'ENOENT') return null; throw e; }
  }
  function objectPath(key) {
    if (!OBJECT.test(String(key)) || path.basename(key) === '.' || path.basename(key) === '..' || /[:\x00-\x1f]/.test(key)) {
      throw error('LOCAL_LIBRARY_UNSAFE_PATH', '资料文件标识无效');
    }
    return path.join(root, ...key.split('/'));
  }
  async function load() {
    guard();
    // Establish and validate every component of the destination before copying
    // legacy data. This prevents a pre-existing junction in the new workspace
    // from redirecting migration writes outside the configured work root.
    await directories(root, true); await directories(path.join(root, 'objects'), true);
    if (path.resolve(legacyRoot).toLowerCase() !== path.resolve(root).toLowerCase()) {
      try { await io.lstat(indexPath); }
      catch (e) { if (e.code !== 'ENOENT') throw e; await copyLegacyTree(legacyRoot, root, guard); }
    }
    let content;
    try {
      const stat = await checkedFile(indexPath);
      if (stat.size > 32 * 1024 * 1024) throw error('LOCAL_LIBRARY_INDEX_CORRUPT', '本机资料索引过大');
      // JSON.stringify() does not write a BOM, but older Windows editors and
      // profile/sync tools may add one to an otherwise valid UTF-8 index. A
      // BOM is an encoding marker, not part of the JSON document.
      content = (await awaited(io.readFile(indexPath, 'utf8'))).replace(/^\uFEFF/, '');
    } catch (e) { if (e.code === 'ENOENT') return { schema: 1, items: [], folders: [], garbage: [] }; throw e; }
    let value;
    try {
      value = JSON.parse(content);
      if (value.schema !== 1 || !Array.isArray(value.items) || !Array.isArray(value.folders) || !Array.isArray(value.garbage)) throw Error();
      if (new Set(value.items.map(x => x.id)).size !== value.items.length || new Set(value.folders.map(x => x.id)).size !== value.folders.length) throw Error();
      for (const row of value.items) { if (!ITEM.test(row.id) || !OBJECT.test(row._object)) throw Error(); objectPath(row._object); }
      for (const row of value.folders) if (!FOLDER.test(row.id)) throw Error();
      for (const key of value.garbage) objectPath(key);
    } catch { throw error('LOCAL_LIBRARY_INDEX_CORRUPT', '本机资料索引损坏；原文件已保留，请勿覆盖索引'); }
    return value;
  }
  async function save(index) {
    guard(); await directories(root); await checkedFile(indexPath, true);
    const temporary = indexPath + '.' + crypto.randomUUID() + '.tmp';
    try {
      await awaited(io.writeFile(temporary, JSON.stringify(index), { flag: 'wx', mode: 0o600 }));
      await replacement.replaceFile(temporary, indexPath, { check: guard, checkPath: () => checkedFile(indexPath, true) });
      guard();
    } finally { await io.unlink(temporary).catch(() => {}); }
  }
  async function write(bytes, filename, index) {
    if (bytes.length > MAX_BYTES) throw error('LOCAL_LIBRARY_TOO_LARGE', '本机资料单次导入支持最大 64MB 文件');
    const key = 'objects/' + crypto.randomUUID() + '/' + filename, target = objectPath(key);
    // Persist a recovery entry before creating bytes, without committing the
    // caller's pending metadata edits. A failed write is therefore reclaimable
    // even if the process exits before the error handler can run.
    const committed = await load(); committed.garbage.push(key);
    await save(committed); staged = true; index.garbage.push(key);
    await directories(path.dirname(target), true); guard();
    await awaited(io.writeFile(target, bytes, { flag: 'wx', mode: 0o600 }));
    return key;
  }
  async function existingFile(operation) {
    try { return await operation(); }
    catch (failure) {
      guard();
      // Only classify missing source objects here. Index, destination and
      // permission failures retain their own meaning.
      if (failure.code === 'ENOENT') throw error('LOCAL_LIBRARY_FILE_MISSING', '找不到这份资料的本地文件，可能已被删除或移动。请恢复文件后重试，或从原会话重新保存、重新上传到资料库。');
      throw failure;
    }
  }
  async function read(row) {
    return existingFile(async () => {
      const target = objectPath(row._object), stat = await checkedFile(target);
      if (stat.size > MAX_BYTES) throw error('LOCAL_LIBRARY_TOO_LARGE', '文件超过 64MB，请使用系统打开或导出');
      const bytes = await awaited(io.readFile(target));
      if (bytes.length > MAX_BYTES) throw error('LOCAL_LIBRARY_TOO_LARGE', '文件超过 64MB，请使用系统打开或导出');
      await checkedFile(target); return bytes;
    });
  }
  async function locate(row, displayFilename = '') {
    return existingFile(async () => {
      const target = objectPath(row._object);
      await checkedFile(target);
      // Older indexes kept the user-visible title separately from the object key.
      // Keep those objects readable, but materialize a same-directory alias so the
      // native shell shows the current filename for open/reveal/export actions.
      const visible = String(displayFilename || '').trim();
      if (!visible || path.basename(target) === visible || path.basename(visible) !== visible || /[\x00-\x1f]/.test(visible)) return target;
      const alias = path.join(path.dirname(target), visible);
      try { await checkedFile(alias); return alias; }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
      guard();
      try { await awaited(io.copyFile(target, alias, require('node:fs').constants.COPYFILE_EXCL)); }
      catch (e) { if (e.code !== 'EEXIST') throw e; }
      guard(); await checkedFile(alias); return alias;
    });
  }
  async function garbageCollect(index) {
    // Garbage is recorded in the same index commit as the metadata change.
    // Failed removal remains retryable, and never deletes a referenced object.
    const referenced = new Set(index.items.map(x => x._object));
    for (const key of index.garbage) {
      guard(); if (referenced.has(key)) continue;
      const target = objectPath(key);
      try {
        await checkedFile(target); guard(); await awaited(io.unlink(target));
        await awaited(io.rmdir(path.dirname(target)));
      } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    if (index.garbage.length) { index.garbage = []; await save(index); }
  }
  async function run(fn) {
    const key = root, previous = queues.get(key) || Promise.resolve();
    const pending = previous.catch(() => {}).then(async () => {
      guard();
      try { return await fn(await load()); }
      finally {
        // Cleanup may finish after account switching, but only uses this
        // captured owner's validated paths and the committed reference set.
        // Never remove a newly committed object when the final guard failed.
        if (staged) {
          const recovery = create(app, owner, () => {}, configuredWorkRoot);
          try { await recovery.garbageCollect(await recovery.load()); } catch { /* Durable garbage entries remain retryable. */ }
        }
      }
    });
    queues.set(key, pending);
    try { return await pending; }
    finally { if (queues.get(key) === pending) queues.delete(key); }
  }
  return { root, libraryRoot, run, load, save, write, read, locate, garbageCollect, guard, checkedFile };
}
module.exports = { create, error, clone, OWNER, ITEM, FOLDER, MAX_BYTES };
