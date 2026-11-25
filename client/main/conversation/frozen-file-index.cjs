'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { assertNoLinks } = require('../plugin-resources');
const { portablePath } = require('./portable-workspace');
const { same, stamp } = require('./runtime-artifacts.cjs');

function index(files) {
  const names = new Map(), legacyRoots = new Map();
  function register(map, key, file) {
    if (map.has(key) && map.get(key) !== file) map.set(key, null);
    else map.set(key, file);
  }
  for (const file of files) {
    register(names, file.relative, file);
    if (Array.isArray(file.aliases)) {
      for (const alias of file.aliases) register(names, alias, file);
    } else if (Array.isArray(file.stamp)) {
      // Older receipts only preserve the registered spelling. Match another
      // spelling only if its archive volume resolves the exact recorded inode.
      if (!legacyRoots.has(file.root)) legacyRoots.set(file.root, new Map());
      register(legacyRoots.get(file.root), file.stamp[0] + ':' + file.stamp[1], file);
    }
  }
  return {
    get(relative) {
      try { portablePath(relative); } catch (_) { return undefined; }
      if (names.has(relative)) return names.get(relative);
      let match;
      for (const [root, inodes] of legacyRoots) {
        try {
          const requested = path.join(root, relative);
          assertNoLinks(root, requested);
          const stat = fs.lstatSync(requested, { bigint: true });
          if (!stat.isFile() || stat.nlink !== 1n || !stat.ino) continue;
          const receipt = inodes.get(stat.dev + ':' + stat.ino);
          if (!receipt || !same(stamp(stat), receipt.stamp)) continue;
          const original = path.join(root, portablePath(receipt.relative));
          assertNoLinks(root, original);
          if (!same(stamp(fs.lstatSync(original, { bigint: true })), receipt.stamp)) continue;
          if (match && match !== receipt) return undefined;
          match = receipt;
        } catch (_) { /* Missing files and linked paths cannot add authority. */ }
      }
      return match;
    },
  };
}

module.exports = { index };
