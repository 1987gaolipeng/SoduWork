'use strict';
// Select the runtime that will actually execute a CLI. An Electron Node version
// is not evidence that an unrelated system Node/npm installation is compatible.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function createResolver({ platform = process.platform, executable = process.execPath,
  versions = process.versions, environment = process.env, io = fs,
  probe = spawnSync, clock = Date.now } = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const cache = new Map();
  function environmentFor(node) {
    const env = { ...environment };
    delete env.NODE_OPTIONS;
    delete env.ELECTRON_RUN_AS_NODE;
    if (versions.electron && node === executable) env.ELECTRON_RUN_AS_NODE = '1';
    else {
      const key = platform === 'win32' && Object.hasOwn(env, 'Path') ? 'Path' : 'PATH';
      env[key] = p.dirname(node) + (platform === 'win32' ? ';' : ':') + (env[key] || '');
    }
    return env;
  }
  function candidates() {
    const folders = String(environment.PATH || environment.Path || '').split(platform === 'win32' ? ';' : ':');
    const paths = folders.filter(Boolean).map(folder => p.join(folder, platform === 'win32' ? 'node.exe' : 'node'));
    if (platform === 'win32') paths.push(p.join(environment.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe'));
    if (!versions.electron) paths.unshift(executable);
    return [...new Set(paths)];
  }
  function npmFor(node) {
    const dir = p.dirname(node);
    const options = [p.join(dir, 'node_modules/npm/bin/npm-cli.js'), p.resolve(dir, '../lib/node_modules/npm/bin/npm-cli.js')];
    // Resolve distro symlinks such as /usr/bin/npm -> ../share/nodejs/npm/bin/npm-cli.js.
    if (platform !== 'win32') {
      try { options.push(io.realpathSync(p.join(dir, 'npm'))); } catch (_) {}
    }
    return options.find(file => /npm-cli\.js$/.test(file) && io.existsSync(file)) || '';
  }
  return function resolve({ minimum = 20, requireNpm = false } = {}) {
    const key = JSON.stringify([minimum, requireNpm, environment.PATH || environment.Path]);
    const saved = cache.get(key);
    if (saved && clock() - saved.at < 30000) return { ...saved.value, env: environmentFor(saved.value.node) };
    const found = [];
    for (const candidate of candidates()) {
      if (!io.existsSync(candidate) || (versions.electron && candidate === executable)) continue;
      let version = candidate === executable && !versions.electron ? versions.node : '';
      if (!version) {
        try {
          const check = probe(candidate, ['--version'], { env: environmentFor(candidate), encoding: 'utf8', timeout: 2000, windowsHide: true, shell: false });
          if (check.status !== 0) continue;
          version = String(check.stdout || '').trim().replace(/^v/, '');
        } catch (_) { continue; }
      }
      if (!/^\d+\.\d+\.\d+/.test(version)) continue;
      found.push(version);
      if (Number(version.split('.')[0]) < minimum) continue;
      const npm = npmFor(candidate);
      if (requireNpm && !npm) continue;
      const value = { node: candidate, npm, version, embedded: false };
      cache.set(key, { at: clock(), value });
      return { ...value, env: environmentFor(candidate) };
    }
    // Approved pure-JS platform launchers can use the embedded runtime, but npm
    // installs must use native Node so native dependencies get the correct ABI.
    if (!requireNpm && versions.electron && Number(versions.node.split('.')[0]) >= minimum) {
      const value = { node: executable, npm: '', version: versions.node, embedded: true };
      cache.set(key, { at: clock(), value });
      return { ...value, env: environmentFor(executable) };
    }
    throw Error(`需要 Node.js ${minimum} 或更新版本${requireNpm ? '（包含 npm）' : ''}。${found.length ? '检测到：' + found.join('、') + '。' : ''}请安装后重试；客户端内置 Node 与系统 Node 独立。`);
  };
}
module.exports = { createResolver, resolve: createResolver() };
