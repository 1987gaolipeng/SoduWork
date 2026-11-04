'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { sourceFiles } = require('./source-files.cjs');
const ROOT = path.resolve(__dirname, '..');

function check(root = ROOT) {
  const profile = JSON.parse(fs.readFileSync(path.join(root, 'tools/distribution/PUBLIC-SOURCE.json'), 'utf8'));
  if (profile.schema !== 1 || profile.id !== 'opensource-v1' || profile.sourceOnly !== true) {
    throw Error('Invalid public source profile');
  }
  const files = sourceFiles(root).filter(name => fs.existsSync(path.join(root, name)));
  const errors = [];
  const identifiers = profile.excludedIdentifiers || [];
  if (!Array.isArray(identifiers) || identifiers.some(value => typeof value !== 'string' || !value.trim())) {
    throw Error('Invalid excluded identifiers');
  }
  for (const name of files) {
    // Only the exclusion policy may name restricted products. Renaming a file
    // must not let its private implementation or references enter the archive.
    const content = name === 'tools/distribution/PUBLIC-SOURCE.json' ? '' : fs.readFileSync(path.join(root, name)).toString('utf8').toLowerCase();
    for (const identifier of identifiers) {
      const needle = identifier.toLowerCase();
      if (name.toLowerCase().includes(needle) || content.includes(needle)) errors.push('Excluded business identifier: ' + name + ': ' + identifier);
    }
    if (profile.excludedPrefixes.some(prefix => name.startsWith(prefix)) || profile.excludedFiles.includes(name)) {
      errors.push('Excluded first-release material: ' + name);
    }
    if (name.startsWith('skills/') && name.split('/').length > 2 && !profile.skills.includes(name.split('/')[1])) {
      errors.push('Unreviewed bundled Skill: ' + name);
    }
    if (name.startsWith('ops/') && !name.startsWith('ops/self-host/')) errors.push('Excluded operations material: ' + name);
    if (name.startsWith('tools/ci/') && !profile.buildChecks.includes(name.slice('tools/ci/'.length))) {
      errors.push('Excluded release pipeline material: ' + name);
    }
    if (name.endsWith('/agents/openai.yaml')) errors.push('Host-specific Skill display metadata: ' + name);
  }
  for (const name of profile.skills) {
    if (!fs.existsSync(path.join(root, 'skills', name, 'SKILL.md'))) errors.push('Missing declared Skill: ' + name);
  }
  const skillNames = new Set(profile.skills);
  for (const name of files.filter(name => /^hub-backend\/plugins\/[^/]+\.json$/.test(name))) {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
    for (const skill of manifest.capabilities?.skills || []) {
      if (!skillNames.has(skill)) errors.push('Bundled plugin refers to an omitted Skill: ' + name + ': ' + skill);
    }
  }
  if (!fs.readFileSync(path.join(root, 'LICENSE'), 'utf8').includes('Copyright (c) 2026 MDiRi')) {
    errors.push('Project copyright attribution is missing');
  }
  return { ok: errors.length === 0, profile: profile.id, files: files.length, skills: profile.skills.length, errors };
}
if (require.main === module) {
  try { const result = check(); console.log(JSON.stringify(result, null, 2)); if (!result.ok) process.exitCode = 1; }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { check };
