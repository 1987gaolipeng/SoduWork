'use strict';

/*
 * Pi's DefaultResourceLoader keeps extension factories in a process cache,
 * but the SDK invalidates that cache whenever the working directory changes.
 * SoduWork gives each scratch chat its own directory, so every first message used
 * to re-import and initialise all user extensions (often 8–12 seconds).
 *
 * Keep the cache independent of cwd while leaving each extension factory's
 * runtime/context cwd untouched. Project-specific extension paths remain
 * distinct cache keys, and the SDK still clears the cache when one loader is
 * explicitly reloaded.
 */
const fs = require('node:fs');
const path = require('node:path');

const MARKER = 'SODUWORK_GLOBAL_EXTENSION_FACTORY_CACHE';

function patchSource(file) {
  if (!file || !fs.existsSync(file)) return { ok: false, skipped: true, file };
  let source;
  try { source = fs.readFileSync(file, 'utf8'); } catch (error) {
    return { ok: false, file, reason: String(error && error.message || error) };
  }
  if (source.includes(MARKER)) return { ok: true, already: true, file };

  const cwdBlock = `function useExtensionCacheCwd(cwd) {
    const resolvedCwd = resolvePath(cwd);
    if (extensionCacheCwd !== undefined && extensionCacheCwd !== resolvedCwd) {
        clearExtensionCache();
    }
    extensionCacheCwd = resolvedCwd;
    return { cwd: resolvedCwd, generation: extensionCacheGeneration };
}`;
  const cwdReplacement = `function useExtensionCacheCwd(cwd) {
    const resolvedCwd = resolvePath(cwd);
    // ${MARKER}: cache factories across per-chat working directories. The
    // extension is still initialised with resolvedCwd by the caller.
    if (extensionCacheCwd === undefined) {
        extensionCacheCwd = resolvedCwd;
    }
    return { cwd: resolvedCwd, generation: extensionCacheGeneration };
}`;
  const tokenBlock = `function isCurrentCacheToken(cacheToken) {
    return (cacheToken !== undefined &&
        extensionCacheCwd === cacheToken.cwd &&
        extensionCacheGeneration === cacheToken.generation);
}`;
  const tokenReplacement = `function isCurrentCacheToken(cacheToken) {
    // ${MARKER}: cwd belongs to extension initialisation, not module identity.
    return (cacheToken !== undefined &&
        extensionCacheGeneration === cacheToken.generation);
}`;
  if (!source.includes(cwdBlock) || !source.includes(tokenBlock)) {
    return { ok: false, file, reason: 'unsupported Pi extension loader layout' };
  }
  const next = source.replace(cwdBlock, cwdReplacement).replace(tokenBlock, tokenReplacement);
  try { fs.writeFileSync(file, next, 'utf8'); } catch (error) {
    return { ok: false, file, reason: String(error && error.message || error) };
  }
  return { ok: true, patched: true, file };
}

function candidateFiles({ root = path.resolve(__dirname, '..'), resourcesPath = process.resourcesPath } = {}) {
  const files = [path.join(root, 'node_modules', '@earendil-works', 'pi-coding-agent',
    'dist', 'core', 'extensions', 'loader.js')];
  if (resourcesPath) files.push(path.join(resourcesPath, 'pi', 'node_modules', '@earendil-works', 'pi-coding-agent',
    'dist', 'core', 'extensions', 'loader.js'));
  return [...new Set(files)];
}

function patchPiExtensionCache(options = {}) {
  const results = candidateFiles(options).map(patchSource);
  const failed = results.find(item => item.ok === false && !item.skipped);
  return { ok: !failed, results };
}

if (require.main === module) {
  const result = patchPiExtensionCache();
  if (!result.ok) {
    console.error(result.results.filter(item => !item.ok && !item.skipped)
      .map(item => `${item.file}: ${item.reason}`).join('\n'));
    process.exitCode = 1;
  }
}

module.exports = { MARKER, patchSource, candidateFiles, patchPiExtensionCache };
