'use strict';
// Only a complete, verified pair of native shards can become a publishable inventory.
const path = require('node:path');
const contract = require('./release-artifacts.cjs');

async function merge() {
  const checks = [], limitations = new Set(), shards = [];
  for (const arch of ['arm64', 'x64']) {
    const build = await contract.verify('macos', arch);
    const receipt = await contract.read(path.join(contract.root, 'release-evidence/macos', arch, 'acceptance.json'));
    contract.validateAcceptance(build, receipt);
    checks.push(...receipt.checks);
    for (const limitation of receipt.limitations) limitations.add(limitation);
    shards.push({ arch, jobId: build.jobId, artifacts: build.artifacts });
  }
  const record = await contract.inventory('macos');
  record.shards = shards;
  await contract.write(path.join(contract.dist, 'macos-build.json'), record);
  await contract.acceptance('macos', checks, [...limitations]);
  return record;
}
module.exports = { merge };
if (require.main === module) merge().then(record => console.log(JSON.stringify(record)))
  .catch(error => { console.error(error); process.exitCode = 1; });
