'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');

const REPOSITORY_ROOT = path.resolve(__dirname, '../..');
const ROOT = fs.existsSync(path.join(REPOSITORY_ROOT, 'client/package.json'))
  ? REPOSITORY_ROOT : path.resolve(__dirname, '..');
const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.(1|[1-9]\d*))?$/;
const GENERATED_VERSION_DIRECTORY = '.runtime/build-version';
const STAGE_CANDIDATE_FILE = 'release-evidence/staging/candidate.json';

function readPackageVersion(root = ROOT) {
  const file = fs.existsSync(path.join(root, 'client/package.json'))
    ? path.join(root, 'client/package.json') : path.join(root, 'package.json');
  const value = JSON.parse(fs.readFileSync(file, 'utf8')).version;
  assert.match(value, VERSION_RE, 'client/package.json version is invalid');
  return value;
}

function stableVersion(value) {
  const match = VERSION_RE.exec(String(value || ''));
  assert.ok(match, 'Client version is invalid: ' + value);
  return `${match[1]}.${match[2]}.${match[3]}`;
}

function candidateVersion(env = process.env, root = ROOT) {
  const source = readPackageVersion(root);
  const record = readStageCandidate(env, root);
  if (record) return `${record.releaseCandidate.version}-beta.${record.releaseCandidate.number}`;
  return source;
}

function readStageCandidate(env = process.env, root = ROOT) {
  if (env.SODUWORK_PIPELINE_ACTION !== 'stage' || env.SODUWORK_STAGE_MODE !== 'full') return null;
  assert.ok(!String(env.SODUWORK_RELEASE_CANDIDATE || '').trim(),
    'Beta numbers are allocated automatically; remove SODUWORK_RELEASE_CANDIDATE');
  const file = path.join(root, STAGE_CANDIDATE_FILE);
  if (!fs.existsSync(file)) {
    assert.notEqual(env.SODUWORK_STAGE_ALLOCATION_REQUIRED, '1', 'Allocated Stage candidate receipt is missing');
    return null; // Quality checks run before allocation and do not produce installers.
  }
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  const { sha256, ...body } = record;
  assert.equal(sha256, createHash('sha256').update(JSON.stringify(body, null, 2) + '\n').digest('hex'),
    'Stage candidate receipt checksum differs');
  assert.equal(record.schema, 1); assert.equal(record.ok, true);
  assert.equal(record.channel, 'staging'); assert.equal(record.mode, 'full');
  assert.match(env.CI_COMMIT_SHA || '', /^[0-9a-f]{40}$/, 'Stage source commit is required');
  assert.match(env.CI_PIPELINE_ID || '', /^[1-9]\d*$/, 'Stage pipeline ID is required');
  assert.match(env.CI_PROJECT_ID || '', /^[1-9]\d*$/, 'Stage project ID is required');
  assert.equal(record.sourceCommit, env.CI_COMMIT_SHA, 'Stage candidate commit differs');
  assert.equal(record.pipelineId, env.CI_PIPELINE_ID, 'Stage candidate pipeline differs');
  assert.equal(record.projectId, env.CI_PROJECT_ID, 'Stage candidate project differs');
  const ref = env.CI_COMMIT_REF_NAME || env.CI_COMMIT_BRANCH || '';
  const base = stableVersion(readPackageVersion(root));
  assert.ok(ref && (ref === env.CI_DEFAULT_BRANCH || ref === `release/client-${base}`), 'Stage ref differs from the source version');
  assert.equal(record.ref, ref, 'Stage candidate ref differs');
  assert.equal(record.candidateId, `stage-${env.CI_COMMIT_SHA.slice(0, 12)}-${env.CI_PIPELINE_ID}`);
  assert.equal(record.releaseCandidate?.component, 'client');
  assert.equal(record.releaseCandidate?.version, base, 'Stage candidate version differs');
  const number = record.releaseCandidate?.number;
  assert.ok(Number.isSafeInteger(number) && number > 0, 'Invalid allocated Stage candidate number');
  assert.equal(record.releaseCandidate.label, `client-${base}-beta.${number}`);
  return record;
}

function displayVersions(value) {
  const version = String(value || '');
  const base = stableVersion(version);
  const values = [version, base];
  const match = VERSION_RE.exec(version);
  if (match?.[4]) values.push(`${base}.${match[4]}`);
  return [...new Set(values)];
}

function prepareVersionFile(context) {
  const client = context.packager.info.appDir;
  const version = context.packager.appInfo.version;
  const source = JSON.parse(fs.readFileSync(path.join(client, 'version.json'), 'utf8'));
  assert.equal(stableVersion(source.version), stableVersion(version),
    'Packaged version must match the source release series');
  // Generate a build input without changing the committed stable source version.
  const directory = path.join(client, GENERATED_VERSION_DIRECTORY);
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'version.json');
  fs.writeFileSync(file, JSON.stringify({ ...source, version }, null, 2) + '\n');
  return file;
}

module.exports = { ROOT, VERSION_RE, GENERATED_VERSION_DIRECTORY, STAGE_CANDIDATE_FILE, readPackageVersion,
  stableVersion, candidateVersion, readStageCandidate, displayVersions, prepareVersionFile };
