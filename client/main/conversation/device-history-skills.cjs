'use strict';

const { readRecorded } = require('./metadata-snapshot.cjs');
const candidates = require('../pi-session/plugin-draft-candidates');
const skills = require('../pi-session/skill-package-candidate');

function read(root, relative, expected) {
  if (!candidates.SKILL_ARCHIVE.test(relative)) throw Error('这份成果不是技能包');
  return readRecorded(root, relative, expected, skills.MAX_BYTES);
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
      if (error.code !== 'PACKAGE_TOO_LARGE') continue;
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
