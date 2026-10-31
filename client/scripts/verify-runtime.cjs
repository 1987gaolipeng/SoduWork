'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { validateRuntimeManifest } = require('../main/runtime-manifest.cjs');

function readManifest(root) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'runtime-manifest.json'), 'utf8'));
  const errors = validateRuntimeManifest(manifest);
  if (errors.length) throw Error(errors.join('; '));
  return manifest;
}
function runnerPath(root, platform = process.platform) {
  const relative = readManifest(path.resolve(__dirname, '..')).bundled.runner.relativePaths[platform];
  if (!relative) throw Error('Unsupported client platform: ' + platform);
  return path.join(root, ...relative.split('/'));
}
function requiredFiles(manifest, platform) {
  const runner = manifest.bundled.runner.relativePaths[platform];
  if (!runner) throw Error('Unsupported client platform: ' + platform);
  const common = [runner.replace(/^resources\//, ''),
    'pi/@earendil-works/pi-coding-agent/dist/cli.js', 'skills/office/SKILL.md'];
  return [...common, ...(platform === 'win32'
    ? ['node/node.exe', 'node/node_modules/npm/bin/npm-cli.js', 'python/python.exe', 'shell/bin/bash.exe', 'shell/cmd/git.exe']
    : ['node/bin/node', 'node/lib/node_modules/npm/bin/npm-cli.js', 'python/bin/python3'])];
}
function verify(root = path.resolve(__dirname, '..'), platform = process.platform,
  { packaged = false, resourcesPath = path.join(root, 'resources') } = {}) {
  const manifest = readManifest(packaged ? resourcesPath : root);
  const files = requiredFiles(manifest, platform);
  if (packaged) for (const relative of files) {
    const file = path.join(resourcesPath, ...relative.split('/'));
    if (!fs.existsSync(file) || !fs.statSync(file).isFile() || fs.statSync(file).size === 0) {
      throw Error('Bundled runtime file is missing or empty: ' + relative);
    }
  }
  return { ok: true, platform, packaged, checkedFiles: packaged ? files.length : 0,
    hostPrerequisites: manifest.hostPrerequisites,
    zeroPrerequisiteTarget: manifest.zeroPrerequisitePlatforms.includes(platform) };
}
function verifyExecutables(resourcesPath, platform, arch) {
  const node = require('./prepare-node-runtime.cjs');
  const release = node.selectRelease(platform, arch);
  const result = node.verifyRuntime(path.join(resourcesPath, 'node'), release);
  // A cross-architecture package must pass the native release acceptance job.
  if (platform === process.platform && arch === process.arch) {
    require('./prepare-python-runtime.cjs').selfTest(path.join(resourcesPath, 'python'), platform, arch);
  }
  return { nativeSelfTest: result.executed };
}
if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    const rootArg = args.find(arg => !arg.startsWith('--'));
    console.log(JSON.stringify(verify(rootArg ? path.resolve(rootArg) : undefined, process.platform,
      { packaged: args.includes('--packaged') })));
  } catch (error) { console.error('SoduWork runtime check failed: ' + error.message); process.exitCode = 1; }
}
module.exports = { readManifest, runnerPath, requiredFiles, verify, verifyExecutables };
