'use strict';

// Rebuild the frozen Windows Runner only when its inputs actually changed. A
// leftover executable alone is not evidence that it contains the current
// Runner, access policy or bundled skill sources - so the cache key covers the
// PyInstaller recipe, the build script, the entrypoint, every module under
// app/, the packaged agent catalog, the shared skills tree, the runner
// requirements and the build virtualenv's installed package set. Any digest
// change recompiles. The cache entry is additionally bound to the compiled
// artifact's SHA-256: a restored build cache or manual copy can silently swap
// in another machine's build (or an older one) - a digest
// match alone never satisfies the cache. The darwin/linux runners always
// rebuild: their PyInstaller pass is comparatively cheap and their output is
// not cached (both binaries are gitignored build artifacts).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

function _hashFile(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function _walk(root, ignored, out) {
  // Mirrors app.services.runner_sources.skill_files: skip symlinks,
  // __pycache__/node_modules/.venv/.git and compiled bytecode.
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const p = path.join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) { _walk(p, ignored, out); continue; }
    if (entry.name.endsWith('.pyc') || entry.name.endsWith('.pyo')) continue;
    out.add(p);
  }
  return out;
}

function inputDigest(root = path.resolve(__dirname, '../..')) {
  const backend = path.join(root, 'hub-backend');
  const files = new Set(['runner_main.py', 'runner.spec', 'build-runner.ps1',
    'requirements-runner.txt', 'requirements-runner-build.txt']
    .map(name => path.join(backend, name)));
  files.add(path.join(root, 'LICENSE')); // Embedded by runner.spec, including copyright corrections.
  files.add(path.join(root, 'tools/distribution/PUBLIC-SOURCE.json'));
  const thirdParty = path.join(root, 'third-party');
  if (fs.existsSync(thirdParty)) _walk(thirdParty, new Set(['__pycache__']), files);
  _walk(path.join(backend, 'app'), new Set(['__pycache__']), files);
  if (fs.existsSync(path.join(root, 'skills'))) {
    _walk(path.join(root, 'skills'), new Set(['__pycache__', 'node_modules', '.venv', '.git']), files);
  }
  const hash = crypto.createHash('sha256');
  for (const file of [...files].filter(f => fs.existsSync(f)).sort()) {
    hash.update(path.relative(root, file).replaceAll('\\', '/'));
    hash.update('\0');
    hash.update(_hashFile(file));
    hash.update('\0');
  }
  // Installed package set of the build virtualenv: an upgraded dependency
  // changes the frozen output even when sources stay identical.
  try {
    const site = path.join(backend, '.venv', 'Lib', 'site-packages');
    hash.update(fs.readdirSync(site).filter(n => n.endsWith('.dist-info')).sort().join('\n'));
  } catch (_) { /* fingerprint stays source-only when the venv is absent */ }
  return hash.digest('hex');
}

function fileCache(root) {
  const file = path.join(root, 'client', '.runtime', 'runner-build-cache.json');
  return {
    read() { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; } },
    write(data) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data)); },
  };
}

function _buildWindowsRunner({ root, run, exists, cache, digest, hashFile = _hashFile }) {
  const backend = path.join(root, 'hub-backend');
  const python = path.join(backend, '.venv', 'Scripts', 'python.exe');
  if (!exists(python)) throw new Error('Create hub-backend/.venv and install requirements-runner-build.txt before packaging.');
  const store = cache || fileCache(root);
  const fingerprint = digest !== undefined ? digest : inputDigest(root);
  const binary = path.join(root, 'client', 'runner', 'soduwork-runner.exe');
  if (fingerprint && exists(binary)) {
    const cached = store.read();
    // The digest only attests the sources. A restored build cache can replace
    // the executable with another machine's build of a
    // different source revision; only the artifact hash recorded by the last
    // local build proves the file on disk is the one this cache vouches for.
    if (cached && cached.digest === fingerprint && cached.exeSha256) {
      let actual = null;
      try { actual = hashFile(binary); } catch (_) { /* unreadable artifact → rebuild */ }
      if (actual === cached.exeSha256) return binary;
    }
  }
  const result = run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(backend, 'build-runner.ps1')], { cwd: root, windowsHide: true, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('Runner compilation failed; client packaging stopped.');
  if (!exists(binary)) throw new Error('Runner compilation did not produce soduwork-runner.exe.');
  if (fingerprint) {
    let size = null;
    try { size = fs.statSync(binary).size; } catch (_) { /* record absent, cache still valid by digest */ }
    // hashFile on our own fresh artifact must succeed; failing here means the
    // build output is unreadable and the run must not report success.
    store.write({ digest: fingerprint, exeSize: size, exeSha256: hashFile(binary) });
  }
  return binary;
}

function _buildPosixRunner({ root, run, exists, dist = path.join(root, 'client', 'runner'),
  python = path.join(root, 'hub-backend', '.venv', 'bin', 'python'), env = process.env }) {
  const backend = path.join(root, 'hub-backend');
  if (!exists(python)) throw new Error('Create hub-backend/.venv and install requirements-runner-build.txt before packaging.');
  // Same recipe as build-runner.ps1: isolated work dir under the system temp,
  // always removed, never touching the shared temp root or the output binary.
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-runner-build-'));
  try {
    const result = run(python, ['-m', 'PyInstaller', '--noconfirm', '--clean',
      '--distpath', dist, '--workpath', work, path.join(backend, 'runner.spec')],
      { env, cwd: root, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error('Runner compilation failed; client packaging stopped.');
    const binary = path.join(dist, 'soduwork-runner');
    if (!exists(binary)) throw new Error('Runner compilation did not produce soduwork-runner.');
    fs.chmodSync(binary, 0o755);
    return binary;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

function prepareRunner({ root = path.resolve(__dirname, '../..'), platform = process.platform,
  run = spawnSync, exists = fs.existsSync, cache, digest, hashFile, ...rest } = {}) {
  if (platform === 'win32') return _buildWindowsRunner({ root, run, exists, cache, digest, hashFile });
  if (platform === 'darwin' || platform === 'linux') return _buildPosixRunner({ root, run, exists, ...rest });
  throw new Error('The Windows, macOS and Linux Runner must each be built on their native platform.');
}

if (require.main === module) {
  try { console.log(prepareRunner()); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { prepareRunner, inputDigest, fileCache };
