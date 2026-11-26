'use strict';
const path = require('node:path');
const { realpath } = require('node:fs/promises');
const { execFile } = require('node:child_process');
const { current } = require('./distribution.cjs');

function execute(file, args, options) {
  return new Promise(resolve => execFile(file, args,
    { ...options, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } },
    (error, stdout, stderr) => resolve({ error, stdout, stderr })));
}

async function installedLinuxFormat(deps = {}) {
  const resolve = deps.realpath || realpath;
  const exec = deps.exec || execute;
  const env = deps.env || process.env;
  const packageName = (deps.profile || current()).linuxPackageName;
  const binary = await resolve(deps.execPath || process.execPath);
  if (env.APPIMAGE && env.APPDIR) {
    const appDir = await resolve(env.APPDIR).catch(() => '');
    if (appDir && binary.startsWith(appDir + path.sep)) return 'appimage';
  }
  // A parallel system installation must not change a portable copy's format.
  // Query package ownership of this executable, not just the host's distro.
  async function owners(file, args, noMatch) {
    const result = await exec(file, args, { timeout: 5000 });
    if (!result.error) return String(result.stdout || '').trimEnd().split(/\r?\n/);
    const detail = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
    if (result.error.code === 'ENOENT' || (result.error.code === 1 && detail === noMatch)) return [];
    const reason = result.error.code ?? result.error.signal ?? 'error';
    const message = (detail || result.error.message || '').slice(0, 1024);
    throw new Error(`${file} (${reason}): ${message}`, { cause: result.error });
  }
  // dpkg-query interprets its operand as a shell-style search pattern.
  const pattern = binary.replace(/[\\*?[]/g, '\\$&');
  const [debOwners, rpmOwners] = await Promise.all([
    owners('dpkg-query', ['-S', '--', pattern], 'dpkg-query: no path found matching pattern ' + pattern),
    owners('rpm', ['-qf', '--qf', '%{NAME}\\n', '--', binary], 'file ' + binary + ' is not owned by any package'),
  ]);
  const suffix = ': ' + binary;
  const deb = debOwners.some(line => line.endsWith(suffix) && line.slice(0, -suffix.length)
    .split(', ').some(owner => owner.split(':')[0] === packageName));
  const rpm = rpmOwners.includes(packageName);
  if (deb && rpm) throw new Error('Conflicting dpkg and RPM owners for ' + binary);
  if (deb) return 'deb';
  return rpm ? 'rpm' : 'tar.gz';
}

async function query(current, deps = {}) {
  const platform = deps.platform || process.platform;
  const profile = deps.profile || require('./distribution.cjs').current();
  const channel = profile.updateChannel || 'stable';
  if (!['stable', 'beta'].includes(channel)) throw new Error('Invalid Client update channel');
  const params = new URLSearchParams({ current, platform, arch: deps.arch || process.arch, channel });
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
