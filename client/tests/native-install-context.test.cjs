'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

test('native install context describes this transaction without changing installed payloads',
  { skip: process.platform !== 'win32', timeout: 90000 }, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'soduwork-install-context-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const compiler = await require('app-builder-lib/out/toolsets/windows').getMakeNsisPath();
    const quote = value => value.replaceAll('$', '$$');
    const include = path.resolve(__dirname, '../build/install-context.nsh');
    const executables = {};
    for (const mode of ['write', 'read']) {
      const executable = path.join(root, mode + '.exe');
      const script = path.join(root, mode + '.nsi');
      await fs.writeFile(script, [
        'Unicode true', 'RequestExecutionLevel user', 'SilentInstall silent',
        `OutFile "${quote(executable)}"`, '!include "LogicLib.nsh"',
        ...(mode === 'write' ? ['!define SODUWORK_INSTALL_CONTEXT_WRITER',
          '!define APP_EXECUTABLE_FILENAME "Fixture.exe"', '!define VERSION "1.0.1"'] : []),
        `!include "${quote(include)}"`, 'Section',
        'ReadEnvStr $installContextRoot "SODUWORK_INSTALL_CONTEXT_TEST_ROOT"',
        ...(mode === 'write' ? ['Call WriteInstallContext'] : ['Call ReadInstallContext',
          'FileOpen $0 "$installContextRoot\\result.txt" w',
          'FileWrite $0 "$installOperation|$installFromVersion|$installToVersion"', 'FileClose $0']),
        'SectionEnd', '',
      ].join('\n'));
      const built = spawnSync(compiler.path, ['/V2', '/INPUTCHARSET', 'UTF8', script],
        { encoding: 'utf8', windowsHide: true, timeout: 30000, env: { ...process.env, ...compiler.env } });
      assert.equal(built.status, 0, built.stdout + built.stderr);
      executables[mode] = executable;
    }
    async function scenario(name, files, expected, { write = true, blocked = false } = {}) {
      const directory = path.join(root, name);
      await fs.mkdir(directory);
      for (const [relative, value] of Object.entries(files)) {
        const filename = path.join(directory, relative);
        await fs.mkdir(path.dirname(filename), { recursive: true });
        await fs.writeFile(filename, value);
      }
      if (blocked) await fs.mkdir(path.join(directory, '.soduwork-install-context.ini.next'));
      for (const mode of write ? ['write', 'read'] : ['read']) {
        // Flags do not imply an upgrade: old helpers pass /S even on first install.
        const result = spawnSync(executables[mode], ['/S', '--updated'], { encoding: 'utf8',
          windowsHide: true, timeout: 10000,
          env: { ...process.env, SODUWORK_INSTALL_CONTEXT_TEST_ROOT: directory } });
        assert.equal(result.status, 0, name + ': ' + result.stderr);
      }
      assert.equal(await fs.readFile(path.join(directory, 'result.txt'), 'utf8'), expected, name);
      for (const [relative, value] of Object.entries(files)) {
        if (relative === '.soduwork-install-context.ini') continue;
        assert.equal(await fs.readFile(path.join(directory, relative), 'utf8'), value,
          name + ' must not modify ' + relative);
      }
    }
    const installed = version => ({ '.soduwork-active': 'old.tmp', '.soduwork-launcher': '1',
      '.soduwork-versions/old.tmp/Fixture.exe': 'not executed',
      '.soduwork-versions/old.tmp/.soduwork-release': version });
    await scenario('fresh', {}, 'install||1.0.1');
    await scenario('reinstall', installed('1.0.1'), 'reinstall|1.0.1|1.0.1');
    await scenario('upgrade', installed('1.0.0'), 'update|1.0.0|1.0.1');
    await scenario('downgrade', installed('2.0.0'), 'update|2.0.0|1.0.1');
    await scenario('prerelease', installed('1.0.1-beta.2'), 'update|1.0.1-beta.2|1.0.1');
    await scenario('interrupted', { 'Fixture.exe': 'launcher only', '.soduwork-launcher': '1' }, 'install||1.0.1');
    await scenario('previous', { ...installed('1.0.0'), '.soduwork-active': 'missing',
      '.soduwork-previous': 'old.tmp' }, 'update|1.0.0|1.0.1');
    await scenario('flat', { 'Fixture.exe': 'legacy app', '.soduwork-release': '1.0.0' }, 'update|1.0.0|1.0.1');
    await scenario('unknown-flat', { 'Fixture.exe': 'legacy app' }, 'install||1.0.1');
    await scenario('traversal', { ...installed('1.0.0'), '.soduwork-active': '../old.tmp' }, 'install||1.0.1');
    await scenario('invalid-version', installed('1.0.0\ninjected'), 'install||1.0.1');
    await scenario('unknown-version', installed('corrupt'), 'install||1.0.1');
    await scenario('dot-version', installed('..'), 'install||1.0.1');
    await scenario('long-version', installed('1'.repeat(100)), 'install||1.0.1');
    const stale = '[install]\nschema=1\nfrom=0.0.1\nto=0.0.2\n';
    await scenario('retry', { '.soduwork-install-context.ini': stale }, 'install||1.0.1');
    await scenario('write-failure', { '.soduwork-install-context.ini': stale }, 'install||', { blocked: true });
    await scenario('missing-context', {}, 'install||', { write: false });
    await scenario('unknown-schema', { '.soduwork-install-context.ini': stale.replace('schema=1', 'schema=2') },
      'install||', { write: false });
    await scenario('invalid-target', { '.soduwork-install-context.ini': stale.replace('to=0.0.2', 'to=bad version') },
      'install||', { write: false });
  });
