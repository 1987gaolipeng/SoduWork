'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'soduwork-update-e2e-registry-'));
  t.after(async () => {
    assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith('soduwork-update-e2e-registry-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const source = await fs.readFile(path.resolve(__dirname, '../e2e/fixtures/isolated-installer-build.cjs'), 'utf8');
  const module = { exports: {} }; let invoked;
  vm.runInNewContext(source, { module, require: name => name === 'electron-builder'
    ? { build: async options => { invoked = options; return []; } } : require(name) });
  const options = { config: { appId: 'com.soduwork.update.e2e.12345',
    directories: { output: path.join(root, 'dist') },
    nsis: { include: path.resolve(__dirname, '../build/installer.nsh') } } };
  return { root, options, build: module.exports.build, invoked: () => invoked };
}

test('every fixture build overrides both file-open namespaces before installer and uninstaller includes', async t => {
  const f = await fixture(t), original = f.options.config.nsis.include;
  await f.build(f.options);
  const config = JSON.parse(await fs.readFile(f.invoked().config, 'utf8'));
  const wrapper = await fs.readFile(config.nsis.include, 'utf8');
  assert.equal(path.dirname(config.nsis.include), f.root);
  assert.match(wrapper, /^!define SODUWORK_FILE_VERB "Software\\Classes\\\*\\shell\\SoduWork\.E2E\.[a-f0-9]{16}"\n/);
  assert.match(wrapper, /!define SODUWORK_OPEN_APP "Software\\Classes\\Applications\\SoduWork\.E2E\.[a-f0-9]{16}\.exe"\n!include /);
  assert.ok(wrapper.includes(original)); assert.equal(f.options.config.nsis.include, original);
  await f.build(f.options);
  assert.equal(await fs.readFile(config.nsis.include, 'utf8'), wrapper, 'rebuild keeps its own registration stable');
  f.options.config.appId += '.notice'; await f.build(f.options);
  assert.notEqual(await fs.readFile(config.nsis.include, 'utf8'), wrapper, 'independent fixture variants do not overwrite each other');
});

test('production appId and ambiguous includes are rejected before builder runs', async t => {
  const f = await fixture(t); f.options.config.appId = 'com.soduwork.app';
  await assert.rejects(f.build(f.options), /isolated appId/); assert.equal(f.invoked(), undefined);
  f.options.config.appId = 'com.soduwork.update.e2e.12345'; f.options.config.nsis.include = 'relative.nsh';
  await assert.rejects(f.build(f.options), /include must be explicit/); assert.equal(f.invoked(), undefined);
});

test('real NSIS resolves isolated definitions when production file-open macros are included', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t), original = path.join(f.root, 'check-include.nsh');
  const hook = path.resolve(__dirname, '../build/file-open.nsh');
  await fs.writeFile(original, [
    '!include "' + hook + '"',
    '!if "${SODUWORK_FILE_VERB}" == "Software\\Classes\\*\\shell\\SoduWork.Open"',
    '!error "Production file verb leaked into fixture"', '!endif',
    '!if "${SODUWORK_OPEN_APP}" == "Software\\Classes\\Applications\\SoduWork.exe"',
    '!error "Production application registration leaked into fixture"', '!endif', '',
  ].join('\n'));
  f.options.config.nsis.include = original; await f.build(f.options);
  const config = JSON.parse(await fs.readFile(f.invoked().config, 'utf8'));
  const script = path.join(f.root, 'compile-only.nsi');
  await fs.writeFile(script, ['Unicode true', 'RequestExecutionLevel user',
    'OutFile "' + path.join(f.root, 'not-executed.exe') + '"',
    '!define APP_EXECUTABLE_FILENAME "SoduWork.exe"',
    '!include "' + config.nsis.include + '"', 'Section', 'SectionEnd', '',
  ].join('\n'));
  const compiler = await require('app-builder-lib/out/toolsets/windows').getMakeNsisPath();
  const result = spawnSync(compiler.path, ['/V2', '/INPUTCHARSET', 'UTF8', script],
    { env: { ...process.env, ...compiler.env }, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
