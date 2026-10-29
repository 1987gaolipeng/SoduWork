'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, execFile } = require('node:child_process');
const { createHash } = require('node:crypto');

const REQUIRED_TOOLS = Object.freeze(['git', 'find', 'grep', 'sed', 'tar']);
const PROBE_CACHE_MS = 60000;
const _probed = new Map();
const _pending = new Map();

function _exists(file) {
  try { return Boolean(file && fs.statSync(file).isFile()); } catch (error) { return false; }
}

function _clientRoot(value) {
  return value || path.resolve(__dirname, '..', '..');
}

function _envValue(env, name, platform) {
  const key = Object.keys(env).sort().find(key => platform === 'win32'
    ? key.toLowerCase() === name.toLowerCase() : key === name);
  return key ? String(env[key] || '') : '';
}

function candidates(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const resourceRoot = options.resourceRoot === undefined
    ? require('../agent-runtime/process-context').current()?.resourcesPath || process.resourcesPath : options.resourceRoot;
  const clientRoot = _clientRoot(options.clientRoot);
  const out = [];
  const seen = new Set();
  const add = (file, source, bundled = false) => {
    const value = String(file || '').trim();
    const key = platform === 'win32' ? value.toLowerCase() : value;
    if (!value || seen.has(key)) return;
    seen.add(key);
    out.push({ shellPath: value, source, bundled });
  };

  if (resourceRoot) {
    add(path.join(resourceRoot, 'shell', 'bin', 'bash.exe'), 'bundled', true);
    add(path.join(resourceRoot, 'shell', 'usr', 'bin', 'bash.exe'), 'bundled', true);
  }
  add(path.join(clientRoot, '.runtime', 'git', 'bin', 'bash.exe'), 'development-bundle', true);
  add(path.join(clientRoot, '.runtime', 'git', 'usr', 'bin', 'bash.exe'), 'development-bundle', true);
  add(options.configuredPath, 'configured');

  if (platform === 'win32') {
    const programFiles = _envValue(env, 'ProgramFiles', platform);
    const programFilesX86 = _envValue(env, 'ProgramFiles(x86)', platform);
    if (programFiles) add(path.join(programFiles, 'Git', 'bin', 'bash.exe'), 'system-git');
    if (programFilesX86) add(path.join(programFilesX86, 'Git', 'bin', 'bash.exe'), 'system-git');
  } else {
    add('/bin/bash', 'system');
    add('/usr/bin/bash', 'system');
  }
  // Resolve PATH as files only, after preferred bundled candidates. Calling
  // where.exe here used to block Electron even when the bundled shell existed.
  const cwd = options.cwd || process.cwd();
  const envPath = _envValue(env, 'PATH', platform);
  const directories = [cwd, ...envPath.split(platform === 'win32' ? ';' : ':').filter(Boolean)];
  for (const directory of directories) {
    add(path.resolve(cwd, directory.replace(/^"|"$/g, ''), platform === 'win32' ? 'bash.exe' : 'bash'), 'path');
  }
  return out;
}

function _command() {
  return [
    "printf 'SODUWORK_SHELL_OK\\n'",
    ...REQUIRED_TOOLS.map((name) => 'command -v ' + name + ' >/dev/null || exit 31'),
  ].join('; ');
}

function _runOptions(options) {
  return {
    encoding: 'utf8', timeout: 10000, windowsHide: true, shell: false, maxBuffer: 65536,
    env: { ...(options.env || process.env), CHERE_INVOKING: '1', MSYS_NO_PATHCONV: '1' },
    ...(options.cwd ? { cwd: options.cwd } : {}),
  };
}

function _cacheKey(shellPath, options, stat) {
  if (!stat?.isFile()) return '';
  const platform = options.platform || process.platform;
  const values = new Map();
  const env = _runOptions(options).env;
  for (const key of Object.keys(env).sort()) {
    const name = platform === 'win32' ? key.toLowerCase() : key;
    if (!values.has(name)) values.set(name, String(env[key] ?? ''));
  }
  // Only the digest is retained; the cache must never store credentials from
  // the environment. Shell startup can depend on more than PATH (e.g. HOME).
  const envHash = createHash('sha256').update(JSON.stringify([...values])).digest('hex');
  const filename = path.resolve(shellPath);
  return JSON.stringify([platform, platform === 'win32' ? filename.toLowerCase() : filename,
    options.cwd || process.cwd(), envHash, stat.size, stat.mtimeMs, stat.ctimeMs, stat.dev, stat.ino]);
}

function _cached(key) {
  const entry = key && _probed.get(key);
  if (entry?.expiresAt > Date.now()) return entry.value;
  if (key) _probed.delete(key);
  return null;
}

function _remember(key, result) {
  if (!key || !result.ok) return result;
  _probed.set(key, { value: result, expiresAt: Date.now() + PROBE_CACHE_MS });
  while (_probed.size > 64) _probed.delete(_probed.keys().next().value);
  return result;
}

function _result(result) {
  const ok = result.status === 0 && String(result.stdout || '').includes('SODUWORK_SHELL_OK');
  return {
    ok,
    reason: ok ? '' : String((result.error && result.error.message) || result.stderr ||
      ('shell exited with ' + result.status)).trim(),
  };
}

function probe(shellPath, options = {}) {
  if (options.probe === false) return { ok: true, reason: '' };
  let key = '';
  try { key = _cacheKey(shellPath, options, fs.statSync(shellPath)); } catch (_) {}
  const cached = _cached(key);
  if (cached) return cached;
  let result;
  try {
    result = spawnSync(shellPath, ['-c', _command()], _runOptions(options));
  } catch (error) {
    result = { status: -1, error, stderr: '' };
  }
  return _remember(key, _result(result));
}

function _runAsync(command, args, options) {
  return new Promise(resolve => {
    execFile(command, args, options, (error, stdout, stderr) => resolve({
      status: error ? (typeof error.code === 'number' ? error.code : -1) : 0,
      error, stdout, stderr,
    }));
  });
}

async function probeAsync(shellPath, options = {}) {
  if (options.probe === false) return { ok: true, reason: '' };
  let key = '';
  try { key = _cacheKey(shellPath, options, await fs.promises.stat(shellPath)); } catch (_) {}
  const cached = _cached(key);
  if (cached) return cached;
  if (key && _pending.has(key)) return _pending.get(key);
  const request = Promise.resolve().then(async () => {
    let result;
    try { result = await (options.run || _runAsync)(shellPath, ['-c', _command()], _runOptions(options)); }
    catch (error) { result = { status: -1, error }; }
    const checked = _result(result);
    // A replaced executable cannot inherit the old one's verification result.
    try {
      if (key === _cacheKey(shellPath, options, await fs.promises.stat(shellPath))) _remember(key, checked);
    } catch (_) {}
    return checked;
  });
  if (key) _pending.set(key, request);
  try { return await request; }
  finally { if (key && _pending.get(key) === request) _pending.delete(key); }
}

function _missing(failures) {
  const detail = failures.length ? '\n' + failures.join('\n') : '';
  return new Error('\u5f53\u524d SoduWork \u5b89\u88c5\u4e0d\u5b8c\u6574\uff1a\u547d\u4ee4\u8fd0\u884c\u65f6\u7f3a\u5931\u6216\u5df2\u635f\u574f\u3002' +
    '\u8bf7\u4f7f\u7528 SoduWork \u5347\u7ea7\u4fee\u590d\u6216\u91cd\u65b0\u5b89\u88c5\u5f53\u524d\u7248\u672c\uff0c\u4e0d\u9700\u8981\u5355\u72ec\u5b89\u88c5 Git\u3002' + detail);
}

function resolve(options = {}) {
  const failures = [];
  for (const candidate of candidates(options)) {
    if (!_exists(candidate.shellPath)) continue;
    const checked = probe(candidate.shellPath, options);
    if (checked.ok) return { ...candidate, tools: [...REQUIRED_TOOLS] };
    failures.push(candidate.source + ': ' + checked.reason);
  }
  throw _missing(failures);
}

async function resolveAsync(options = {}) {
  const failures = [];
  for (const candidate of candidates(options)) {
    try { if (!(await fs.promises.stat(candidate.shellPath)).isFile()) continue; } catch (_) { continue; }
    const checked = await probeAsync(candidate.shellPath, options);
    if (checked.ok) return { ...candidate, tools: [...REQUIRED_TOOLS] };
    failures.push(candidate.source + ': ' + checked.reason);
  }
  throw _missing(failures);
}

module.exports = { REQUIRED_TOOLS, candidates, probe, resolve, probeAsync, resolveAsync };
