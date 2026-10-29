'use strict';

const assert = require('assert');
const path = require('path');
const engine = require('./office-engine');

let calls = [];
const free = engine.probe({
  env: {}, platform: 'win32',
  run(command, args, options) {
    calls.push({ command, args, options });
    return command === 'python.exe'
      ? { status: 0, stdout: 'python-docx + openpyxl + python-pptx\n', stderr: '' }
      : { status: 1, stdout: '', stderr: '' };
  },
});
assert.equal(free.ok, true);
assert.equal(free.provider, 'python-office');
assert.match(free.detail, /免费本地引擎/);
assert.deepEqual(calls[0].args.slice(-2), ['-c', engine.PYTHON_CHECK]);
assert.equal(calls[0].options.shell, false);

calls = [];
const missing = engine.probe({
  env: {}, platform: 'win32',
  run(command) {
    calls.push(command);
    return { status: 1, stdout: '', stderr: 'missing' };
  },
});
assert.equal(missing.ok, false);
assert.match(missing.reason, /免费办公文档引擎/);
assert(!calls.some((item) => /officecli/i.test(item)), 'must not discover a global Office CLI');

/*
 * Verify adoption of the managed officecli into SODUWORK_OFFICECLI and PATH when no owner
 * override exists.
 */
const managedCli = 'C:\\data\\soduwork\\components\\office\\1.0.143\\node_modules\\@officecli\\officecli\\vendor\\officecli.exe';
const adoptEnv = { SODUWORK_DATA_ROOT: 'C:\\data\\soduwork', PATH: 'C:\\Windows' };
const adopted = engine.syncManagedOfficeCliEnv(adoptEnv, {
  platform: 'win32',
  managed: {
    exists: (item) => item === managedCli,
    readJson: (file) => String(file).endsWith('active.json')
      ? { components: { office: '1.0.143' } } : null,
  },
});
assert.equal(adopted, managedCli);
assert.equal(adoptEnv.SODUWORK_OFFICECLI, managedCli);
assert.ok(String(adoptEnv.PATH).startsWith(
  managedCli.slice(0, managedCli.lastIndexOf('\\')) + path.win32.delimiter));

/* Preserve owner configuration and return an empty path when no engine is installed. */
const ownerEnv = { SODUWORK_OFFICECLI: 'D:\\mine\\officecli.exe' };
assert.equal(engine.syncManagedOfficeCliEnv(ownerEnv, {
  platform: 'win32',
  managed: { exists: () => true, readJson: () => ({ components: { office: '9.9.9' } }) },
}), '');
assert.equal(ownerEnv.SODUWORK_OFFICECLI, 'D:\\mine\\officecli.exe');
const emptyEnv = { SODUWORK_DATA_ROOT: 'C:\\data\\soduwork', PATH: '' };
assert.equal(engine.syncManagedOfficeCliEnv(emptyEnv, {
  platform: 'win32',
  managed: { exists: () => false, readJson: () => null },
}), '');
assert.equal(emptyEnv.SODUWORK_OFFICECLI, undefined);

console.log('free office engine: 12 assertions passed');
