'use strict';
// Read-only structural evidence check; never executes commands supplied in reports.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function file(root, name, max = 256 * 1024 * 1024) {
  if (typeof name !== 'string' || !name || /[\\\\:\x00-\x1f]/.test(name) || name.startsWith('/') ||
      name.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('Evidence path must stay inside its root');
  let cursor = root;
  for (const part of name.split('/')) {
    cursor = path.join(cursor, part);
    if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error('Evidence cannot traverse links');
  }
  const stat = fs.statSync(cursor);
  if (!stat.isFile() || !stat.size || stat.size > max) throw new Error('Evidence must be a nonempty, bounded file');
  return fs.readFileSync(cursor);
}
function document(root, name) {
  const value = JSON.parse(file(root, name, 2 * 1024 * 1024));
  if (!value || value.schemaVersion !== 1) throw new Error('Unsupported evidence schema');
  return value;
}
function check(directory, acceptancePath = 'acceptance.json', evidencePath = 'quality-evidence.json') {
  const root = fs.realpathSync(directory), missing = [];
  const acceptance = document(root, acceptancePath), evidence = document(root, evidencePath);
  if (!Array.isArray(acceptance.criteria) || !acceptance.criteria.length || acceptance.criteria.length > 200 ||
      !acceptance.criteria.some(x => x.required === true)) throw new Error('At least one required criterion is necessary');
  if (!Array.isArray(evidence.checks) || evidence.checks.length > 400) throw new Error('Checks must be an array');
  const ids = new Set();
  for (const row of acceptance.criteria) {
    if (!row || typeof row.id !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(row.id) || ids.has(row.id) ||
        typeof row.description !== 'string' || !row.description.trim() || typeof row.required !== 'boolean') throw new Error('Invalid or duplicate criterion');
    ids.add(row.id);
  }
  const candidate = evidence.candidate;
  if (!candidate || !sha(candidate.sha256) || digest(file(root, candidate.path)) !== candidate.sha256) throw new Error('Candidate checksum mismatch');
  const results = new Map();
  for (const row of evidence.checks) {
    if (!row || !ids.has(row.criterionId) || results.has(row.criterionId)) throw new Error('Unknown or duplicate check');
    let valid = row.status === 'passed' && row.exitCode === 0 &&
      typeof row.command === 'string' && row.command.trim().length > 0 &&
      typeof row.checkedAt === 'string' && Number.isFinite(Date.parse(row.checkedAt)) &&
      Date.parse(row.checkedAt) <= Date.now() + 300000 &&
      row.candidateSha256 === candidate.sha256;
    if (valid) {
      try { valid = Boolean(row.log && sha(row.log.sha256) && digest(file(root, row.log.path, 16 * 1024 * 1024)) === row.log.sha256); }
      catch (_) { valid = false; }
    }
    results.set(row.criterionId, valid);
  }
  for (const row of acceptance.criteria) if (row.required && results.get(row.id) !== true) missing.push(row.id);
  return { schemaVersion: 1, outcome: missing.length ? 'blocked' : 'proceed',
    reasonCode: missing.length ? 'missing_input' : 'ready',
    summary: missing.length ? 'Required criteria lack matching passing evidence' : 'Evidence integrity and coverage passed; runtime and business validation remain separate',
    evidence: [acceptancePath, evidencePath, candidate.path], missing,
    nextAction: missing.length ? 'Run or repair the missing checks on this exact candidate' : 'Independently rerun key checks and request human acceptance',
    runtimeTested: false, deploymentAuthorized: false };
}
if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.length < 1 || args.length > 3) throw new Error('Usage: release-check.cjs <root> [acceptance.json] [quality-evidence.json]');
    const result = check(...args); process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exitCode = result.outcome === 'proceed' ? 0 : 1;
  } catch (error) { process.stderr.write('Release evidence rejected: ' + error.message + '\n'); process.exitCode = 1; }
}
module.exports = { check, digest };
