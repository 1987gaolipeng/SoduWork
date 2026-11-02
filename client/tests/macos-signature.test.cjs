'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const { verifySignature } = require('../../tools/ci/macos-signature.cjs');
const signatureError = Error('codesign rejected this bundle');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'soduwork-mac-signature-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const app = path.join(root, 'SoduWork.app'); await fs.mkdir(path.join(app, 'Contents'), { recursive: true });
  return { file: path.join(root, 'SoduWork.dmg'), app,
    execute: async () => { throw signatureError; } };
}

test('current installers always require strict bundle signatures', async t => {
  const args = await fixture(t);
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
