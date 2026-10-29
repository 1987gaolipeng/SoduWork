'use strict';

// libuv <= 1.52.1 on Windows can keep rearming ReadDirectoryChangesW on a
// deleted directory, spinning a core even after the same path is recreated.
// Keep Node's real FSWatcher and report invalidation through its normal error
// contract so existing callers can restart their watcher or fall back to polling.
const nodeFs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const installed = Symbol.for('soduwork.windowsFsWatchGuard');

function localPath(value) {
  if (value instanceof URL) return fileURLToPath(value);
  return Buffer.isBuffer(value) ? value.toString() : value;
}
function comparable(value) {
  let name = String(value || '').replace(/\//g, '\\');
  if (name.startsWith('\\\\?\\UNC\\')) name = '\\\\' + name.slice(8);
  else if (name.startsWith('\\\\?\\')) name = name.slice(4);
  return path.win32.normalize(name).replace(/\\+$/, '').toLowerCase();
}
function missing(error) { return error?.code === 'ENOENT' || error?.code === 'ENOTDIR'; }
function identity(stats) { return stats && String(stats.dev) + ':' + String(stats.ino); }

function createWatch(original, { fs = nodeFs, now = Date.now, checkIntervalMs = 250 } = {}) {
  function watch(...args) {
    let directory, initial, realDirectory;
    // Preflight is observational only. Native watch below still performs all
    // validation and throws its original errors for invalid arguments/options.
    try {
      const target = path.resolve(localPath(args[0]));
      const stat = fs.statSync(target, { bigint: true });
      directory = stat.isDirectory() ? target : path.dirname(target);
      initial = stat.isDirectory() ? stat : fs.statSync(directory, { bigint: true });
      try { realDirectory = fs.realpathSync(directory); } catch (_) {}
    } catch (_) {}
    const watcher = Reflect.apply(original, this, args);
    if (!directory || !initial) return watcher;
    const originalIdentity = identity(initial);
    let closed = false, invalidated = false, checkedAt = -Infinity;
    const fail = code => {
      if (closed || invalidated) return;
      invalidated = true;
      // Closing before emit stops the native loop even if the error listener
      // throws, or a caller only starts polling without closing its old handle.
      watcher.close();
      const error = new Error(code === 'ENOENT'
        ? 'Watched directory was removed' : 'Watched directory was replaced or moved');
      error.code = code; error.syscall = 'watch'; error.filename = directory;
      watcher.emit('error', error);
    };
    const check = (eventType, filename) => {
      if (closed || invalidated) return;
      const name = filename == null ? '' : localPath(filename);
      const rootRenamed = eventType === 'rename' && typeof name === 'string' && path.win32.isAbsolute(name) &&
        (comparable(name) === comparable(directory) || realDirectory && comparable(name) === comparable(realDirectory));
      const at = now();
      if (!rootRenamed && at - checkedAt < checkIntervalMs) return;
      checkedAt = at;
      let stat;
      try { stat = fs.statSync(directory, { bigint: true }); }
      catch (error) {
        if (missing(error)) fail('ENOENT');
        else if (rootRenamed) fail('ESTALE');
        return;
      }
      // An absolute rename of the watched root is libuv's deletion signal.
      // A replacement can already exist by the time this callback is delivered.
      if (rootRenamed || !stat.isDirectory() || identity(stat) !== originalIdentity) fail('ESTALE');
    };
    watcher.prependListener('change', check);
    watcher.once('close', () => { closed = true; watcher.removeListener('change', check); });
    return watcher;
  }
  Object.defineProperty(watch, installed, { value: true });
  return watch;
}

function install({ fs = nodeFs, platform = process.platform, syncBuiltinESMExports } = {}) {
  if (platform !== 'win32' || fs.watch[installed]) return false;
  fs.watch = createWatch(fs.watch, { fs });
  // Extensions may import the ESM named export rather than the CJS fs object.
  if (fs === nodeFs) (syncBuiltinESMExports || require('node:module').syncBuiltinESMExports)();
  return true;
}

module.exports = { install, createWatch };
