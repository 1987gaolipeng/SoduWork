'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { assertNoLinks } = require('../plugin-resources');
const { previewPath } = require('../pi-session/attachment-contract');
const archive = require('./device-artifact-archive.cjs');
const { stamp } = require('./runtime-artifacts.cjs');
const { portablePath, excludedName, MAX_FILES, MAX_BYTES } = require('./portable-workspace');

const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function allowed(name) {
  try { portablePath(name); return !name.split('/').some(excludedName); }
  catch (_) { return false; }
}

function artifactFiles(profile, id, history) {
  const saved = archive.projection(profile, id, history);
  if (!saved) return [];
  const hashes = new Map(history.archive.files.map(file => [file.relative, file.sha256]));
  return [...saved.items, ...saved.resources].flatMap(({ metadata, stamp }) => {
    const relative = metadata.relative;
    // An evidence image may leave the reserved internal directory as a regular file.
    const name = relative.replace(/^\.soduwork\/evidence\/([^/.][^/]*\.(?:png|jpe?g|gif|webp))$/i, 'conversation-evidence/$1');
    if (!allowed(name) || metadata.size > MAX_BYTES || !/^[a-f0-9]{64}$/.test(hashes.get(relative))) return [];
    return [{ path: name, size: metadata.size, sourceRoot: saved.root, relative, stamp,
      artifactDigest: hashes.get(relative) }];
  });
}

async function inputFiles(workRoot, ref, snapshot) {
  if (!workRoot || !path.isAbsolute(workRoot) || !/^[a-z0-9_-]{1,160}$/i.test(ref || '')) return [];
  const root = path.join(workRoot, 'temp', ref, '.soduwork-inputs');
  const files = [], seen = new Set();
  for (const message of snapshot?.messages || []) {
    if (message.role !== 'user') continue;
    for (const item of message.attachments || []) {
      const source = previewPath(item?.previewRef);
      // A transcript reference by itself cannot select a directory or another session's input.
      if (!source || !path.isAbsolute(source) || path.dirname(source) !== root || seen.has(source) || files.length >= MAX_FILES) continue;
      const leaf = path.basename(source), key = hash(item.previewRef);
      if (!allowed(leaf)) continue;
      try {
        assertNoLinks(workRoot, source);
        const stat = await fs.lstat(source, { bigint: true });
        if (!stat.isFile() || stat.nlink !== 1n || Number(stat.size) !== item.size || Number(stat.size) > MAX_BYTES) continue;
        seen.add(source);
        files.push({ path: 'conversation-inputs/' + key.slice(0, 16) + '/' + leaf,
          size: item.size, sourceRoot: root, relative: leaf, stamp: stamp(stat), attachmentKey: key });
      } catch (_) { /* An inaccessible or linked input is never offered. */ }
    }
  }
  return files;
}

module.exports = { artifactFiles, inputFiles };
