'use strict';
const path = require('node:path');
const { realpath } = require('node:fs/promises');
const { execFile } = require('node:child_process');
const { current } = require('./distribution.cjs');

function execute(file, args) {
  return new Promise(resolve => execFile(file, args,
    { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 },
    (error, stdout) => resolve({ error, stdout: String(stdout || '') })));
}

async function installedLinuxFormat(deps = {}) {
  const resolve = deps.realpath || realpath;
  const exec = deps.exec || execute;
  const env = deps.env || process.env;
  const packageName = (deps.profile || current()).linuxPackageName;
  const binary = await resolve(deps.execPath || process.execPath).catch(() => '');
  if (!binary) return 'tar.gz';
  if (env.APPIMAGE && env.APPDIR) {
    const appDir = await resolve(env.APPDIR).catch(() => '');
    if (appDir && binary.startsWith(appDir + path.sep)) return 'appimage';
  }
  // A parallel system installation must not change a portable copy's format.
  // Query package ownership of this executable, not just the host's distro.
  async function owns(file, args) {
    try {
      const result = await exec(file, args, { timeout: 5000 });
      if (result.error) return false;
      const files = String(result.stdout || '').split(/\r?\n/);
      return files.some(file => path.isAbsolute(file) && path.normalize(file) === binary);
    } catch (_) { return false; }
  }
  const [deb, rpm] = await Promise.all([
    owns('dpkg-query', ['-L', packageName]), owns('rpm', ['-ql', packageName]),
  ]);
  if (deb !== rpm) return deb ? 'deb' : 'rpm';
  return 'tar.gz';
}

async function query(current, deps = {}) {
  const platform = deps.platform || process.platform;
  const params = new URLSearchParams({ current, platform, arch: deps.arch || process.arch, channel: 'stable' });
  if (platform === 'linux') params.set('format', await installedLinuxFormat(deps));
  return params;
}

function validateFormat(manifest, params) {
  const format = params.get('format');
  if (format && !String(manifest.artifact?.name || '').toLowerCase().endsWith('.' + format)) {
    throw new Error('更新包格式与当前安装方式不一致，请更新服务端或手动选择对应安装包');
  }
}

module.exports = { installedLinuxFormat, query, validateFormat };
