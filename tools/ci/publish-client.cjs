'use strict';
const path = require('node:path'), fs = require('node:fs/promises'), assert = require('node:assert/strict');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const contract = require('./release-artifacts.cjs');
const env = process.env;
const evidence = path.join(contract.root, 'release-evidence');

function targets() {
  const value = String(env.SODUWORK_RELEASE_PLATFORMS || 'windows,linux,macos').split(',');
  assert.ok(value.length && new Set(value).size === value.length);
  assert.ok(value.every(x => ['windows', 'linux', 'macos'].includes(x)), 'Invalid SODUWORK_RELEASE_PLATFORMS');
  return value;
}
async function connection() {
  assert.equal(env.CI_COMMIT_REF_PROTECTED, 'true', 'Publishing requires a protected CI ref');
  const url = new URL(env.SODUWORK_RELEASE_HUB_URL);
  assert.ok(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password &&
    url.pathname === '/' && !url.search && !url.hash, 'Use a Hub origin without credentials or query parameters');
  let token = env.SODUWORK_CLIENT_RELEASE_UPLOAD_TOKEN;
  async function request(route, method = 'GET', body) {
    const response = await fetch(url.origin + route, { method, redirect: 'error',
      headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw Error(`${method} ${route} failed: HTTP ${response.status}`);
    return response.json();
  }
  if (!token) {
    assert.ok(env.SODUWORK_RELEASE_USER && env.SODUWORK_RELEASE_PASSWORD, 'Configure a SoduWork publisher token or service account');
    const result = await request('/api/v1/admin/login', 'POST', { user: env.SODUWORK_RELEASE_USER, pw: env.SODUWORK_RELEASE_PASSWORD });
    assert.ok(typeof result.token === 'string' && result.token); token = result.token;
  }
  return { url: url.origin, token, request };
}
function matches(row, item, record, channel) {
  return row && row.version === record.version && row.channel === channel &&
    row.platform === item.platform && row.arch === item.arch && row.artifactName === item.name &&
    row.artifactSize === item.size && row.sha256 === item.sha256;
}
async function stage(platform) {
  assert.ok(targets().includes(platform));
  const record = await contract.verify(platform);
  contract.validateAcceptance(record, await contract.read(path.join(evidence, platform, 'acceptance.json')));
  const remote = await connection();
  assert.ok(env.CI_PIPELINE_CREATED_AT, 'CI timestamp is required for repeatable signatures');
  const directory = path.join(evidence, platform, 'staged');
  await fs.mkdir(directory, { recursive: true });
  const channel = env.SODUWORK_CLIENT_CHANNEL || 'beta';
  assert.ok(['stable', 'beta'].includes(channel));
  const entries = [];
  for (const item of record.artifacts) {
    const installer = path.join(contract.dist, item.name);
    const receipt = path.join(directory, item.name + '.upload.json');
    const bundle = path.join(directory, item.name + '.' + channel + '.release.json');
    const result = await execFile(process.execPath,
      [path.join(contract.root, 'tools/sign-client-release.mjs'), installer],
      { cwd: contract.root, windowsHide: true, timeout: 16 * 60 * 1000,
        env: { ...env, SODUWORK_CLIENT_PLATFORM: item.platform, SODUWORK_CLIENT_ARCH: item.arch,
          SODUWORK_CLIENT_CHANNEL: channel, SODUWORK_CLIENT_RELEASE_BUNDLE: bundle,
          SODUWORK_CLIENT_PUBLISHED_AT: env.CI_PIPELINE_CREATED_AT,
          SODUWORK_CLIENT_COMPATIBILITY_REPORT: path.join(evidence, platform, 'compatibility.json'),
          SODUWORK_CLIENT_UPLOAD_RECEIPT: receipt, SODUWORK_CLIENT_RELEASE_UPLOAD_TOKEN: remote.token,
          SODUWORK_CLIENT_RELEASE_UPLOAD_URL: remote.url + '/api/v1/admin/client-releases/upload' } });
    process.stdout.write(result.stdout);
    const uploaded = await contract.read(receipt);
    assert.ok(matches(uploaded.release, item, record, channel), 'Hub receipt differs from accepted artifact');
    entries.push({ ...item, releaseId: uploaded.release.id });
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
    assert.equal(index.channel, env.SODUWORK_CLIENT_CHANNEL || 'beta');
    assert.equal(index.build.sourceCommit, env.CI_COMMIT_SHA);
    assert.equal(String(index.build.pipelineId), env.CI_PIPELINE_ID);
    assert.equal(index.build.version, require('../../client/package.json').version);
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
module.exports = { matches, targets, connection, stagedEntries };
if (require.main === module) {
  const [command, platform] = process.argv.slice(2);
  assert.ok(['stage', 'enable'].includes(command));
  (command === 'stage' ? stage(platform) : enable()).catch(error => {
    // Child-process errors include argv, never its secret environment. Avoid
    // printing response bodies or authentication objects from remote services.
    console.error(error.message); process.exitCode = 1;
  });
}
