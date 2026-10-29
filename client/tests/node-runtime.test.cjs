'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createResolver } = require('../main/node-runtime.cjs');

function resolver(files, overrides = {}) {
  return createResolver({ platform: 'linux', executable: '/app/electron',
    versions: { electron: '44', node: '24.1.0' },
    environment: { PATH: '/old/bin:/new/bin', NODE_OPTIONS: '--inspect', ELECTRON_RUN_AS_NODE: '1' },
    io: { existsSync: file => file in files, realpathSync: file => files[file]?.link || file },
    probe: (file, args, options) => {
      assert.deepEqual(args, ['--version']);
      assert.equal(options.env.NODE_OPTIONS, undefined);
      assert.equal(options.env.ELECTRON_RUN_AS_NODE, undefined);
      return { status: 0, stdout: files[file] };
    }, ...overrides });
}
test('skips old PATH Node and pairs a compatible native runtime with its npm', () => {
  const select = resolver({ '/old/bin/node': 'v18.20.0', '/new/bin/node': 'v22.23.2', '/new/lib/node_modules/npm/bin/npm-cli.js': '' });
  const runtime = select({ requireNpm: true });
  assert.equal(runtime.node, '/new/bin/node');
  assert.equal(runtime.npm, '/new/lib/node_modules/npm/bin/npm-cli.js');
  assert.equal(runtime.env.PATH, '/new/bin:/old/bin:/new/bin');
  assert.equal(runtime.embedded, false);
});
test('Electron may run reviewed JS but cannot mask missing native Node/npm', () => {
  const select = resolver({ '/old/bin/node': 'v18.20.0' });
  assert.equal(select().embedded, true);
  assert.equal(select().env.ELECTRON_RUN_AS_NODE, '1');
  assert.throws(() => select({ requireNpm: true }), /Node.js 20.*18.20.0.*内置 Node/);
});
test('resolves Linux distro npm symlinks', () => {
  const select = resolver({ '/new/bin/node': 'v22.23.2', '/new/bin/npm': { link: '/usr/share/nodejs/npm/bin/npm-cli.js' }, '/usr/share/nodejs/npm/bin/npm-cli.js': '' });
  assert.equal(select({ requireNpm: true }).npm, '/usr/share/nodejs/npm/bin/npm-cli.js');
});
test('Windows PATH runtime wins over an older Program Files installation', () => {
  const select = resolver({ 'D:\\node22\\node.exe': 'v22.23.2', 'D:\\node22\\node_modules\\npm\\bin\\npm-cli.js': '', 'C:\\Program Files\\nodejs\\node.exe': 'v18.20.0' },
    { platform: 'win32', executable: 'C:\\SoduWork\\SoduWork.exe', environment: { Path: 'D:\\node22' } });
  const runtime = select({ requireNpm: true });
  assert.equal(runtime.node, 'D:\\node22\\node.exe');
  assert.equal(runtime.env.Path, 'D:\\node22;D:\\node22');
});
test('cached probes expire so an installed upgrade is detected without restarting', () => {
  let now = 0, count = 0;
  const select = resolver({ '/new/bin/node': 'v22.23.2' }, { clock: () => now, probe: () => { count++; return { status: 0, stdout: 'v22.23.2' }; } });
  select(); select(); assert.equal(count, 1);
  now = 30001; select(); assert.equal(count, 2);
});
