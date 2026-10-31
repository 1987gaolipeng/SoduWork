'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createRequire } = require('node:module');
const runtime = require('../main/platform-connections/runtime.cjs');

test('a real platform child can be cancelled twice before its exit event', async t => {
  let markReady;
  const ready = new Promise(resolve => { markReady = resolve; });
  const child = runtime.execute(process.execPath,
    ['-e', "process.stdout.write('ready\\n');setInterval(()=>{},1000)"],
    { env: process.env, timeout: 10000, onOutput: output => { if (output.includes('ready')) markReady(); } });
  t.after(() => child.cancel());
  await Promise.race([ready, child.completion.then(() => { throw Error('child exited before readiness'); })]);
  assert.equal(child.cancel(), true);
  assert.equal(child.cancel(), true);
  await child.completion;
  assert.equal(child.cancel(), true);
  assert.throws(() => process.kill(child.child.pid, 0), { code: 'ESRCH' });
});

test('failed Windows tree termination stays observable and retryable', () => {
  const file = path.resolve(__dirname, '../main/platform-connections/runtime.cjs');
  const actualRequire = createRequire(file);
  let calls = 0, status = 1;
  const isolatedRequire = name => name === 'node:child_process'
    ? { ...actualRequire(name), spawnSync: () => { calls++; return { status }; } }
    : actualRequire(name);
  const module = { exports: {} };
  vm.runInNewContext('(function(require,module,exports,__dirname,process){' + fs.readFileSync(file, 'utf8') + '\n})')(
    isolatedRequire, module, module.exports, path.dirname(file), { ...process, platform: 'win32' });
  const child = { pid: 123456, exitCode: null };
  assert.equal(module.exports.stop(child), false);
  assert.equal(module.exports.stop(child), false);
  assert.equal(calls, 2);
  status = 0;
  assert.equal(module.exports.stop(child), true);
  assert.equal(module.exports.stop(child), true);
  assert.equal(calls, 3);
});
