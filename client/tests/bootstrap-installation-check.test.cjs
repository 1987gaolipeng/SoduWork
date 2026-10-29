'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawnSync } = require('node:child_process');
const { inventory } = require('../scripts/prepare-installer.cjs');
const { verify } = require('../build/verify-payload.cjs');
const archive = 'resources/runner/_internal/base_library.zip';

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-bootstrap-skip-'));
  t.after(() => {
    assert.equal(path.dirname(root), os.tmpdir());
    assert.ok(path.basename(root).startsWith('soduwork-bootstrap-skip-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.mkdirSync(path.dirname(path.join(root, archive)), { recursive: true });
  fs.writeFileSync(path.join(root, archive), 'GOOD');
  fs.writeFileSync(path.join(root, 'runtime.dll'), 'GOOD');
  await inventory(root);
  return root;
}
test('installation skips only bootstrap archive content, including length and same-size hash changes', async t => {
  const root = await fixture(t), file = path.join(root, archive);
  for (const data of [Buffer.concat([Buffer.alloc(4096), Buffer.from('GOOD')]), Buffer.from('EVIL'), Buffer.from('X')]) {
    fs.writeFileSync(file, data);
    const skipped = [];
    assert.equal(await verify(root, [], { installationMode: true, onContentCheckSkipped: x => skipped.push(x) }), 4);
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].path, archive);
    assert.equal(skipped[0].verification, 'existence-only');
    assert.equal(skipped[0].actualSha256, undefined);
    assert.equal(skipped[0].actualSize, undefined);
    await assert.rejects(verify(root), /Incomplete payload|Corrupt payload/);
  }
});
test('installation does not open or hash bootstrap archive contents', async t => {
  const root = await fixture(t), file = path.join(root, archive), original = fs.createReadStream, originalOpen = fs.promises.open;
  t.mock.method(fs, 'createReadStream', function(target, ...args) {
    assert.notEqual(target, file, 'bootstrap content must not be opened');
    return original.call(fs, target, ...args);
  });
  t.mock.method(fs.promises, 'open', function(target, ...args) {
    assert.notEqual(target, file, 'parallel verification must not open the bootstrap archive');
    return originalOpen.call(fs.promises, target, ...args);
  });
  assert.equal(await verify(root, [], { installationMode: true }), 4);
});
test('missing, empty or directory bootstrap archive is still rejected', async t => {
  const root = await fixture(t), file = path.join(root, archive);
  const options = { installationMode: true, sleep: async () => {} };
  fs.unlinkSync(file);
  await assert.rejects(verify(root, [], options), /ENOENT/);
  fs.writeFileSync(file, '');
  await assert.rejects(verify(root, [], options), /Empty payload file/);
  fs.unlinkSync(file); fs.mkdirSync(file);
  await assert.rejects(verify(root, [], options), /Invalid payload file type/);
});
test('bootstrap symlink cannot obtain installation content exemption', async t => {
  const root = await fixture(t), file = path.join(root, archive), original = fs.promises.lstat;
  t.mock.method(fs.promises, 'lstat', async function(target, ...args) {
    const stat = await original.call(fs.promises, target, ...args);
    if (target === file) stat.isSymbolicLink = () => true;
    return stat;
  });
  await assert.rejects(verify(root, [], { installationMode: true }), /Invalid payload file type/);
});
test('other ZIP, TXT, DLL, application code and app archives retain content checks', async t => {
  const root = await fixture(t);
  const others = ['runtime.dll', 'resources/other/base_library.zip', 'resources/app.asar', 'resources/code.js', 'resources/help.txt'];
  for (const name of others) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), 'GOOD');
  }
  await inventory(root);
  for (const name of others) {
    fs.writeFileSync(path.join(root, name), 'EVIL');
    await assert.rejects(verify(root, [], { installationMode: true }), error => {
      assert.equal(error.details.path, name); assert.equal(error.errorCount, 1); return true;
    });
    fs.writeFileSync(path.join(root, name), 'GOOD');
  }
});
test('CLI installation records partial content verification while default release checking remains strict', async t => {
  const root = await fixture(t), report = path.join(root, 'report.json');
  const script = path.resolve(__dirname, '../build/verify-payload.cjs');
  const invoke = args => spawnSync(process.execPath, [script, root, report, ...args], {
    encoding: 'utf8', windowsHide: true, timeout: 10000,
  });
  let result = invoke([]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(fs.readFileSync(report)).fullContentVerified, true);
  fs.appendFileSync(path.join(root, archive), Buffer.alloc(4096));
  result = invoke([]);
  assert.equal(result.status, 2);
  result = invoke(['--installation']);
  assert.equal(result.status, 0, result.stderr);
  const details = JSON.parse(fs.readFileSync(report));
  assert.equal(details.ok, true);
  assert.equal(details.fullContentVerified, false);
  assert.equal(details.verificationMode, 'installation');
  assert.equal(details.contentCheckSkips.length, 1);
  assert.equal(details.contentCheckSkips[0].path, archive);
  assert.match(result.stdout, /content check skipped/);
});
