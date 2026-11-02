'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Configure only the client process and its children, never the user's PATH.
// Electron's Node is retained for the Pi worker; native tools use this runtime.
function environment(base, { resourcesPath, platform = process.platform, exists = fs.existsSync } = {}) {
  const env = { ...base };
  if (!resourcesPath) return env;
  env.SODUWORK_RUNTIME_MANAGED = '1';
  const p = platform === 'win32' ? path.win32 : path.posix;
  const nodeDir = p.join(resourcesPath, 'node', platform === 'win32' ? '' : 'bin');
  const pythonDir = p.join(resourcesPath, 'python', platform === 'win32' ? '' : 'bin');
  const dirs = [];
  if (exists(p.join(nodeDir, platform === 'win32' ? 'node.exe' : 'node'))) dirs.push(nodeDir);
  const python = p.join(pythonDir, platform === 'win32' ? 'python.exe' : 'python3');
  delete env.SODUWORK_MANAGED_PYTHON;
  delete env.SODUWORK_OFFICE_PYTHON;
  if (exists(python)) {
    dirs.push(pythonDir);
    env.SODUWORK_MANAGED_PYTHON = python;
    env.SODUWORK_OFFICE_PYTHON = python;
  }
  if (platform === 'win32' && exists(p.join(resourcesPath, 'shell', 'bin', 'bash.exe'))) {
    dirs.push(p.join(resourcesPath, 'shell', 'cmd'), p.join(resourcesPath, 'shell', 'bin'), p.join(resourcesPath, 'shell', 'usr', 'bin'));
  }
  const pathKey = Object.keys(env).find(key => platform === 'win32' && key.toLowerCase() === 'path') || 'PATH';
  const separator = platform === 'win32' ? ';' : ':';
  env[pathKey] = [...new Set([...dirs, ...String(env[pathKey] || '').split(separator).filter(Boolean)])].join(separator);
  if (platform === 'win32') for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'path' && key !== pathKey) delete env[key];
  }
  // Ignore machine-wide injection into the product-owned interpreters.
  for (const key of Object.keys(env)) {
    if (/^(PYTHON.*|VIRTUAL_ENV|CONDA_PREFIX|CONDA_DEFAULT_ENV|NODE_OPTIONS|NODE_PATH)$/i.test(key)) delete env[key];
  }
  env.PYTHONNOUSERSITE = '1';
  env.PYTHONDONTWRITEBYTECODE = '1';
  return env;
}

function runtimeRoot(app, resourcesPath = process.resourcesPath) {
  if (app?.isPackaged) return resourcesPath;
  const source = app?.getAppPath?.();
  if (!source) return '';
  const root = path.join(source, '.runtime');
  const node = path.join(root, 'node', process.platform === 'win32' ? 'node.exe' : 'bin/node');
  return fs.existsSync(node) ? root : '';
}

function initialize(app, env = process.env, resourcesPath = process.resourcesPath) {
  const root = runtimeRoot(app, resourcesPath);
  if (!root) return;
  const prepared = environment(env, { resourcesPath: root });
  for (const key of Object.keys(env)) if (!(key in prepared)) delete env[key];
  Object.assign(env, prepared);
}

module.exports = { environment, initialize, runtimeRoot };
