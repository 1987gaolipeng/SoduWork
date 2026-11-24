'use strict';

const contract = require('../conversation/delivery-contract');
const {safeRelative} = require('../conversation/delivery-package');
const path = require('node:path');
const {realpath} = require('node:fs/promises');
const {withJournal} = require('./outputs');

function pathKey(name) {
  return process.platform === 'win32' ? name.toLowerCase() : name;
}

function filePath(value) {
  if (typeof value !== 'string') return '';
  try { return pathKey(safeRelative(value.trim().replace(/^\.\//, ''))); }
  catch { return ''; }
}

function outputPaths(outputContract, texts) {
  const required = new Set(), named = new Set();
  for (const rows of [outputContract.deliverables, outputContract.expectedArtifacts, outputContract.outputs]) {
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      // Legacy lists can contain prose. A literal filename is a collection
      // hint; only a required file entry describes a mandatory package member.
      if (typeof row === 'string') {
        if (/^[^\s]+\.[\w]+$/.test(row)) named.add(filePath(row));
      } else if (row && row.required !== false && (!row.kind || row.kind === 'file' || row.kind === 'decision')) {
        const name = filePath(row.path || row.entry);
        if (name && !/[\[\]{}]/.test(name)) required.add(name);
      }
    }
  }
  for (const text of texts.flat()) {
    if (typeof text !== 'string') continue;
    for (const line of text.split(/[\n。;；]+/)) {
      const clause = line.trim().replace(/^(?:[-*]|\d+[.)、])\s*/, '').replace(/[.!！]$/, '');
      const verb = clause.match(/^(?:(?:please\s+)?(?:deliver|submit|include|provide)\s+(?:the (?:required )?)?|(?:请)?(?:交付|提交|补交|附上|提供)\s*[:：]?\s*)/i);
      let subject = verb ? clause.slice(verb[0].length) : clause;
      if (verb) {
        subject = subject.replace(/\s+(?:as a standalone script\b.*|in the (?:revised |final )?delivery|in the reviewed version)$/i, '');
      } else {
        const standalone = subject.match(/\s*(?:(?:must|should) (?:run|be runnable) (?:standalone|independently)|(?:必须|需要|应当|可|能|须|需)(?:能|可)?独立运行)$/i);
        if (!standalone) continue;
        subject = subject.slice(0, standalone.index);
      }
      // Match whole, positive filename clauses. Commands, negative requests
      // and general mentions are never used to sweep a workspace for scripts.
      const names = subject.split(/\s+and\s+|[,，、]/i).map(part => {
        const name = part.trim().match(/^(?:`([^`]+)`|"([^"]+)"|([\p{L}\p{N}_./\\-]+\.[\w-]+))$/u);
        return name ? filePath(name[1] || name[2] || name[3]) : '';
      });
      if (names.every(Boolean)) for (const name of names) named.add(name);
    }
  }
  named.delete('');
  return {required, named};
}

async function extraRoots(snapshot, selected, {required, named}, cwd, turnId) {
  if (!['inferred', 'manifest'].includes(snapshot?.delivery?.source)) return [];
  if (selected.some(file => !file.artifactId)) return [];
  const chosen = new Set(selected.map(file => filePath(file.relative)));
  // Preserve declared supporting files, superseded names and explicit process evidence.
  if (snapshot.delivery.source === 'manifest') {
    for (const item of contract.readManifest(cwd)?.deliverables || []) {
      if (!item || typeof item !== 'object') continue;
      chosen.add(filePath(item.path || item.entry));
      for (const field of [item.files, item.replaces]) {
        if (Array.isArray(field)) for (const name of field) chosen.add(filePath(name));
      }
    }
  }
  const excluded = new Set(snapshot.items.filter(file => file.processEvidence || file.pluginDraft).map(file => file.path));
  // Pi can finish its execution clock before the task receipt collects files.
  // Only the completed journal for this exact turn and workspace can then
  // establish which scanned files changed. Packaging rechecks their hashes.
  const scan = snapshot.got, journal = scan?.fileChanges;
  // The journal records the filesystem's canonical root, while the session
  // may have been opened through a directory alias (e.g. a Windows junction).
  let files = scan?.files;
  if (turnId && journal?.turnId === turnId && !journal.truncated && journal.cwd && cwd) {
    const root = await realpath(cwd).catch(() => null);
    if (root && path.relative(root, journal.cwd) === '') files = withJournal(scan, journal).files;
  }
  return (files || []).filter(file => {
    if (!file.changedInTurn || !file.relative || file.processEvidence || excluded.has(file.path)) return false;
    const key = pathKey(file.relative);
    if (chosen.has(key)) return false;
    return required.has(key) || named.has(key) && !contract._kindOf(file.name) && !contract._isProcess(file);
  }).map(file => ({...file, kind: 'file', artifactId: contract._artifactId('file', file.relative)}));
}

module.exports = {outputPaths, extraRoots, pathKey};
