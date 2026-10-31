'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { VERSION, selectRelease, downloadFile, ensureArchive, verifyRuntime, contentInventory, prepare } = require('../scripts/prepare-node-runtime.cjs');

function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-node-build-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const hash = content => crypto.createHash('sha256').update(content).digest('hex');
test('runtime reuse detects changed and extra files while ignoring only build metadata', async t => {
  const root = directory(t);
  fs.writeFileSync(path.join(root, 'node.exe'), 'original');
  const original = await contentInventory(root);
  fs.writeFileSync(path.join(root, '.soduwork-node-runtime.json'), '{}');
  assert.equal(await contentInventory(root), original);
  fs.writeFileSync(path.join(root, 'node.exe'), 'tampered');
  assert.notEqual(await contentInventory(root), original);
  fs.writeFileSync(path.join(root, 'node.exe'), 'original');
  fs.writeFileSync(path.join(root, 'extra.js'), 'injected');
  assert.notEqual(await contentInventory(root), original);
});

test('all supported targets pin the same Node version and platform-specific official checksum', () => {
  const digests = new Set();
  for (const platform of ['win32', 'darwin', 'linux']) {
    for (const arch of ['x64', 'arm64']) {
      const release = selectRelease(platform, arch, 'https://mirror.example/node/');
      assert.equal(release.version, VERSION);
      assert.match(release.sha256, /^[a-f0-9]{64}$/);
      digests.add(release.sha256);
      assert.ok(release.file.includes(`-${arch}.`));
      assert.equal(release.urls[0], `https://mirror.example/node/v${VERSION}/${release.file}`);
      assert.equal(release.urls[1], `https://nodejs.org/download/release/v${VERSION}/${release.file}`);
    }
  }
  assert.equal(digests.size, 6);
  assert.throws(() => selectRelease('win32', 'x86'), /Unsupported/);
  assert.throws(() => selectRelease('linux', 'x64', 'http://mirror.example'), /HTTPS/);
});

test('archive cache checks bytes again and works offline after a verified download', async t => {
  const cache = directory(t);
  const content = Buffer.from('verified fixture');
  const release = { sha256: hash(content), urls: ['https://example.test/archive'] };
  let calls = 0;
  const download = async (_url, target) => { calls++; fs.writeFileSync(target, content); };
  const archive = await ensureArchive(release, cache, { download });
  assert.equal(await ensureArchive(release, cache, { download: async () => { throw Error('offline'); } }), archive);
  fs.writeFileSync(archive, 'corrupt');
  await ensureArchive(release, cache, { download });
  assert.equal(calls, 2);
  assert.equal(hash(fs.readFileSync(archive)), release.sha256);
  assert.deepEqual(fs.readdirSync(cache), [release.sha256]);
});

test('a compromised mirror cannot replace the trusted checksum; verified official fallback succeeds', async t => {
  const cache = directory(t);
  const content = 'official fixture';
  const release = { sha256: hash(content), urls: ['https://mirror.test/a', 'https://nodejs.org/a'] };
  const seen = [];
  const archive = await ensureArchive(release, cache, { download: async (url, target) => {
    seen.push(url);
    fs.writeFileSync(target, url.includes('mirror') ? 'wrong bytes' : content);
  } });
  assert.deepEqual(seen, release.urls);
  assert.equal(fs.readFileSync(archive, 'utf8'), content);
});

test('failed or mismatched downloads never publish an archive or leave partial files', async t => {
  const cache = directory(t);
  const release = { sha256: hash('expected'), urls: ['https://mirror.test/a'] };
  await assert.rejects(ensureArchive(release, cache, { download: async (_url, target) => {
    fs.writeFileSync(target, 'wrong bytes');
  } }), /SHA-256 mismatch/);
  assert.deepEqual(fs.readdirSync(cache), []);
  await assert.rejects(ensureArchive({ ...release, sha256: '../bad' }, cache), /Invalid runtime SHA/);
  await assert.rejects(downloadFile('http://insecure.test/a', path.join(cache, 'bad')), /Invalid runtime download/);
});

function runtimeFixture(t) {
  const root = directory(t);
  const release = selectRelease(process.platform, process.arch);
  const node = path.join(root, process.platform === 'win32' ? 'node.exe' : 'bin/node');
  const npm = path.join(root, process.platform === 'win32' ? 'node_modules/npm/bin/npm-cli.js' : 'lib/node_modules/npm/bin/npm-cli.js');
  for (const file of [node, npm, path.join(root, 'LICENSE')]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'fixture');
  }
  return { root, release, node, npm };
}

test('native self-test uses absolute bundled Node/npm with an empty PATH', t => {
  const { root, release, node, npm } = runtimeFixture(t);
  let calls = 0;
  const result = verifyRuntime(root, release, { probe: (binary, args, options) => {
    calls++;
    assert.equal(binary, node);
    assert.equal(options.env.PATH, '');
    assert.equal(options.env.NODE_OPTIONS, undefined);
    assert.equal(options.env.ELECTRON_RUN_AS_NODE, undefined);
    assert.equal(options.shell, false);
    if (args[0] === '-p') return { status: 0, stdout: JSON.stringify({ version: VERSION, platform: process.platform, arch: process.arch }) };
    assert.deepEqual(args, [npm, '--version']);
    return { status: 0, stdout: '10.9.8\n' };
  } });
  assert.equal(calls, 2);
  assert.equal(result.executed, true);
  assert.equal(result.npmVersion, '10.9.8');
});

test('wrong version and broken npm fail runtime preparation before activation', t => {
  const { root, release } = runtimeFixture(t);
  assert.throws(() => verifyRuntime(root, release, { probe: () => ({ status: 0,
    stdout: JSON.stringify({ version: '18.0.0', platform: process.platform, arch: process.arch }) }) }), /identity mismatch/);
  assert.throws(() => verifyRuntime(root, release, { probe: (_binary, args) => args[0] === '-p'
    ? { status: 0, stdout: JSON.stringify({ version: VERSION, platform: process.platform, arch: process.arch }) }
    : { status: 1, stderr: 'broken npm' } }), /npm failed/);
});

test('cross-architecture preparation never claims native execution', t => {
  const { root, release } = runtimeFixture(t);
  const result = verifyRuntime(root, { ...release, arch: process.arch === 'x64' ? 'arm64' : 'x64' }, {
    probe: () => { throw Error('foreign binary must not execute'); },
  });
  assert.equal(result.executed, false);
  assert.match(result.reason, /native CI/);
});

test('preparation rejects redirected runtime directories before downloading or replacing files', async t => {
  const root = directory(t);
  const external = directory(t);
  fs.writeFileSync(path.join(external, 'keep.txt'), 'untouched');
  fs.symlinkSync(external, path.join(root, '.runtime'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(prepare({ root }), /symbolic link/);
  assert.equal(fs.readFileSync(path.join(external, 'keep.txt'), 'utf8'), 'untouched');
  fs.unlinkSync(path.join(root, '.runtime'));
  fs.mkdirSync(path.join(root, '.runtime'));
  fs.symlinkSync(external, path.join(root, '.runtime/node'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(prepare({ root }), /symbolic link/);
  assert.equal(fs.readFileSync(path.join(external, 'keep.txt'), 'utf8'), 'untouched');
});
