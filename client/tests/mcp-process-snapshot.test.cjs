'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');

test('Windows snapshots exclude exited WMI records but preserve access-denied identities', async () => {
  const rows = [210001, 210002, 210003].map(pid => ({ pid, parent: 40, created: 12345 }));
  const probes = [], module = { exports: {} };
  const filename = path.resolve(__dirname, '../main/pi-session/mcp-process-tree.js');
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, require: name => name === 'node:child_process' ? {
      execFile: (_file, _args, _opts, done) => done(null, JSON.stringify(rows)),
    } : require(name),
    process: { platform: 'win32', env: {}, kill: (pid, signal) => {
      probes.push([pid, signal]);
      if (pid !== 210001) throw Object.assign(Error('fixture'), { code: pid === 210002 ? 'ESRCH' : 'EPERM' });
    } },
  }, { filename });
  const result = await module.exports.snapshot();
  assert.deepEqual(JSON.parse(JSON.stringify(result)), [rows[0], rows[2]]);
  assert.deepEqual(probes, [[210001, 0], [210002, 0], [210003, 0]], 'liveness probes never terminate processes');
});
