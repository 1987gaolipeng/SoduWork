'use strict';

// A cached task file is readable only after this live conversation fetched its
// authenticated attachment list. Neither a renderer path nor a sibling in the
// same cache directory establishes a grant.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const versions = require('../conversation/runtime-artifacts.cjs');
const { assertNoLinks } = require('../plugin-resources');
const CACHE_DIR = 'task-attachment-cache';
const grants = new WeakMap();
const hash = text => crypto.createHash('sha256').update(text).digest('hex');

function directory(app, owner, hub, sessionId, taskId) {
  return path.join(app.getPath('userData'), CACHE_DIR, hash(JSON.stringify([hub, owner])),
    hash(String(sessionId)), String(taskId));
}

function isPrivate(app, target) {
  if (!app?.getPath || typeof target !== 'string' || !path.isAbsolute(target)) return false;
  const root = path.resolve(app.getPath('userData'), CACHE_DIR);
  const inside = (base, file) => {
    const relative = path.relative(base, file);
    return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
  };
  if (inside(root, path.resolve(target))) return true;
  try { return inside(fs.realpathSync(root), fs.realpathSync(target)); }
  catch (_) { return false; }
}

function revoke(handle, taskId) {
  grants.get(handle)?.delete(taskId);
}

function publish(handle, ref, taskId, root, stamps, assertCurrent) {
  let tasks = grants.get(handle);
  if (!tasks) { tasks = new Map(); grants.set(handle, tasks); }
  const access = {
    root, ref,
    async authorize() {
      await assertCurrent();
      if (tasks.get(taskId) !== access) throw Error('成果登记已更新，请重新打开');
    },
    verify(file, opened) {
      if (tasks.get(taskId) !== access || !stamps.has(file)) return false;
      try {
        assertNoLinks(root, file);
        const stat = fs.lstatSync(file, { bigint: true });
        const matches = value => value.isFile() && value.nlink === 1n && versions.same(stamps.get(file), versions.stamp(value));
        return !path.relative(file, fs.realpathSync(file)) && matches(stat) && (!opened || matches(opened));
      } catch (_) { return false; }
    },
  };
  tasks.set(taskId, access);
}

async function authorize(app, handle, ref, target) {
  if (typeof target !== 'string') return null;
  if (!path.isAbsolute(target)) {
    if (handle?.cwd && isPrivate(app, path.resolve(handle.cwd, target))) throw Error('缓存成果路径无效');
    return null;
  }
  if (!isPrivate(app, target)) return null;
  const file = path.resolve(target);
  for (const access of grants.get(handle)?.values() || []) {
    if (access.ref !== ref || !access.verify(file)) continue;
    await access.authorize();
    if (access.verify(file)) return access;
  }
  throw Error('这份缓存成果不属于当前会话或已变化，请重新打开');
}

module.exports = { CACHE_DIR, directory, isPrivate, revoke, publish, authorize };
