'use strict';

// Pi and its extensions are CLI libraries hosted inside Electron. Keep their
// background children from opening consoles, without changing other app code
// or explicit requests to open an interactive process. Async context prevents
// one chat's process defaults leaking into unrelated Electron operations.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { AsyncLocalStorage } = require('node:async_hooks');
const { syncBuiltinESMExports } = require('node:module');
const { promisify } = require('node:util');
const scope = new AsyncLocalStorage();
let installed = false;

function directoryNames(directory, cache) {
  try {
    const stat = fs.statSync(directory);
    const old = cache.get(directory);
    if (old?.modified === stat.mtimeMs && old?.created === stat.birthtimeMs) return old.names;
    const names = new Map(fs.readdirSync(directory).map(name => [name.toLowerCase(), name]));
    cache.set(directory, { modified: stat.mtimeMs, created: stat.birthtimeMs, names });
    return names;
  } catch { cache.delete(directory); return new Map(); }
}

function envValue(env, name) {
  // Match Node's Windows environment serialization when PATH and Path coexist.
  const key = Object.keys(env).sort().find(key => key.toLowerCase() === name.toLowerCase());
  return key ? String(env[key] || '') : '';
}

// Windows extensions commonly use `execSync("where <runtime>")` to discover
// every language runtime before the first model request. Starting cmd + where
// for each lookup blocks the desktop for seconds. Resolve only this exact,
// read-only form directly. Compound commands and other shell options still
// use Node's normal implementation. Do not cache lookup results: PATH and
// installs can change while a session is running.
function whereResult(command, options = {}, deps = {}) {
  options = options || {};
  if (typeof options !== 'object') return null;
  if ((deps.platform || process.platform) !== 'win32') return null;
  const match = /^where(?:\.exe)? ([a-zA-Z0-9_][a-zA-Z0-9_.+-]*)$/.exec(command);
  if (!match || options.shell || options.input != null || options.stdio && options.stdio !== 'pipe') return null;
  if (options.cwd && typeof options.cwd !== 'string') return null;
  if (options.encoding && options.encoding !== 'buffer' && !Buffer.isEncoding(options.encoding)) return null;
  const env = options.env || process.env;
  const cwd = options.cwd || process.cwd();
  const envPath = envValue(env, 'PATH');
  if (envPath.includes('%')) return null;
  const ext = envValue(env, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD';
  const endings = path.win32.extname(match[1]) ? [''] : ['', ...ext.split(';').filter(Boolean)];
  const names = endings.map(ending => match[1] + ending);
  const directories = [cwd, ...envPath.split(';').filter(Boolean).map(value => value.replace(/^"|"$/g, ''))];
  const found = [], seen = new Set();
  const cache = scope.getStore()?.directories || new Map();
  const isFile = deps.isFile || (file => { try { return fs.statSync(file).isFile(); } catch { return false; } });
  for (const directory of directories) {
    // One directory listing replaces repeated failing stats for every suffix.
    // Revalidate directory timestamps so a runtime installed during a tool
    // invocation is visible immediately; scopes do not share these listings.
    const entries = deps.isFile ? null : directoryNames(path.win32.resolve(cwd, directory), cache);
    for (const name of names) {
      const actual = entries ? entries.get(name.toLowerCase()) : name;
      if (!actual) continue;
      const file = path.win32.resolve(cwd, directory, actual);
      const key = file.toLowerCase();
      if (!seen.has(key) && isFile(file)) { seen.add(key); found.push(file); }
    }
  }
  const stdout = Buffer.from(found.length ? found.join('\r\n') + '\r\n' : '');
  if (!found.length) {
    const stderr = Buffer.from('INFO: Could not find files for the given pattern(s).\r\n');
    const error = new Error('Command failed: ' + command + '\n' + stderr.toString());
    Object.assign(error, { status: 1, signal: null, pid: 0, stdout, stderr, output: [null, stdout, stderr] });
    return { error };
  }
  if (options.maxBuffer != null && stdout.length > options.maxBuffer) return null;
  return { value: options.encoding && options.encoding !== 'buffer' ? stdout.toString(options.encoding) : stdout };
}

function backgroundArgs(name, args) {
  const next = args.slice();
  const index = /^(spawn|spawnSync|execFile|execFileSync)$/.test(name)
    ? (Array.isArray(args[1]) || args[1] == null && args.length > 2 ? 2 : 1) : 1;
  const options = next[index];
  if (options != null && typeof options !== 'object' &&
      !(typeof options === 'function' && (name === 'exec' || name === 'execFile'))) return next;
  const value = options && typeof options === 'object' ? options : {};
  const hidden = { ...value, windowsHide: value.windowsHide === undefined ? true : value.windowsHide };
  const desktopScope = scope.getStore()?.desktopScope;
  if (desktopScope) {
    hidden.env = { ...(value.env || process.env) };
    // Windows collapses environment names case-insensitively. Remove an old
    // scope before injecting this turn, even for tools supplying a custom env.
    for (const key of Object.keys(hidden.env)) {
      if (key.toUpperCase() === 'SODUWORK_DESKTOP_CONTROL_SCOPE' ||
          process.env.SODUWORK_DESKTOP_CONTROL_ENDPOINT && key.toUpperCase() === 'SODUWORK_DESKTOP_CONTROL_ENDPOINT') delete hidden.env[key];
    }
    hidden.env.SODUWORK_DESKTOP_CONTROL_SCOPE = desktopScope;
    if (process.env.SODUWORK_DESKTOP_CONTROL_ENDPOINT) {
      hidden.env.SODUWORK_DESKTOP_CONTROL_ENDPOINT = process.env.SODUWORK_DESKTOP_CONTROL_ENDPOINT;
    }
  }
  if (typeof options === 'function') next.splice(index, 0, hidden);
  else next[index] = hidden;
  return next;
}

function install() {
  if (installed) return;
  installed = true;
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync']) {
    const original = cp[name];
    const wrapped = function (...args) {
      if (!scope.getStore()) return original.apply(this, args);
      if (name === 'execSync' && typeof args[0] === 'string') {
        const result = whereResult(args[0], args[1]);
        if (result) {
          if (result.error) throw result.error;
          return result.value;
        }
      }
      const result = original.apply(this, backgroundArgs(name, args));
      if (name === 'spawn' || name === 'execFile' || name === 'exec') {
        require('./mcp-tool-transport').observe(result);
      }
      return result;
    };
    const descriptors = Object.getOwnPropertyDescriptors(original);
    delete descriptors[promisify.custom];
    Object.defineProperties(wrapped, descriptors);
    if (typeof original[promisify.custom] === 'function') {
      Object.defineProperty(wrapped, promisify.custom, { configurable: true, value: function (...args) {
        return original[promisify.custom].apply(this, scope.getStore() ? backgroundArgs(name, args) : args);
      } });
    }
    cp[name] = wrapped;
  }
  // Named ESM imports (the SDK) must share the same scoped wrappers as CJS
  // extensions; updating only require('child_process') misses these imports.
  syncBuiltinESMExports();
}

function run(fn, context = {}) {
  install();
  const parent = scope.getStore();
  const desktopScope = typeof context.desktopScope === 'string' ? context.desktopScope : parent?.desktopScope;
  return scope.run({ ...(parent || { directories: new Map() }), desktopScope }, fn);
}

module.exports = { run, whereResult, backgroundArgs };
