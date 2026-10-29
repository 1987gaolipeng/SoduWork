const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MARKER, patchSource } = require('../scripts/patch-pi-extension-cache.cjs');

test('Pi extension cache patch is idempotent and keeps the runtime cwd check out of cache identity', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-pi-cache-'));
  const file = path.join(dir, 'loader.js');
  fs.writeFileSync(file, [
    'function useExtensionCacheCwd(cwd) {',
    '    const resolvedCwd = resolvePath(cwd);',
    '    if (extensionCacheCwd !== undefined && extensionCacheCwd !== resolvedCwd) {',
    '        clearExtensionCache();',
    '    }',
    '    extensionCacheCwd = resolvedCwd;',
    '    return { cwd: resolvedCwd, generation: extensionCacheGeneration };',
    '}',
    'function isCurrentCacheToken(cacheToken) {',
    '    return (cacheToken !== undefined &&',
    '        extensionCacheCwd === cacheToken.cwd &&',
    '        extensionCacheGeneration === cacheToken.generation);',
    '}',
  ].join('\n'));
  const first = patchSource(file);
  const second = patchSource(file);
  const source = fs.readFileSync(file, 'utf8');
  assert.equal(first.ok, true);
  assert.equal(first.patched, true);
  assert.equal(second.ok, true);
  assert.equal(second.already, true);
  assert.equal(source.includes(MARKER), true);
  assert.equal(source.includes('extensionCacheCwd === cacheToken.cwd'), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
