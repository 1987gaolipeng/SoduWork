'use strict';
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict');
const { fingerprint } = require('./release-artifacts.cjs');
// These original SoduWork 1.12.80 DMGs predate bundle signing. Only these exact
// fixtures may test legacy upgrades without a resource seal; never re-sign them.
const legacyDigests = new Set([
  'a5cbbf4cabb13904fe0bfe3d5b4cc019d2356ca41826c3900181a788008dceb5',
  '55bdf2a3804c7603d1d9a9318fc9f693715a70421c79ecd34902173f79983783',
]);

async function verifySignature({ file, app, execute, legacyBaseline, fingerprintFile = fingerprint }) {
  try {
    await execute('codesign', ['--verify', '--deep', '--strict', app]);
    return { verified: true, policy: 'strict' };
  } catch (error) {
    if (legacyBaseline?.version !== '1.12.80' || !legacyDigests.has(legacyBaseline.sha256) ||
        path.basename(app) !== 'SoduWork.app') throw error;
    assert.equal((await fingerprintFile(file)).sha256, legacyBaseline.sha256,
      'Legacy signature exception requires the unchanged pinned installer');
    const seal = await fs.stat(path.join(app, 'Contents/_CodeSignature/CodeResources')).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    assert.equal(seal, null, 'Legacy signature exception only covers the known missing resource seal');
    return { verified: false, policy: 'pinned-legacy-unsealed', version: legacyBaseline.version,
      sha256: legacyBaseline.sha256 };
  }
}

module.exports = { verifySignature };
