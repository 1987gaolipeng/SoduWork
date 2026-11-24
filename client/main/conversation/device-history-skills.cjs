'use strict';

const fs = require('node:fs');
const path = require('node:path');
const versions = require('./runtime-artifacts.cjs');
const candidates = require('../pi-session/plugin-draft-candidates');
const skills = require('../pi-session/skill-package-candidate');

function read(root, relative, expected) {
  require('./portable-workspace').portablePath(relative);
  if (!candidates.SKILL_ARCHIVE.test(relative)) throw Error('这份成果不是技能包');
  const file = path.join(root, relative);
  const matches = stat => stat.isFile() && stat.nlink === 1n && versions.same(expected, versions.stamp(stat));
  const stat = fs.lstatSync(file, { bigint: true });
  if (!matches(stat)) throw Error('技能包已改变');
  if (stat.size > BigInt(skills.MAX_BYTES)) throw Object.assign(Error('技能包超过 10MB'), { code: 'SKILL_TOO_LARGE' });
  const verified = require('./metadata-snapshot.cjs').read(root, file, { maxBytes: skills.MAX_BYTES });
  if (!matches(verified.stat)) throw Error('技能包已改变');
  return verified;
}

// Parse only the exact file versions recorded on this device. Historical
// packages never grant access to sibling files or a live runtime directory.
function inspect(root, files, skillRuntimeEntry) {
  const results = [];
  for (const { relative, stamp } of files) {
    let verified, diagnostic, pluginKey = '';
    const issue = error => require('../pi-session/plugin-generation-gate.cjs').diagnostic({ relative }, error);
    try { verified = read(root, relative, stamp); }
    catch (error) {
      if (error.code !== 'SKILL_TOO_LARGE') continue;
      diagnostic = issue(error);
    }
    const pluginRevision = candidates.revisionOf(verified ? [verified.revision] : stamp);
    if (verified) {
      try { pluginKey = skills.read(verified.bytes, { skillRuntimeEntry }).name; }
      catch (error) { diagnostic = issue(error); }
    }
    results.push({ relative, pluginDraft: true, skillPackage: true, pluginPackage: false,
      pluginKey, pluginName: pluginKey, pluginRevision, pluginManifestDigest: verified?.revision,
      pluginValidation: { relative, revision: pluginRevision, state: diagnostic ? 'invalid' : 'ready', attempt: 0,
        ...(diagnostic ? { diagnostic } : {}) } });
  }
  return results;
}

module.exports = { read, inspect };
