'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { environment } = require('./process-host');
const shell = require('../pi-session/shell-runtime');

function filtered(source) {
  const previous = process.env;
  try { process.env = source; return environment(); }
  finally { process.env = previous; }
}

for (const name of ['ProgramFiles', 'ProgramFiles(x86)', 'pRoGrAmFiLeS']) {
  test('runtime discovers an existing system Git from filtered ' + name, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-shell-env-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const programFiles = path.join(root, 'Program Files 中文');
    const bash = path.join(programFiles, 'Git', 'bin', 'bash.exe');
    fs.mkdirSync(path.dirname(bash), { recursive: true });
    fs.writeFileSync(bash, 'isolated shell probe fixture');
    const env = filtered({ [name]: programFiles, PATH: '', OPENAI_API_KEY: 'do-not-inherit',
      SODUWORK_DEVICE_SECRET: 'do-not-inherit', NODE_OPTIONS: '--require=untrusted.cjs' });
    const probed = [];
    const resolved = await shell.resolveAsync({ env, cwd: root, platform: 'win32',
      clientRoot: path.join(root, 'source'), resourceRoot: '',
      run: async (command, args, options) => {
        probed.push(command);
        assert.equal(options.env[name], programFiles);
        assert.equal(options.env.OPENAI_API_KEY, undefined);
        assert.equal(options.env.SODUWORK_DEVICE_SECRET, undefined);
        assert.equal(options.env.NODE_OPTIONS, undefined);
        assert.equal(options.windowsHide, true);
        assert.match(args[1], /command -v git/);
        return { status: 0, stdout: 'SODUWORK_SHELL_OK\n' };
      },
    });
    assert.equal(resolved.source, 'system-git');
    assert.equal(resolved.shellPath, bash);
    assert.deepEqual(probed, [bash], 'the existing shell still passes the production tool probe');
    assert.equal(env.PATH, '', 'discovery must not depend on a test-only PATH addition');
  });
}

test('runtime directory additions do not broaden credential or arbitrary environment forwarding', () => {
  const source = { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    PATH: 'C:\\Windows\\System32', SystemRoot: 'C:\\Windows',
    OPENAI_API_KEY: 'private', ANTHROPIC_API_KEY: 'private', SODUWORK_DEVICE_SECRET: 'private',
    ProgramFilesSecret: 'private', NODE_OPTIONS: '--inspect', ELECTRON_RUN_AS_NODE: '1',
    AWS_ACCESS_KEY_ID: 'private', CUSTOM_UNRELATED_SETTING: 'private' };
  assert.deepEqual(filtered(source), { ProgramFiles: source.ProgramFiles,
    'ProgramFiles(x86)': source['ProgramFiles(x86)'], PATH: source.PATH, SystemRoot: source.SystemRoot });
});
