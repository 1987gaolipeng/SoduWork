'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startupMode, unlock } = require('../main/linux-device-vault.cjs');

function profile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-vault-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const passphrase = 'a separate local passphrase';
const hub = 'https://fixture.invalid';
const clientId = 'fixture-device';

test('offer vault creation only when there is no identity in either native credential file', async t => {
  const dir = profile(t);
  const ready = () => true;
  const missing = () => false;
  assert.equal(startupMode(dir, ready), 'native');
  assert.equal(startupMode(dir, missing), 'create');
  const empty = JSON.stringify({ v: 1, activeHub: hub, profiles: {} });
  fs.writeFileSync(path.join(dir, 'device-auth.json'), empty);
  assert.equal(startupMode(dir, missing), 'create');
  const backup = path.join(dir, 'device-auth.json.bak');
  for (const contents of ['invalid', '{"v":1,"profiles":[]}', '{"v":1,"profiles":{"existing":{}}}']) {
    fs.writeFileSync(backup, contents);
    assert.equal(startupMode(dir, missing), 'recover');
    assert.equal(startupMode(dir, ready), 'native');
  }
  await assert.rejects(unlock(dir, 'create', passphrase));
  assert.deepEqual(fs.readdirSync(dir).sort(), ['device-auth.json', 'device-auth.json.bak']);
});

test('vault credentials reopen only with the original passphrase, device and Hub', async t => {
  const dir = profile(t);
  const store = await unlock(dir, 'create', passphrase);
  const secret = 'synthetic-device-secret';
  const encrypt = () => store.encrypt(secret, hub, clientId).toString('base64');
  const row = { storage: store.storage, cipher: encrypt(), hub, clientId };
  assert.notEqual(row.cipher, encrypt());
  assert.ok(!Buffer.from(row.cipher, 'base64').includes(Buffer.from(secret)));
  const [name] = fs.readdirSync(dir);
  const header = path.join(dir, name);
  const original = fs.readFileSync(header);
  if (process.platform === 'linux') assert.equal(fs.statSync(header).mode & 0o777, 0o600);
  assert.ok(!original.includes(Buffer.from(passphrase)));
  assert.equal(startupMode(dir, () => assert.fail('must retain the chosen vault')), 'unlock');
  await assert.rejects(unlock(dir, 'unlock', 'different passphrase'));
  await assert.rejects(unlock(dir, 'create', 'another passphrase'));
  assert.deepEqual(fs.readFileSync(header), original);
  const reopened = await unlock(dir, 'unlock', passphrase);
  assert.equal(reopened.decrypt('', row), secret);
  const tampered = Buffer.from(row.cipher, 'base64');
  tampered[tampered.length - 1] ^= 1;
  for (const change of [{ cipher: tampered.toString('base64') }, { hub: hub + '/other' },
    { clientId: clientId + '-other' }, { storage: 'electron-safe-storage' }]) {
    assert.throws(() => reopened.decrypt('', { ...row, ...change }));
  }
  fs.writeFileSync(header, 'truncated');
  await assert.rejects(unlock(dir, 'unlock', passphrase));
  assert.equal(startupMode(dir, () => true), 'unlock');
});

test('reject empty and out-of-bounds passphrases before creating files', async t => {
  const dir = profile(t);
  for (const invalid of [null, 'short', ' '.repeat(12), 'x'.repeat(257)]) {
    await assert.rejects(unlock(dir, 'create', invalid));
  }
  assert.deepEqual(fs.readdirSync(dir), []);
});
