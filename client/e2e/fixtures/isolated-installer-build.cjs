'use strict';
// Passing an object to electron-builder merges package.json resource arrays.
// A standalone configuration keeps fixture installers free of product runtimes.
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const builder = require('electron-builder');
const { createHash, randomUUID } = require('node:crypto');
const productionGuids = new Set([require('../../main/distribution.cjs').current().nsisGuid.toLowerCase()]);
function validateFixtureGuid(value) {
  assert.equal(typeof value, 'string', 'Fixture receipt must provide an isolated NSIS GUID');
  assert.match(value, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i, 'Invalid fixture NSIS GUID');
  assert.ok(!productionGuids.has(value.toLowerCase()), 'Installer fixtures cannot use a production NSIS GUID');
  return value;
}
function createFixtureGuid(explicit) {
  return validateFixtureGuid(explicit === undefined ? randomUUID() : explicit);
}
function fixtureNames(guid) {
  const name = 'SoduWorkE2E_' + validateFixtureGuid(guid).replaceAll('-', '').toLowerCase();
  return { productName: name, executableName: name, shortcutName: name };
}
function validateFixtureIdentity(receipt) {
  const names = fixtureNames(receipt.guid);
  for (const key of Object.keys(names)) assert.equal(receipt[key], names[key], 'Fixture receipt has a mismatched ' + key);
  return names;
}
async function prepareFixtureLauncher(client, identity) {
  const { executableName } = validateFixtureIdentity(identity);
  const output = path.join(client, '.runtime/installer');
  await fs.mkdir(output, { recursive: true });
  const compiler = await require('app-builder-lib/out/toolsets/windows').getMakeNsisPath();
  const result = require('node:child_process').spawnSync(compiler.path, ['/V2', '/INPUTCHARSET', 'UTF8',
    '/DSODUWORK_LAUNCHER_OUT=' + path.join(output, 'SoduWorkLauncher.exe'),
    '/DSODUWORK_EXECUTABLE_NAME=' + executableName + '.exe',
    '/DSODUWORK_ICON=' + path.join(client, 'icon.ico'), path.join(client, 'build/launcher.nsi')],
  { windowsHide: true, encoding: 'utf8', env: { ...process.env, ...compiler.env } });
  assert.equal(result.status, 0, 'Fixture launcher compilation failed: ' + result.stdout + result.stderr);
}
async function readFixtureReuse(root, setup, explicitGuid) {
  assert.equal(path.dirname(root), os.tmpdir(), 'Reused fixture must be a direct TEMP child');
  assert.ok(path.basename(root).startsWith('soduwork-update-e2e-'));
  const realRoot = await fs.realpath(root), realTemp = await fs.realpath(os.tmpdir());
  assert.equal(path.dirname(realRoot), realTemp, 'Reused fixture root cannot redirect outside TEMP');
  assert.ok(path.basename(realRoot).startsWith('soduwork-update-e2e-'));
  assert.equal((await fs.lstat(root)).isSymbolicLink(), false, 'Reused fixture root cannot be a link');
  const config = JSON.parse(await fs.readFile(path.join(root, 'dist-builder.json'), 'utf8'));
  assert.match(config.appId, /^com\.soduwork\.update\.e2e\.\d+$/, 'Reused fixture appId is invalid');
  const guid = validateFixtureGuid(config.nsis?.guid);
  const names = validateFixtureIdentity({ guid, productName: config.productName,
    executableName: config.win?.executableName, shortcutName: config.nsis?.shortcutName });
  if (explicitGuid !== undefined) assert.equal(validateFixtureGuid(explicitGuid).toLowerCase(), guid.toLowerCase(), 'Explicit GUID differs from reused fixture');
  const dist = path.join(root, 'dist');
  assert.equal(path.resolve(config.directories.output), dist, 'Reused fixture output must be its own dist directory');
  assert.equal(await fs.realpath(dist), path.join(realRoot, 'dist'), 'Reused fixture dist cannot redirect elsewhere');
  if (setup !== undefined) {
    assert.ok(path.isAbsolute(setup), 'Reused fixture Setup must be absolute');
    assert.equal(path.dirname(path.resolve(setup)), dist, 'Reused fixture Setup must be inside its own dist');
    assert.equal(path.basename(setup), names.productName + '-1.0.1-Setup.exe', 'Reused fixture Setup name differs from its identity');
    assert.equal(await fs.realpath(setup), path.join(realRoot, 'dist', path.basename(setup)), 'Reused fixture Setup cannot redirect elsewhere');
    const metadata = require('node:child_process').spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '[Diagnostics.FileVersionInfo]::GetVersionInfo($env:SODUWORK_FIXTURE_SETUP) | Select-Object ProductName,ProductVersion | ConvertTo-Json -Compress'],
    { env: { ...process.env, SODUWORK_FIXTURE_SETUP: setup }, windowsHide: true, encoding: 'utf8', timeout: 30000 });
    assert.equal(metadata.status, 0, 'Cannot verify reused fixture Setup metadata');
    const actual = JSON.parse(metadata.stdout);
    assert.equal(actual.ProductName, names.productName, 'Reused Setup is not the isolated fixture');
    assert.equal(actual.ProductVersion, '1.0.1', 'Reused fixture Setup version differs');
  }
  return { id: config.appId, guid, ...names };
}
async function build(options) {
  const output = path.resolve(options.config.directories.output);
  const root = path.dirname(output);
  assert.equal(path.dirname(root), os.tmpdir());
  assert.ok(path.basename(root).startsWith('soduwork-update-e2e-'));
  assert.match(options.config.appId, /^com\.soduwork\.update\.e2e\.[A-Za-z0-9_.-]+$/, 'Installer fixtures must use an isolated appId');
  // Explicit fixture identities must never overlap the distributor's installation.
  if (options.config.nsis?.guid !== undefined) validateFixtureGuid(options.config.nsis.guid);
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
module.exports = { build, createFixtureGuid, validateFixtureGuid, fixtureNames, validateFixtureIdentity,
  prepareFixtureLauncher, readFixtureReuse, Platform: builder.Platform, Arch: builder.Arch };
