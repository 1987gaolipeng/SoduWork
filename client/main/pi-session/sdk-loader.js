'use strict';

// A cold import of the CLI SDK resolves hundreds of modules in one microtask
// burst. Stage the same dependencies and yield to Electron between them. This
// does not rewrite the SDK, replace its exports or start a model/session.
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const pending = new Map();
const packages = [
  'typebox/system', 'typebox/schema', 'typebox/type', 'typebox/value',
  'typebox/compile', 'typebox', 'undici', 'jiti/static', 'yaml',
  '@earendil-works/pi-tui', '@earendil-works/pi-ai', '@earendil-works/pi-agent-core',
  'hosted-git-info', 'ignore', 'minimatch', 'proper-lockfile', 'semver', 'cross-spawn', 'diff',
];
const stages = ['core/session-manager.js', 'core/model-runtime.js', 'core/resource-loader.js', 'core/sdk.js'];

function importTarget(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  // Use the dependency's declared Node/import branch, never its require branch.
  for (const [condition, target] of Object.entries(value)) {
    if (['node', 'import', 'default'].includes(condition)) {
      const found = importTarget(target);
      if (found) return found;
    }
  }
  return '';
}

async function resolveStage(entry, specifier) {
  const requireFromSdk = createRequire(entry);
  const parts = specifier.split('/'), count = specifier.startsWith('@') ? 2 : 1;
  const name = parts.slice(0, count).join('/');
  const subpath = parts.length === count ? '.' : './' + parts.slice(count).join('/');
  for (const directory of requireFromSdk.resolve.paths(name) || []) {
    const packageRoot = path.join(directory, name);
    let manifest;
    try { manifest = JSON.parse(await fs.promises.readFile(path.join(packageRoot, 'package.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') continue; return ''; }
    const exports = manifest.exports;
    const target = importTarget(exports && (Object.hasOwn(exports, subpath)
      ? exports[subpath] : subpath === '.' ? exports : null));
    if (target?.startsWith('./')) return path.resolve(packageRoot, target);
    // Never fall through to a require-only/unknown conditional export. Loading
    // a second CJS runtime just for warming can break module identity on upgrade.
    if (exports !== undefined) return '';
    try { return requireFromSdk.resolve(specifier); } catch { return ''; }
  }
  return '';
}

function load(entry) {
  if (pending.has(entry)) return pending.get(entry);
  const promise = (async () => {
    const background = require('./background-process');
    const yieldFrame = () => new Promise(resolve => setImmediate(resolve));
    const seen = new Set();
    async function warm(file, depth = 0) {
      if (seen.has(file)) return;
      seen.add(file);
      if (depth) {
        const source = await fs.promises.readFile(file, 'utf8');
        // TypeBox's public barrels fan out into hundreds of schema modules.
        // Load their relative re-exports in small batches before the barrel;
        // keep the final SDK's normal ESM binding and evaluation semantics.
        const paths = [...source.matchAll(/^export\s+\*\s+from\s+['"](\.\/[^'"]+\.m?js)['"];?\s*$/gm)]
          .map(match => path.resolve(path.dirname(file), match[1]));
        for (const child of paths) await warm(child, depth - 1);
      }
      await background.run(() => import(pathToFileURL(file).href));
      await yieldFrame();
    }
    for (const stage of [...packages, ...stages]) {
      const file = packages.includes(stage) ? await resolveStage(entry, stage) : path.join(path.dirname(entry), stage);
      if (file) {
        // Optional warmup paths may move on an SDK upgrade. The authoritative
        // public import below still diagnoses any real missing dependency.
        try { await warm(file, stage.startsWith('typebox') ? 2 : 0); } catch { /* final import owns errors */ }
      }
      await yieldFrame();
    }
    return background.run(() => import(pathToFileURL(entry).href));
  })();
  pending.set(entry, promise);
  promise.catch(() => { if (pending.get(entry) === promise) pending.delete(entry); });
  return promise;
}

module.exports = { load, resolveStage, importTarget };
