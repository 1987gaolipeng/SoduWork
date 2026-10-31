'use strict';

// Build-time preparation only: installed clients never download a compiler or
// search the host PATH for Node/npm. Digests come from the official release:
// https://nodejs.org/download/release/v22.23.3/SHASUMS256.txt
const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { spawnSync } = require('node:child_process');

const VERSION = '22.23.3';
const DIGESTS = Object.freeze({
  'win32-x64': '2b0ff57b049cda1bbcea2240eec20467018713c1efe1f7360c2681859b90ed71',
  'win32-arm64': '33dad22e4cef5ee8f9fbb1b0d037fdacd0e56d12a4580f0d63f68b894deab535',
  'darwin-x64': '8a677b0219178efd6eb0e475457c4afb452b521a92f6e67845a73bd85727f2a8',
  'darwin-arm64': '23b25245dcfb9af7262f8ff142e9e2e0af025368117329e7a7458a51e5922f53',
  'linux-x64': '1084aa36196bba4c3a5e69a1ee388a6e4ff729dad09445fbcd434b28fe3c24af',
  'linux-arm64': '5ced2d48d1d7198739b7f86804de0171aefb6823b684b12341d3321afc3cb0b2',
});

function selectRelease(platform, arch, mirror = '') {
  const sha256 = DIGESTS[`${platform}-${arch}`];
  if (!sha256) throw Error(`Unsupported Node runtime target: ${platform}/${arch}`);
  const folder = `node-v${VERSION}-${platform === 'win32' ? 'win' : platform}-${arch}`;
  const file = folder + (platform === 'win32' ? '.zip' : '.tar.gz');
  const official = `https://nodejs.org/download/release/v${VERSION}/${file}`;
  const urls = [official];
  if (mirror) {
    if (new URL(mirror).protocol !== 'https:') throw Error('Node mirror must use HTTPS');
    urls.unshift(`${mirror.replace(/\/+$/, '')}/v${VERSION}/${file}`);
  }
  return { platform, arch, version: VERSION, file, folder, sha256, urls };
}

async function digest(file) {
  const sum = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) sum.update(chunk);
  return sum.digest('hex');
}

async function downloadFile(url, target, redirects = 0) {
  if (new URL(url).protocol !== 'https:' || redirects > 6) throw Error('Invalid runtime download redirect');
  const response = await new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { 'User-Agent': 'SoduWork-runtime-build' } }, resolve);
    request.setTimeout(60000, () => request.destroy(Error('Runtime download timed out')));
    request.on('error', reject);
  });
  if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
    response.resume();
    return downloadFile(new URL(response.headers.location, url).href, target, redirects + 1);
  }
  if (response.statusCode !== 200) {
    response.resume();
    throw Error(`Runtime download failed: HTTP ${response.statusCode}`);
  }
  await pipeline(response, fs.createWriteStream(target, { flags: 'w' }));
}

async function ensureArchive(release, cacheRoot, { download = downloadFile } = {}) {
  if (!/^[a-f0-9]{64}$/.test(release.sha256)) throw Error('Invalid runtime SHA-256');
  fs.mkdirSync(cacheRoot, { recursive: true });
  const archive = path.join(cacheRoot, release.sha256);
  if (fs.existsSync(archive) && await digest(archive) === release.sha256) return archive;
  const partial = path.join(cacheRoot, `.download-${crypto.randomUUID()}`);
  let lastError;
  try {
    for (const url of release.urls) {
      try {
        await download(url, partial);
        if (await digest(partial) !== release.sha256) throw Error('Runtime archive SHA-256 mismatch');
        // Concurrent builders publish only the same verified bytes. Windows
        // rename cannot replace a file held open, so accept a verified winner.
        try { fs.renameSync(partial, archive); }
        catch (error) {
          if (!fs.existsSync(archive) || await digest(archive) !== release.sha256) throw error;
        }
        return archive;
      } catch (error) { lastError = error; }
    }
    throw lastError || Error('No runtime download sources');
  } finally { fs.rmSync(partial, { force: true }); }
}

function extractArchive(archive, stage) {
  const tar = process.platform === 'win32'
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    : '/usr/bin/tar';
  const result = spawnSync(tar, ['-xf', archive, '-C', stage], {
    encoding: 'utf8', windowsHide: true, timeout: 300000,
  });
  if (result.status !== 0) throw Error(`Runtime extraction failed: ${result.error?.message || result.stderr || result.status}`);
}

function verifyRuntime(root, release, { probe = spawnSync } = {}) {
  const node = path.join(root, release.platform === 'win32' ? 'node.exe' : 'bin/node');
  const npm = path.join(root, release.platform === 'win32' ? 'node_modules/npm/bin/npm-cli.js' : 'lib/node_modules/npm/bin/npm-cli.js');
  for (const file of [node, npm, path.join(root, 'LICENSE')]) {
    if (!fs.statSync(file).isFile()) throw Error('Missing Node runtime component: ' + file);
  }
  const sameTarget = release.platform === process.platform && release.arch === process.arch;
  if (!sameTarget) return { executed: false, reason: 'Target requires native CI execution', node, npm };
  // Whitelist OS essentials. Never allow NODE_OPTIONS, Electron flags or user
  // npm configuration to influence validation of the shipped distribution.
  const env = { PATH: '' };
  for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  const result = probe(node, ['-p', 'JSON.stringify({version:process.versions.node,platform:process.platform,arch:process.arch})'], {
    env, encoding: 'utf8', windowsHide: true, timeout: 30000, shell: false,
  });
  if (result.status !== 0) throw Error('Bundled Node failed its clean-environment self-test');
  const actual = JSON.parse(result.stdout);
  if (actual.version !== release.version || actual.platform !== release.platform || actual.arch !== release.arch) {
    throw Error('Bundled Node runtime identity mismatch');
  }
  const npmResult = probe(node, [npm, '--version'], { env, encoding: 'utf8', windowsHide: true, timeout: 30000, shell: false });
  if (npmResult.status !== 0 || !/^\d+\.\d+\.\d+\s*$/.test(npmResult.stdout)) throw Error('Bundled npm failed its clean-environment self-test');
  return { executed: true, node, npm, npmVersion: npmResult.stdout.trim() };
}

async function renameRuntime(source, target) {
  // Windows may retain a loader/antivirus handle briefly after the native
  // self-test exits. Retry only sharing violations, never arbitrary failures.
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(source, target); return; }
    catch (error) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 10) throw error;
      await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1)));
    }
  }
}

async function contentInventory(root) {
  const entries = [];
  async function visit(folder) {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(folder, entry.name);
      const relative = path.relative(root, file).replaceAll('\\', '/');
      if (relative === '.soduwork-node-runtime.json') continue;
      if (entry.isSymbolicLink()) {
        const target = fs.readlinkSync(file);
        if (!path.resolve(folder, target).startsWith(path.resolve(root) + path.sep)) throw Error('Runtime link escapes its directory');
        entries.push([relative, 'link:' + target]);
      } else if (entry.isDirectory()) await visit(file);
      else entries.push([relative, await digest(file)]);
    }
  }
  await visit(root);
  return JSON.stringify(entries);
}

async function prepare({ root = path.resolve(__dirname, '..'), platform = process.platform,
  arch = process.env.npm_config_arch || process.arch, mirror = process.env.SODUWORK_NODE_MIRROR || 'https://npmmirror.com/mirrors/node',
  cacheRoot = process.env.SODUWORK_DOWNLOAD_CACHE || path.join(root, '.runtime-cache') } = {}) {
  const release = selectRelease(platform, arch, mirror);
  root = path.resolve(root);
  for (const candidate of [root, path.join(root, '.runtime'), path.join(root, '.runtime/node')]) {
    const stat = fs.lstatSync(candidate, { throwIfNoEntry: false });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw Error('Runtime output cannot be a symbolic link or file: ' + candidate);
  }
  const archive = await ensureArchive(release, cacheRoot);
  const parent = path.resolve(root, '.runtime');
  fs.mkdirSync(parent, { recursive: true });
  // Fail closed if another build owns this target. Do not publish mixed
  // architecture payloads or remove another builder's staging directory.
  const lock = path.join(parent, 'node.prepare-lock');
  fs.mkdirSync(lock);
  const stage = fs.mkdtempSync(path.join(parent, 'node.stage-'));
  const target = path.join(parent, 'node');
  const previous = path.join(stage, 'previous');
  let preserveStage = false;
  try {
    extractArchive(archive, stage);
    const extracted = path.join(stage, release.folder);
    // Compare with freshly verified archive bytes, not a presence-only cache.
    // Reusing identical files also avoids Windows loader locks during rebuilds.
    if (fs.existsSync(target) && await contentInventory(extracted) === await contentInventory(target)) {
      const checked = verifyRuntime(target, release);
      return { root: target, version: release.version, platform, arch, nativeSelfTest: checked.executed, sha256: release.sha256 };
    }
    const checked = verifyRuntime(extracted, release);
    fs.writeFileSync(path.join(extracted, '.soduwork-node-runtime.json'), JSON.stringify({
      schema: 1, version: release.version, platform, arch, sha256: release.sha256,
      source: release.urls.at(-1), nativeSelfTest: checked.executed,
    }, null, 2) + '\n');
    if (fs.existsSync(target)) await renameRuntime(target, previous);
    try { await renameRuntime(extracted, target); }
    catch (error) {
      if (fs.existsSync(previous)) {
        try { await renameRuntime(previous, target); }
        catch (restoreError) {
          preserveStage = true;
          throw Error(`Runtime activation and rollback failed; previous runtime preserved at ${previous}: ${restoreError.message}`);
        }
      }
      throw error;
    }
    return { root: target, version: release.version, platform, arch, nativeSelfTest: checked.executed, sha256: release.sha256 };
  } finally {
    // Both paths are created by this invocation beneath the fixed runtime
    // directory; no user-controlled runtime path is recursively removed.
    if (!preserveStage) fs.rmSync(stage, { recursive: true, force: true });
    fs.rmdirSync(lock);
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const options = {};
  for (const arg of args) {
    const match = arg.match(/^--(platform|arch)=(.+)$/);
    if (!match) throw Error('Usage: prepare-node-runtime.cjs [--platform=win32|darwin|linux] [--arch=x64|arm64]');
    options[match[1]] = match[2];
  }
  prepare(options).then(result => console.log(JSON.stringify(result))).catch(error => {
    console.error('SoduWork Node runtime preparation failed: ' + error.message);
    process.exitCode = 1;
  });
}

module.exports = { VERSION, selectRelease, digest, downloadFile, ensureArchive, extractArchive, verifyRuntime, contentInventory, prepare };
