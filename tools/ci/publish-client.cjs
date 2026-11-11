'use strict';
const path = require('node:path'), fs = require('node:fs/promises'), assert = require('node:assert/strict');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const contract = require('./release-artifacts.cjs');
const { candidateVersion } = require('../../client/scripts/client-build-version.cjs');
const env = process.env;
const distributions = require('./client-distribution.cjs');
const { connection } = require('./client-publisher-auth.cjs');
const evidence = contract.evidence;
const { concurrency, transferAll } = require('./release-transfer.cjs');

function targets(settings = process.env) {
  const value = String(settings.SODUWORK_RELEASE_PLATFORMS || 'windows,linux,macos').split(',');
  assert.ok(value.length && new Set(value).size === value.length);
  assert.ok(value.every(x => ['windows', 'linux', 'macos'].includes(x)), 'Invalid SODUWORK_RELEASE_PLATFORMS');
  return value;
}
function minimumVersion(record, settings = env) {
  const configured = settings.SODUWORK_CLIENT_MINIMUM_VERSION || '';
  const profile = distributions.profile({ SODUWORK_DISTRIBUTION: record.distribution.id });
  const acceptance = require('./distribution-baselines.cjs').plan(profile, record.version, { platform: record.platform });
  if (acceptance.mode === 'upgrade' && acceptance.minimumVersion) {
    const { parseVersion, newer } = require('../../client/main/client-update-contract.js');
    assert.ok(!configured || (parseVersion(configured) && !newer(acceptance.minimumVersion, configured)),
      'Minimum version cannot allow unverified upgrades below the accepted baseline');
    return configured || acceptance.minimumVersion;
  }
  if (acceptance.mode !== 'clean-install') return configured;
  const { parseVersion, newer } = require('../../client/main/client-update-contract.js');
  assert.ok(!configured || (parseVersion(configured) && !newer(record.version, configured)),
    'Clean installation cannot allow automatic updates from an earlier version');
  return configured || record.version;
}
function matches(row, item, record, channel) {
  return row && row.version === record.version && row.channel === channel &&
    row.platform === item.platform && row.arch === item.arch && row.artifactName === item.name &&
    row.artifactSize === item.size && row.sha256 === item.sha256 &&
    String(row.minVersion || '') === minimumVersion(record);
}
async function syncNotes(remote, status, channel) {
  const record = require('./client-release-notes.cjs').read();
  assert.ok(record.locales, 'Multilingual release notes are required before publishing');
  require('./release-notes-ai.cjs').validateEditorial(record.locales);
  const route = '/api/v1/admin/client-release-notes/' + encodeURIComponent(record.version) + '?channel=' + channel;
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await remote.request(route);
    if (current && !require('node:util').isDeepStrictEqual(current.locales, record.locales))
      throw Error('This version already has different localized notes; explicit editorial review is required');
    if (current && (current.status === status || current.status === 'published')) return;
    try {
      await remote.request(route, 'PUT', { locales: record.locales, status, expectedRevision: current?.revision || 0 });
      return;
    } catch (error) { if (!error.message.includes('HTTP 409') || attempt === 2) throw error; }
  }
}
async function stage(platform, { connect = connection, execute = execFile } = {}) {
  const limit = concurrency();
  assert.ok(targets().includes(platform));
  const record = await contract.verify(platform);
  contract.validateAcceptance(record, await contract.read(path.join(evidence, platform, 'acceptance.json')));
  const remote = await connect();
  assert.ok(env.CI_PIPELINE_CREATED_AT, 'CI timestamp is required for repeatable signatures');
  const directory = path.join(evidence, platform, 'staged');
  await fs.mkdir(directory, { recursive: true });
  await fs.rm(path.join(directory, 'index.json'), { force: true });
  const trustFile = path.join(evidence, 'update-trust.json');
  await contract.write(trustFile, contract.distribution.updateTrust);
  const channel = env.SODUWORK_CLIENT_CHANNEL || 'beta';
  assert.ok(['stable', 'beta'].includes(channel));
  await syncNotes(remote, 'draft', channel);
  const progress = { schema: 1, ok: false, sourceCommit: record.sourceCommit, pipelineId: record.pipelineId,
    distribution: record.distribution, platform, completed: [] };
  await contract.write(path.join(directory, 'progress.json'), progress);
  let entries;
  try {
    entries = await transferAll(record.artifacts, async item => {
      const installer = path.join(contract.dist, item.name);
      const receipt = path.join(directory, item.name + '.upload.json');
      const bundle = path.join(directory, item.name + '.' + channel + '.release.json');
      const result = await execute(process.execPath,
        [path.join(contract.root, 'ops/sign-upload-client-release.mjs'), installer, '--reuse-existing'],
        { cwd: contract.root, windowsHide: true, timeout: 16 * 60 * 1000,
          env: { ...env, SODUWORK_DISTRIBUTION: contract.distribution.distributionId,
            SODUWORK_CLIENT_DISTRIBUTION_RECEIPT: path.join(evidence, platform, 'acceptance.json'),
            SODUWORK_CLIENT_PLATFORM: item.platform, SODUWORK_CLIENT_ARCH: item.arch,
            SODUWORK_CLIENT_CHANNEL: channel, SODUWORK_CLIENT_RELEASE_BUNDLE: bundle, SODUWORK_CLIENT_TRUST_FILE: trustFile,
            SODUWORK_CLIENT_MINIMUM_VERSION: minimumVersion(record),
            SODUWORK_CLIENT_PUBLISHED_AT: env.CI_PIPELINE_CREATED_AT,
            SODUWORK_CLIENT_RELEASE_NOTES: notes,
            SODUWORK_CLIENT_COMPATIBILITY_REPORT: path.join(evidence, platform, 'compatibility.json'),
            SODUWORK_CLIENT_UPLOAD_RECEIPT: receipt, SODUWORK_CLIENT_RELEASE_UPLOAD_TOKEN: remote.token,
            SODUWORK_CLIENT_RELEASE_UPLOAD_URL: remote.url + '/api/v1/admin/client-releases/upload' } });
      process.stdout.write(result.stdout);
      const uploaded = await contract.read(receipt);
      assert.ok(matches(uploaded.release, item, record, channel), 'Hub receipt differs from accepted artifact');
      assert.equal(uploaded.release.notes, notes, 'Hub release notes differ from the bundled history');
      const entry = { ...item, releaseId: uploaded.release.id };
      progress.completed.push({ name: item.name, releaseId: entry.releaseId, reused: uploaded.reused === true });
      return entry;
    }, { limit, phase: 'upload-' + platform });
    progress.ok = true;
  } finally {
    progress.finishedAt = new Date().toISOString();
    await contract.write(path.join(directory, 'progress.json'), progress);
  }
  await contract.write(path.join(directory, 'index.json'), { schema: 3, ok: true,
    hub: remote.url, channel, build: record, entries });
}
async function stagedEntries(remote) {
  const entries = [];
  let channel;
  for (const platform of targets()) {
    const index = await contract.read(path.join(evidence, platform, 'staged/index.json'));
    assert.equal(index.schema, 3); assert.equal(index.ok, true); assert.equal(index.hub, remote.url);
    distributions.validate(index.distribution); distributions.validate(index.build.distribution);
    assert.equal(index.channel, env.SODUWORK_CLIENT_CHANNEL || 'beta');
    assert.equal(index.build.sourceCommit, env.CI_COMMIT_SHA);
    assert.equal(String(index.build.pipelineId), env.CI_PIPELINE_ID);
    assert.equal(index.build.version, candidateVersion(env));
    assert.equal(index.build.notesSha256, require('./client-release-notes.cjs').read().notesSha256,
      'Staged build used different release notes');
    assert.deepEqual(index.build.artifacts.map(({ name, platform, arch, format }) => ({ name, platform, arch, format })), contract.expected(platform));
    contract.validateAcceptance(index.build, await contract.read(path.join(evidence, platform, 'acceptance.json')));
    assert.deepEqual(index.entries.map(({ releaseId, ...item }) => item), index.build.artifacts);
    channel ??= index.channel; assert.equal(index.channel, channel);
    for (const item of index.entries) entries.push({ item, build: index.build });
  }
  return { entries, channel };
}
async function enable() {
  const remote = await connection();
  const { entries, channel } = await stagedEntries(remote);
  const before = await remote.request('/api/v1/admin/client-releases');
  const acceptedIds = new Set(entries.map(({ item }) => item.releaseId));
  for (const { item, build } of entries) {
    const row = before.releases.find(row => row.id === item.releaseId);
    assert.ok(matches(row, item, build, channel), 'All accepted artifacts must be staged before enabling');
    assert.equal(row.notes, require('./client-release-notes.cjs').read().notes,
      'Staged release notes differ from the bundled history');
    const suffix = name => String(name).replace(/^SoduWork-/, '');
    assert.ok(!before.releases.some(other => other.enabled && !acceptedIds.has(other.id) &&
      other.channel === channel && other.platform === item.platform && other.arch === item.arch &&
      other.version === build.version && suffix(other.artifactName) === suffix(item.name)),
    'An enabled brand alias outside this accepted publication already exists');
  }
  const report = { schema: 1, ok: false, channel, hub: remote.url, sourceCommit: env.CI_COMMIT_SHA,
    pipelineId: env.CI_PIPELINE_ID, enabled: [], required: entries.map(x => x.item.releaseId) };
  try {
    // Existing Hub API activates one artifact per transaction. A retry checks
    // the same immutable IDs and safely completes any partial activation.
    for (const { item, build } of entries) {
      const result = await remote.request('/api/v1/admin/client-releases/' + item.releaseId, 'PATCH', { enabled: true });
      assert.ok(matches(result.release, item, build, channel) && result.release.enabled === true);
      report.enabled.push(item.releaseId);
    }
    report.ok = true;
  } finally {
    await contract.write(path.join(evidence, 'activation.json'), report);
  }
  console.log(`Enabled ${report.enabled.length} accepted ${channel} artifacts on SoduWork Hub`);
}
module.exports = { matches, minimumVersion, targets, connection, stagedEntries, syncNotes, stage };
if (require.main === module) {
  const [command, platform] = process.argv.slice(2);
  assert.ok(['stage', 'enable'].includes(command));
  (async () => {
    if (env.SODUWORK_PIPELINE_ACTION !== 'stage') require('./client-target.cjs').requireTarget();
    return command === 'stage' ? stage(platform) : enable();
  })().catch(error => {
    // Child-process errors include argv, never its secret environment. Avoid
    // printing response bodies or authentication objects from remote services.
    console.error(error.message); process.exitCode = 1;
  });
}
