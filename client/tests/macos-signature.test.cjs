'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const { verifySignature } = require('../../tools/ci/macos-signature.cjs');
const old = { version: '1.12.80', sha256: 'a5cbbf4cabb13904fe0bfe3d5b4cc019d2356ca41826c3900181a788008dceb5' };
const signatureError = Error('codesign rejected this bundle');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'soduwork-mac-signature-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const app = path.join(root, 'SoduWork.app'); await fs.mkdir(path.join(app, 'Contents'), { recursive: true });
  return { file: path.join(root, 'old.dmg'), app, legacyBaseline: old,
    execute: async () => { throw signatureError; }, fingerprintFile: async () => ({ sha256: old.sha256 }) };
}

test('current installers always require strict bundle signatures', async t => {
  const args = await fixture(t);
  delete args.legacyBaseline;
  await assert.rejects(verifySignature(args), error => error === signatureError);
  args.legacyBaseline = old; args.app = path.join(path.dirname(args.app), 'SoduWork.app');
  await assert.rejects(verifySignature(args), error => error === signatureError);
});

test('a verified bundle is recorded as strict and does not need a legacy exception', async t => {
  const args = await fixture(t);
  args.execute = async (command, values) => {
    assert.equal(command, 'codesign'); assert.deepEqual(values, ['--verify', '--deep', '--strict', args.app]);
  };
  args.fingerprintFile = async () => assert.fail('No exception is needed');
  assert.deepEqual(await verifySignature(args), { verified: true, policy: 'strict' });
});

test('only the exact known legacy archive may record its missing bundle signature', async t => {
  const args = await fixture(t);
  for (const sha256 of [old.sha256, '55bdf2a3804c7603d1d9a9318fc9f693715a70421c79ecd34902173f79983783']) {
    args.legacyBaseline = { ...old, sha256 };
    args.fingerprintFile = async () => ({ sha256 });
    assert.deepEqual(await verifySignature(args), { verified: false, policy: 'pinned-legacy-unsealed', ...old, sha256 });
  }
  args.fingerprintFile = async () => ({ sha256: '0'.repeat(64) });
  await assert.rejects(verifySignature(args), /unchanged pinned installer/);
});

test('unknown versions and hashes cannot use the historical exception', async t => {
  const args = await fixture(t);
  for (const legacyBaseline of [{ ...old, version: '1.12.84' }, { ...old, sha256: '0'.repeat(64) }])
    await assert.rejects(verifySignature({ ...args, legacyBaseline }), error => error === signatureError);
});

test('a present but invalid resource seal remains a failure', async t => {
  const args = await fixture(t);
  const seal = path.join(args.app, 'Contents/_CodeSignature/CodeResources');
  await fs.mkdir(path.dirname(seal)); await fs.writeFile(seal, 'invalid resource seal');
  await assert.rejects(verifySignature(args), /only covers the known missing resource seal/);
});
