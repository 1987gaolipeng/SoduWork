'use strict';
// Passing an object to electron-builder merges package.json resource arrays.
// A standalone configuration keeps fixture installers free of product runtimes.
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const builder = require('electron-builder');
const { createHash } = require('node:crypto');
async function build(options) {
  const output = path.resolve(options.config.directories.output);
  const root = path.dirname(output);
  assert.equal(path.dirname(root), os.tmpdir());
  assert.ok(path.basename(root).startsWith('soduwork-update-e2e-'));
  assert.match(options.config.appId, /^com\.soduwork\.update\.e2e\.[A-Za-z0-9_.-]+$/, 'Installer fixtures must use an isolated appId');
  const include = options.config.nsis?.include;
  assert.ok(typeof include === 'string' && path.isAbsolute(include), 'Fixture installer include must be explicit');
  assert.doesNotMatch(include, /["\r\n\0]/, 'Unsafe NSIS include path');
  // File-open registration is independent of appId. Override both production
  // registry namespaces before loading installer.nsh (also for its uninstaller).
  const suffix = createHash('sha256').update(root + '\0' + options.config.appId).digest('hex').slice(0, 16);
  const isolatedInclude = path.join(root, path.basename(output) + '-isolated-file-open.nsh');
  await fs.writeFile(isolatedInclude, [
    '!define SODUWORK_FILE_VERB "Software\\Classes\\*\\shell\\SoduWork.E2E.' + suffix + '"',
    '!define SODUWORK_OPEN_APP "Software\\Classes\\Applications\\SoduWork.E2E.' + suffix + '.exe"',
    '!include "' + include.replaceAll('$', '$$') + '"', '',
  ].join('\n'));
  const config = { ...options.config, nsis: { ...options.config.nsis, include: isolatedInclude } };
  const configFile = path.join(root, path.basename(output) + '-builder.json');
  const serialized = JSON.stringify(config, (_key, value) => {
    assert.notEqual(typeof value, 'function', 'Fixture hooks must use explicit module paths');
    return value;
  }, 2);
  await fs.writeFile(configFile, serialized);
  return builder.build({ ...options, config: configFile });
}
module.exports = { build, Platform: builder.Platform, Arch: builder.Arch };
