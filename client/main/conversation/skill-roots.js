'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_DEPTH = 4;
const MAX_SKILLS = 200;

function roots(app, options) {
  const opts = options || {};
  const env = opts.env || process.env;
  const home = opts.home || os.homedir();
  const userData = app && typeof app.getPath === 'function' ? app.getPath('userData') : '';
  const repoSkills = path.resolve(path.dirname(path.dirname(__dirname)), '..', 'skills');
  const out = [];
  if (app && app.isPackaged) out.push(path.join(process.resourcesPath, 'skills'));
  out.push(repoSkills);
  if (userData) {
    out.push(path.join(userData, 'runner', 'data', 'skills'));
    out.push(path.join(userData, 'skills'));
  }
  out.push(
    path.join(home, '.pi', 'agent', 'skills'),
    path.join(home, '.agents', 'skills'),
    path.join(env.CODEX_HOME || path.join(home, '.codex'), 'skills'),
    path.join(home, '.claude', 'skills'),
  );
  const seen = new Set();
  return out.filter((root) => {
    const key = path.normalize(String(root || '')).toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function discover(app, options) {
  const out = [];
  const seen = new Set();
  function walk(root, current, depth) {
    if (out.length >= MAX_SKILLS || depth > MAX_DEPTH) return;
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); }
    catch (error) { return; }
    if (entries.some((entry) => entry.isFile() && entry.name === 'SKILL.md')) {
      const key = path.normalize(current).toLowerCase();
      if (!seen.has(key)) { seen.add(key); out.push(current); }
      return;
    }
    entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') &&
      entry.name !== 'node_modules' && entry.name !== '__pycache__')
      .forEach((entry) => walk(root, path.join(current, entry.name), depth + 1));
  }
  roots(app, options).forEach((root) => walk(root, root, 0));
  return out;
}

// Conversation preparation must not synchronously walk every installed Agent's
// Skill tree. Keep the same root priority, limits and no-symlink traversal.
async function discoverAsync(app, options) {
  const out = [], seen = new Set();
  async function walk(current, depth) {
    if (out.length >= MAX_SKILLS || depth > MAX_DEPTH) return;
    let entries;
    try { entries = await fs.promises.readdir(current, { withFileTypes: true }); }
    catch (_) { return; }
    if (entries.some(entry => entry.isFile() && entry.name === 'SKILL.md')) {
      const key = path.normalize(current).toLowerCase();
      if (!seen.has(key)) { seen.add(key); out.push(current); }
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.') &&
          entry.name !== 'node_modules' && entry.name !== '__pycache__') {
        await walk(path.join(current, entry.name), depth + 1);
      }
    }
  }
  for (const root of roots(app, options)) await walk(root, 0);
  return out;
}

module.exports = { roots, discover, discoverAsync, MAX_DEPTH, MAX_SKILLS };
