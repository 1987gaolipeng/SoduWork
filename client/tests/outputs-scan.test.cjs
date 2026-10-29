'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const outputs = require('../main/pi-session/outputs');

function workspace(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-output-scan-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  return cwd;
}
function put(cwd, relative, at = Date.now()) {
  const target = path.join(cwd, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, '# Report');
  fs.utimesSync(target, new Date(at), new Date(at)); return target;
}

test('Node compile caches cannot displace root or nested reports; ordinary temp documents remain visible', t => {
  const cwd = workspace(t), now = Date.now();
  for (let i = 0; i < 100; i++) put(cwd, 'temp/node-compile-cache/v24-fixture/' + i.toString(16), now);
  put(cwd, '交付报告.md', now - 1000);
  put(cwd, 'temp/补充报告.md', now - 1000);
  const scan = outputs.scan(cwd, now - 2000, now - 2000);
  assert.deepEqual(scan.files.map(file => file.relative).sort(), ['temp/补充报告.md', '交付报告.md']);
  assert.equal(scan.truncated, false);
  assert.ok(scan.files.every(file => file.changedInTurn));
  assert.ok(scan.delivery.items.some(file => file.name === '交付报告.md'));
});

test('a busy child directory cannot evict an older root report through the truncation sentinel', t => {
  const cwd = workspace(t), now = Date.now();
  put(cwd, '交付报告.md', now - 1000);
  for (let i = 0; i < 80; i++) put(cwd, 'a-runtime/' + i + '.log', now);
  const scan = outputs.scan(cwd, now - 2000, now - 2000);
  assert.equal(scan.truncated, true); assert.equal(scan.files.length, 60);
  assert.ok(scan.files.some(file => file.relative === '交付报告.md'));
  assert.equal(scan.delivery.items.find(file => file.name === '交付报告.md').changedInTurn, true);
});

test('file priority retains conversation time filtering, depth limits and symlink boundaries', t => {
  const cwd = workspace(t), now = Date.now();
  put(cwd, 'old.md', now - 10000);
  put(cwd, 'current.md', now);
  put(cwd, 'one/two/three/visible.md', now);
  put(cwd, 'one/two/three/four/hidden.md', now);
  const outside = workspace(t); put(outside, 'external.md', now);
  fs.symlinkSync(outside, path.join(cwd, 'a-linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const scan = outputs.scan(cwd, now - 1000, now - 1000);
  assert.deepEqual(scan.files.map(file => file.relative).sort(), ['current.md', 'one/two/three/visible.md']);
});
