'use strict';

const assert = require('assert');
const officeCli = require('./office-cli');

const env = {
  APPDATA: 'C:\\Users\\tester\\AppData\\Roaming',
  LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
  USERPROFILE: 'C:\\Users\\tester',
  ComSpec: 'C:\\Windows\\System32\\cmd.exe',
};
const installed = 'C:\\Users\\tester\\AppData\\Roaming\\npm\\officecli.cmd';
let call = null;
const result = officeCli.probe({
  env, platform: 'win32', exists: (item) => item === installed,
  run(command, args, options) {
    call = { command, args, options };
    return { status: 0, stdout: 'officecli version 0.2.121\n', stderr: '' };
  },
});
assert.equal(result.ok, true);
assert.equal(result.command, installed);
assert.equal(call.command, env.ComSpec);
assert.deepEqual(call.args, ['/d', '/s', '/c', '"' + installed + '" --version']);
assert.equal(call.options.windowsVerbatimArguments, true);
assert.equal(call.options.encoding, null);

const broken = officeCli.probe({
  env, platform: 'win32', exists: (item) => item === installed,
  run: () => ({ status: 1, stdout: '', stderr: 'node is unavailable' }),
});
assert.equal(broken.ok, false);
assert.match(broken.reason, /已找到 Office CLI/);
assert.doesNotMatch(broken.reason, /尚未安装/);

const gb18030Error = Buffer.from([
  0xb2, 0xbb, 0xca, 0xc7, 0xc4, 0xda, 0xb2, 0xbf, 0xbb,
  0xf2, 0xcd, 0xe2, 0xb2, 0xbf, 0xc3, 0xfc, 0xc1, 0xee,
]);
const localized = officeCli.probe({
  env, platform: 'win32', exists: (item) => item === installed,
  run: () => ({ status: 1, stdout: Buffer.alloc(0), stderr: gb18030Error }),
});
assert.match(localized.reason, /不是内部或外部命令/);
assert.doesNotMatch(localized.reason, /�/);

/*
 * Include the managed vendor officecli candidate from active.json unless explicitOnly is
 * enabled.
 */
const managedRoot = 'C:\\Users\\tester\\AppData\\Local\\soduwork';
const managedCli = managedRoot +
  '\\components\\office\\1.0.143\\node_modules\\@officecli\\officecli\\vendor\\officecli.exe';
const managedOpts = {
  exists: (item) => item === managedCli,
  readJson: (file) => String(file).endsWith('active.json')
    ? { components: { office: '1.0.143' } } : null,
};
assert.equal(officeCli.managed(env, 'win32', managedOpts), managedCli);
assert.ok(officeCli.managedCandidates(env, 'win32', managedOpts).includes(managedCli));
assert.ok(!officeCli.candidates(env, 'win32', true).includes(managedCli));

/* Reject invalid version paths and missing active.json metadata. */
assert.equal(officeCli.managed(env, 'win32', {
  exists: () => true,
  readJson: () => ({ components: { office: '..\\evil' } }),
}), '');
assert.equal(officeCli.managed(env, 'win32', {
  exists: () => true, readJson: () => null,
}), '');

/* Prefer SODUWORK_DATA_ROOT over the LOCALAPPDATA fallback. */
const customRoot = 'D:\\soduwork-data';
const customCli = customRoot +
  '\\components\\office\\1.0.143\\node_modules\\@officecli\\officecli\\vendor\\officecli.exe';
assert.equal(officeCli.managed({ SODUWORK_DATA_ROOT: customRoot }, 'win32', {
  exists: (item) => item === customCli,
  readJson: (file) => String(file).endsWith('active.json')
    ? { components: { office: '1.0.143' } } : null,
}), customCli);

console.log('office cli detection: 19 assertions passed');
