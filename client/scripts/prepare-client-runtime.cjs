'use strict';
const path = require('node:path');

async function prepare(context) {
  const root = context.packager?.projectDir || path.resolve(__dirname, '..');
  const platform = context.electronPlatformName || process.platform;
  const arch = context.arch === undefined ? process.arch
    : typeof context.arch === 'string' ? context.arch : ({ 1: 'x64', 3: 'arm64' })[context.arch];
  if (!arch) throw Error('Unsupported client runtime architecture: ' + context.arch);
  await require('./prepare-node-runtime.cjs').prepare({ root, platform, arch });
  await require('./prepare-python-runtime.cjs').prepare({ root, platform, arch });
}
module.exports = prepare;
