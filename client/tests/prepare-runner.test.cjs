'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { prepareRunner, inputDigest } = require('../scripts/prepare-runner.cjs');

const noopCache = () => ({ read: () => null, write() {} });

test('packaging recompiles Runner when the input digest is not cached', () => {
  let calls = 0;
  const binary = prepareRunner({ platform: 'win32', exists: () => true, cache: noopCache(),
    hashFile: () => 'artifact-built-here',
    digest: 'fingerprint-1', run(bin, args, options) {
      calls++;
      assert.equal(bin, 'powershell.exe');
      assert.match(args.at(-1), /build-runner\.ps1$/);
      assert.equal(options.windowsHide, true);
      return { status: 0 };
    } });
  assert.equal(calls, 1);
  assert.match(binary, /soduwork-runner\.exe$/);
});

test('an unchanged digest reuses the compiled Runner instead of recompiling', () => {
  let calls = 0;
  const binary = prepareRunner({ platform: 'win32', exists: () => true, digest: 'fingerprint-1',
    hashFile: () => 'artifact-built-here',
    cache: { read: () => ({ digest: 'fingerprint-1', exeSize: 15, exeSha256: 'artifact-built-here' }),
      write() { throw Error('must not persist on hit'); } },
    run: () => { calls++; return { status: 0 }; } });
  assert.equal(calls, 0);
  assert.match(binary, /soduwork-runner\.exe$/);
});

test('an executable swapped in by git (another machine\'s build) invalidates the cache even when the digest matches', () => {
  let calls = 0;
  let writes = [];
  // The cached entry vouches for the artifact this machine built last time;
  // the injected hashFile reports what is actually on disk now: a foreign exe.
  prepareRunner({ platform: 'win32', exists: () => true, digest: 'fingerprint-1',
    hashFile: () => 'artifact-from-another-machine',
    cache: { read: () => ({ digest: 'fingerprint-1', exeSize: 15, exeSha256: 'artifact-built-here' }),
      write: data => writes.push(data) },
    run: () => { calls++; return { status: 0 }; } });
  assert.equal(calls, 1, 'a foreign artifact must force a verified rebuild');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].exeSha256, 'artifact-from-another-machine');
});

test('a legacy cache entry without an artifact hash cannot satisfy the cache', () => {
  let calls = 0;
  prepareRunner({ platform: 'win32', exists: () => true, digest: 'fingerprint-1',
    hashFile: () => 'artifact-built-here',
    cache: { read: () => ({ digest: 'fingerprint-1', exeSize: 15 }), write() {} },
    run: () => { calls++; return { status: 0 }; } });
  assert.equal(calls, 1);
});

test('a changed or missing digest invalidates the cache and records the new one', () => {
  let writes = [];
  const cache = { read: () => ({ digest: 'fingerprint-old', exeSize: 1 }), write: data => writes.push(data) };
  prepareRunner({ platform: 'win32', exists: () => true, digest: 'fingerprint-new', cache,
    hashFile: () => 'artifact-new', run: () => ({ status: 0 }) });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].digest, 'fingerprint-new');
  assert.equal(writes[0].exeSha256, 'artifact-new');
});

test('a missing executable forces a rebuild even when the digest matches', () => {
  let calls = 0;
  let built = false;
  prepareRunner({ platform: 'win32',
    exists: file => String(file).endsWith('soduwork-runner.exe') ? built : true,
    digest: 'fingerprint-1',
    cache: { read: () => ({ digest: 'fingerprint-1', exeSha256: 'artifact-built-here' }), write() {} },
    hashFile: () => 'artifact-built-here',
    run: () => { calls++; built = true; return { status: 0 }; } });
  assert.equal(calls, 1);
});

test('a stale executable cannot mask a failed or interrupted build', () => {
  for (const result of [{ status: 1 }, { status: null, signal: 'SIGTERM' }, { error: Error('spawn failed') }]) {
    assert.throws(() => prepareRunner({ platform: 'win32', exists: () => true, cache: noopCache(),
      digest: 'fingerprint-1', run: () => result }));
  }
});

test('the Linux Runner follows the same POSIX PyInstaller recipe as macOS', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-runner-linux-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'soduwork-runner'), 'fresh');
  const calls = [];
  const binary = prepareRunner({ platform: 'linux', exists: () => true, dist: root,
    run(bin, args) { calls.push([bin, args]); return { status: 0 }; } });
  assert.equal(binary, path.join(root, 'soduwork-runner'));
  assert.match(calls[0][0], /\.venv[\\/]bin[\\/]python$/);
  assert.equal(calls[0][1][0], '-m');
  assert.equal(calls[0][1][1], 'PyInstaller');
  assert.deepEqual(calls[0][1].slice(2, 4), ['--noconfirm', '--clean']);
  assert.match(calls[0][1].at(-1), /runner\.spec$/);
});

test('missing prerequisites or build output stop packaging', () => {
  for (const platform of ['darwin', 'linux']) {
    assert.throws(() => prepareRunner({ platform, exists: () => false }), /requirements-runner-build/);
  }
  assert.throws(() => prepareRunner({ platform: 'sunos' }), /Windows/);
  assert.throws(() => prepareRunner({ platform: 'win32', exists: () => false }), /requirements-runner-build/);
  assert.throws(() => prepareRunner({ platform: 'win32', exists: file => !file.endsWith('soduwork-runner.exe'),
    cache: noopCache(), digest: 'fingerprint-1', run: () => ({ status: 0 }) }), /did not produce/);
});

test('the POSIX PyInstaller child receives the scoped build environment', t => {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-runner-env-'));
  t.after(() => fs.rmSync(dist, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dist, 'soduwork-runner'), 'fresh');
  const env = { PATH: '/Apple Tools/bin:/usr/bin', MARKER: 'isolated' };
  prepareRunner({ platform: 'darwin', exists: () => true, dist, env,
    run(_bin, _args, options) { assert.equal(options.env, env); return { status: 0 }; } });
});

test('the real input digest is a stable 64-hex fingerprint', () => {
  const digest = inputDigest();
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(inputDigest(), digest);
});

test('editing nested Runner code or a bundled skill invalidates the actual source cache', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-runner-digest-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = path.join(root, 'hub-backend/app/services');
  const skill = path.join(root, 'skills/fixture');
  fs.mkdirSync(app, { recursive: true }); fs.mkdirSync(skill, { recursive: true });
  const module = path.join(app, 'runner.py'), guide = path.join(skill, 'SKILL.md');
  fs.writeFileSync(module, 'original'); fs.writeFileSync(guide, 'original');
  const initial = inputDigest(root);
  fs.writeFileSync(module, 'patched');
  const patched = inputDigest(root);
  assert.notEqual(patched, initial);
  fs.writeFileSync(guide, 'patched skill');
  const revisedSkill = inputDigest(root);
  assert.notEqual(revisedSkill, patched);
  fs.mkdirSync(path.join(app, '__pycache__'));
  fs.writeFileSync(path.join(app, '__pycache__/fixture.pyc'), 'ignored');
  assert.equal(inputDigest(root), revisedSkill);
  fs.unlinkSync(module);
  assert.notEqual(inputDigest(root), revisedSkill, 'removed modules also invalidate the cache');
});

test('updating the embedded project license invalidates the Windows Runner cache', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-license-digest-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'hub-backend/app'), { recursive: true });
  const license = path.join(root, 'LICENSE');
  fs.writeFileSync(license, 'Original license and copyright');
  const before = inputDigest(root);
  fs.writeFileSync(license, 'Corrected license and copyright');
  assert.notEqual(inputDigest(root), before);
});

test('third-party notices and source release policy invalidate the Runner cache', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-policy-digest-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'hub-backend/app'), { recursive: true });
  fs.mkdirSync(path.join(root, 'third-party/licenses'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tools/distribution'), { recursive: true });
  const notice = path.join(root, 'third-party/licenses/fixture-LICENSE.txt');
  const policy = path.join(root, 'tools/distribution/PUBLIC-SOURCE.json');
  fs.writeFileSync(notice, 'Original third-party notice');
  fs.writeFileSync(policy, JSON.stringify({ sourceOnly: true }));
  const original = inputDigest(root);
  fs.writeFileSync(notice, 'Corrected third-party notice');
  const corrected = inputDigest(root);
  assert.notEqual(corrected, original);
  fs.writeFileSync(policy, JSON.stringify({ sourceOnly: false }));
  assert.notEqual(inputDigest(root), corrected);
});
