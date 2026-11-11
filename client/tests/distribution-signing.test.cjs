'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

for (const id of ['cn', 'global']) test(`${id} signing requires its own key and exact accepted artifact evidence`, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-cloud-signing-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const dir of ['ops', 'client/main', 'client/scripts']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  const source = path.resolve(__dirname, '../..');
  for (const file of ['ops/sign-upload-client-release.mjs', 'client/main/distribution.cjs',
    'client/update-trust.json', 'client/scripts/installer-compatibility-report.cjs']) {
    fs.copyFileSync(path.join(source, file), path.join(root, file));
  }
  const key = crypto.generateKeyPairSync('ed25519');
  const keyId = 'fixture-' + id;
  const profiles = JSON.parse(fs.readFileSync(path.join(source, 'client/distributions.json')));
  profiles[id].updateTrust = { schema: 1, keys: { [keyId]: key.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64') } };
  fs.writeFileSync(path.join(root, 'client/distributions.json'), JSON.stringify(profiles));
  fs.writeFileSync(path.join(root, 'client/package.json'), '{}');
  const profile = require(path.join(root, 'client/main/distribution.cjs')).getProfile(id);
  const seed = path.join(root, 'seed');
  fs.writeFileSync(seed, Buffer.from(key.privateKey.export({ format: 'jwk' }).d, 'base64url').toString('base64'), { mode: 0o600 });
  const installer = path.join(root, 'SoduWork-1.13.3-linux.deb');
  const contents = Buffer.alloc(1048576, 0x42);
  fs.writeFileSync(installer, contents);
  const receiptPath = path.join(root, 'acceptance.json');
  const receipt = { schema: 1, ok: true, version: '1.13.3', sourceCommit: 'a'.repeat(40), pipelineId: '100',
    distribution: { id, hubUrl: profile.hubOrigin, configSha256: profile.configSha256 },
    artifacts: [{ name: path.basename(installer), size: contents.length, sha256: crypto.createHash('sha256').update(contents).digest('hex'), platform: 'linux', arch: 'x64' }] };
  const env = { ...process.env, SODUWORK_DISTRIBUTION: id, SODUWORK_RELEASE_HUB_URL: profile.hubOrigin,
    SODUWORK_CLIENT_PLATFORM: 'linux', SODUWORK_CLIENT_ARCH: 'x64', SODUWORK_CLIENT_CHANNEL: 'stable',
    CI_COMMIT_SHA: receipt.sourceCommit, CI_PIPELINE_ID: receipt.pipelineId,
    SODUWORK_CLIENT_SIGNING_KEY_FILE: seed, SODUWORK_CLIENT_SIGNING_KEY_ID: keyId,
    SODUWORK_CLIENT_TRUST_FILE: '', SODUWORK_CLIENT_RELEASE_BUNDLE: path.join(root, 'bundle.json'),
    SODUWORK_CLIENT_DISTRIBUTION_RECEIPT: receiptPath };
  const run = override => spawnSync(process.execPath, [path.join(root, 'ops/sign-upload-client-release.mjs'), installer, '--dry-run'],
    { env: { ...env, ...override }, encoding: 'utf8' });
  assert.notEqual(run().status, 0, 'missing acceptance evidence must block signing');
  for (const invalid of [
    { ...receipt, distribution: { ...receipt.distribution, id: 'internal' } },
    { ...receipt, pipelineId: 'another-pipeline' },
    { ...receipt, artifacts: [{ ...receipt.artifacts[0], sha256: '0'.repeat(64) }] },
  ]) {
    fs.writeFileSync(receiptPath, JSON.stringify(invalid));
    const result = run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /evidence differs/);
    assert.equal(fs.existsSync(env.SODUWORK_CLIENT_RELEASE_BUNDLE), false);
  }
  fs.writeFileSync(receiptPath, JSON.stringify(receipt));
  assert.notEqual(run({ SODUWORK_CLIENT_SIGNING_KEY_ID: 'another-environment-key' }).status, 0);
  assert.notEqual(run({ SODUWORK_CLIENT_TRUST_FILE: path.join(root, 'client/update-trust.json') }).status, 0);
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(fs.readFileSync(env.SODUWORK_CLIENT_RELEASE_BUNDLE));
  require('../main/client-update-contract').validateManifest(manifest, profile.updateTrust, 'linux');
  assert.equal(manifest.schema, 1, 'retain the deployed Hub update protocol');
  assert.equal(Object.hasOwn(manifest, 'distribution'), false);
});
