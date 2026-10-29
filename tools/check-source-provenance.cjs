'use strict';
// Review records detect accidental imports and changes; they do not grant rights.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, '..');
const INVENTORY = 'third-party/source-files.json';
const ROOTS = ['client/vendor/', 'client/assets/connector-brands/', 'hub-backend/app/services/harness2_vendor/'];
const LICENSES = new Set(['MIT', 'BSD-3-Clause', 'Apache-2.0', 'CC0-1.0']);
const validPath = name => typeof name === 'string' && name.length > 0 &&
  !/[\\:\0]/.test(name) && !name.startsWith('/') &&
  name.split('/').every(part => part && part !== '.' && part !== '..');
const digest = content => crypto.createHash('sha256').update(content.replace(/\r\n/g, '\n')).digest('hex');

function check(root = ROOT) {
  const errors = [], seen = new Set(), ids = new Set();
  let inventory;
  try { inventory = JSON.parse(read(INVENTORY)); }
  catch (_) { return {ok: false, errors: ['Missing or invalid source provenance inventory']}; }
  if (!inventory || inventory.schema !== 1 || !Array.isArray(inventory.components) || !Array.isArray(inventory.roots) ||
      JSON.stringify([...(inventory.roots || [])].sort()) !== JSON.stringify([...ROOTS].sort())) {
    return {ok: false, errors: ['Invalid source provenance scope']};
  }
  function read(name) {
    if (!validPath(name)) throw Error('Unsafe provenance path: ' + name);
    let current = root;
    for (const part of name.split('/')) {
      current = path.join(current, part);
      if (fs.lstatSync(current).isSymbolicLink()) throw Error('Provenance path is a symlink: ' + name);
    }
    if (!fs.statSync(current).isFile()) throw Error('Provenance path is not a file: ' + name);
    return new TextDecoder('utf-8', {fatal: true}).decode(fs.readFileSync(current));
  }
  function verify(entry, kind) {
    try {
      if (!entry || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw Error('Invalid ' + kind + ' digest');
      if (digest(read(entry.path)) !== entry.sha256) errors.push('Changed ' + kind + ': ' + entry.path);
    } catch (error) { errors.push(error.message); }
  }
  for (const component of inventory.components) {
    if (!component || typeof component.id !== 'string' || !component.id || ids.has(component.id) ||
        typeof component.source !== 'string' || !component.source || !component.reviewBasis ||
        !LICENSES.has(component.license) || !Array.isArray(component.notices) || !component.notices.length ||
        !Array.isArray(component.files) || !component.files.length) {
      errors.push('Incomplete or unreviewed component: ' + (component?.id || 'unknown')); continue;
    }
    ids.add(component.id);
    for (const notice of component.notices) verify(notice, 'original notice');
    for (const file of component.files) {
      if (!file || !validPath(file.path) || !ROOTS.some(prefix => file.path.startsWith(prefix))) {
        errors.push('Source outside reviewed roots: ' + file?.path); continue;
      }
      if (seen.has(file.path)) errors.push('Duplicate provenance file: ' + file.path);
      seen.add(file.path); verify(file, 'vendored source');
    }
  }
  function walk(directory) {
    if (!fs.existsSync(path.join(root, directory))) return;
    if (fs.lstatSync(path.join(root, directory)).isSymbolicLink()) {
      errors.push('Unreviewed symbolic link: ' + directory); return;
    }
    for (const entry of fs.readdirSync(path.join(root, directory), {withFileTypes: true})) {
      const name = directory + entry.name;
      if (entry.name === '__pycache__' || /\.py[co]$/.test(entry.name)) continue;
      if (entry.isSymbolicLink()) errors.push('Unreviewed symbolic link: ' + name);
      else if (entry.isDirectory()) walk(name + '/');
      else if (!seen.has(name)) errors.push('Unreviewed vendored file: ' + name);
    }
  }
  ROOTS.forEach(walk);
  return {ok: errors.length === 0, components: ids.size, files: seen.size, errors};
}
module.exports = {check, digest, ROOT, ROOTS, INVENTORY};
if (require.main === module) {
  const result = check(); console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}
