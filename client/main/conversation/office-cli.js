'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { TextDecoder } = require('util');

function decodeOutput(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  if (!bytes.length) return '';
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    // Decode localized cmd.exe errors using the system code page, commonly GBK or GB18030 on Chinese Windows.
    try { return new TextDecoder('gb18030').decode(bytes); } catch (_) { return bytes.toString('utf8'); }
  }
}

function resultText(result) {
  const stdout = decodeOutput(result && result.stdout).trim();
  const stderr = decodeOutput(result && result.stderr).trim();
  return stdout || stderr || String((result && result.error && result.error.message) || '').trim();
}

/*
 * Read the Runner-managed officecli version from components/active.json and include its
 * installation in client probe candidates so both processes discover the same engine.
 */
function _readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (_) { return null; }
}

function managedCandidates(env = process.env, platform = process.platform, options = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const exists = options.exists || fs.existsSync;
  const readJson = options.readJson || _readJsonFile;
  const root = String(env.SODUWORK_DATA_ROOT || '').trim() ||
    (env.LOCALAPPDATA ? paths.join(env.LOCALAPPDATA, 'soduwork') : '');
  if (!root) return [];
  const active = readJson(paths.join(root, 'components', 'active.json')) || {};
  const version = String((active.components && active.components.office) || '').trim();
  if (!/^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/.test(version)) return [];
  const name = platform === 'win32' ? 'officecli.exe' : 'officecli';
  return [paths.join(root, 'components', 'office', version, 'node_modules',
    '@officecli', 'officecli', 'vendor', name)].filter((item) => exists(item));
}

function managed(env = process.env, platform = process.platform, options = {}) {
  return managedCandidates(env, platform, options)[0] || '';
}

function candidates(env = process.env, platform = process.platform, explicitOnly = false) {
  const explicit = [env.SODUWORK_OFFICECLI, env.SODUWORK_OFFICECLI].filter(Boolean);
  const managed = explicitOnly ? [] : managedCandidates(env, platform);
  if (explicitOnly) return explicit;
  if (platform !== 'win32') {
    return [...explicit, ...managed, 'officecli'];
  }
  const appData = env.APPDATA || '';
  const local = env.LOCALAPPDATA || '';
  const profile = env.USERPROFILE || '';
  return [
    ...explicit,
    ...managed,
    appData && path.win32.join(appData, 'npm', 'officecli.cmd'),
    local && path.win32.join(local, 'OfficeCli', 'officecli.exe'),
    profile && path.win32.join(profile, '.local', 'bin', 'officecli.exe'),
    profile && path.win32.join(profile, '.local', 'bin', 'officecli.cmd'),
    'officecli.cmd',
  ].filter(Boolean);
}

function locate(options = {}) {
  const exists = options.exists || fs.existsSync;
  const platform = options.platform || process.platform;
  const list = candidates(options.env || process.env, platform, options.explicitOnly === true);
  if (platform !== 'win32') return list[0] || (options.explicitOnly ? '' : 'officecli');
  return list.find((item) => path.win32.isAbsolute(item) && exists(item)) ||
    list.at(-1) || (options.explicitOnly ? '' : 'officecli.cmd');
}

function probe(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const run = options.run || ((command, args, runOptions) => spawnSync(command, args, runOptions));
  const runOptions = {
    encoding: null, timeout: 2500, windowsHide: true, shell: false, env,
    windowsVerbatimArguments: platform === 'win32',
  };
  const command = locate(options);
  if (!command) return { ok: false, command: '', reason: '尚未配置 Office CLI 适配器' };
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const shellCommand = paths.isAbsolute(command)
    ? '"' + command.replace(/"/g, '""') + '" --version'
    : command + ' --version';
  const result = platform === 'win32' && /\.(?:cmd|bat)$/i.test(command)
    ? run(env.ComSpec || env.COMSPEC || 'cmd.exe',
      ['/d', '/s', '/c', shellCommand], runOptions)
    : run(command, ['--version'], runOptions);
  const output = resultText(result);
  const first = (output.split(/\r?\n/) || [''])[0].slice(0, 160);
  if (result && result.status === 0) {
    return { ok: true, command, detail: first || 'Office CLI 已就绪' };
  }
  const exists = options.exists || fs.existsSync;
  const installed = paths.isAbsolute(command) && exists(command);
  return {
    ok: false,
    command,
    reason: installed
      ? '已找到 Office CLI，但启动失败' + (first ? '：' + first : '')
      : '尚未安装 Office CLI',
  };
}

module.exports = { candidates, locate, managed, managedCandidates, probe, decodeOutput };
