'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { concurrency, transferAll, verifyDownload } = require('./release-transfer.cjs');
const contract = require('./release-artifacts.cjs');
const publisher = require('./publish-client.cjs');
const { validateManifest } = require('../../client/main/client-update-contract.js');
const trust = require('../../client/update-trust.json');

function publicRoutes(item) {
  if (item.platform === 'win32') return ['/api/v1/download/client/info', '/api/v1/download/client'];
  if (item.platform === 'linux') return ['/api/v1/download/client/linux/info', '/api/v1/download/client/linux/' + item.format];
  return ['/api/v1/download/client/mac/info', '/api/v1/download/client/mac/' + item.arch];
}
async function main() {
  const limit = concurrency();
  require('./client-target.cjs').requireTarget();
  const notes = require('./client-release-notes.cjs').read();
  const remote = await publisher.connection();
  const { entries, channel } = await publisher.stagedEntries(remote);
  assert.equal(channel, 'stable', 'Public download verification requires the stable channel');
  const activation = await contract.read(path.join(contract.root, 'release-evidence/activation.json'));
  assert.equal(activation.ok, true);
  assert.equal(activation.sourceCommit, process.env.CI_COMMIT_SHA);
  assert.equal(String(activation.pipelineId), process.env.CI_PIPELINE_ID);
  assert.deepEqual([...activation.enabled].sort(), entries.map(({ item }) => item.releaseId).sort());
  const rows = (await remote.request('/api/v1/admin/client-releases')).releases;
  const report = { schema: 1, ok: false, hub: remote.url, sourceCommit: process.env.CI_COMMIT_SHA,
    pipelineId: process.env.CI_PIPELINE_ID, distribution: distributions.identity(), notesSha256: notes.notesSha256, artifacts: [] };
  await contract.write(path.join(contract.evidence, 'publication-verification.json'), report);
  try {
    await transferAll(entries, async ({ item, build }) => {
      const row = rows.find(row => row.id === item.releaseId);
      assert.ok(publisher.matches(row, item, build, channel) && row.enabled === true);
      const bundle = await contract.read(path.join(contract.root, 'release-evidence', build.platform,
        'staged', item.name + '.' + channel + '.release.json'));
      validateManifest(bundle, trust, item.platform);
      assert.equal(bundle.releaseId, item.releaseId);
      assert.deepEqual({ name: bundle.artifact.name, size: bundle.artifact.size, sha256: bundle.artifact.sha256 },
        { name: item.name, size: item.size, sha256: item.sha256 });
      const [infoRoute] = publicRoutes(item);
      const downloadUrl = remote.url + '/api/v1/download/client/releases/' + encodeURIComponent(item.releaseId);
      const response = await fetch(remote.url + infoRoute, { redirect: 'error', signal: AbortSignal.timeout(60000) });
      assert.ok(response.ok, 'Public installer metadata is unavailable');
      const info = await response.json();
      const metadata = item.platform === 'win32' ? info : item.platform === 'linux' ? info.formats[item.format]
        : info.arches[item.arch];
      assert.ok(metadata, 'Public installer format is missing');
      if (item.platform === 'darwin' && metadata.filename !== item.name) {
        // The existing macOS API exposes one default format per architecture.
        assert.ok(entries.some(({ item: candidate }) => candidate.platform === 'darwin'
          && candidate.arch === item.arch && candidate.name === metadata.filename));
        // Its fixed Release URL is still verified below.
      } else {
        assert.equal(metadata.artifactFilename || metadata.filename, item.name);
        assert.equal(metadata.version, build.version); assert.equal(metadata.sha256, item.sha256);
        assert.equal(metadata.size, item.size);
      }
      const { size, elapsedMs } = await verifyDownload(downloadUrl, item);
      report.artifacts.push({ name: item.name, size, sha256: item.sha256, releaseId: item.releaseId,
        version: build.version, url: downloadUrl, signature: 'verified', download: 'verified', elapsedMs });
    }, { limit, phase: 'verify-download' });
    report.artifacts.sort((a, b) => a.name.localeCompare(b.name));
    report.ok = true;
  } finally {
    report.finishedAt = new Date().toISOString();
    await contract.write(path.join(contract.root, 'release-evidence/publication-verification.json'), report);
  }
  console.log(`Verified ${report.artifacts.filter(item => item.download === 'verified').length} signed public installers from the accepted pipeline`);
}
module.exports = { publicRoutes };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
