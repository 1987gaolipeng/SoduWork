'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { lineCount, collect, report, category, format } = require('../../tools/check-source-size.cjs');

test('physical line counting handles CRLF and final newlines consistently', () => {
  for (const [text, expected] of [['', 0], ['one', 1], ['one\n', 1], ['one\r\ntwo\r\n', 2], ['\n\n', 2], ['one\rtwo', 2]]) {
    assert.equal(lineCount(text), expected);
  }
});

test('size review includes new source and excludes generated, upstream and linked files', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-source-size-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const names = ['client/main/new.cjs', 'client/core/locales/ja.js', 'client/theme/a.css',
    'skills/example/script.py', 'hub-backend/test_example.py', 'client/exact.js',
    'client/vendor/a.js', 'client/node_modules/a/index.js', 'client/dist/a.js',
    'hub-backend/.venv/lib/a.py', 'third-party/a.js', 'hub-backend/releases/a.py'];
  for (const name of names) {
    const full = path.join(root, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, 'x\n'.repeat(name === 'client/exact.js' ? 800 : 801));
  }
  const rows = collect(root, [...names, 'client/missing.js']);
  assert.deepEqual(rows.map(row => row.file).sort(), names.slice(0, 5).sort());
  assert.equal(rows.every(row => row.lines === 801), true);
  if (process.platform !== 'win32') {
    fs.symlinkSync(path.join(root, 'client/main/new.cjs'), path.join(root, 'client/link.js'));
    assert.deepEqual(collect(root, ['client/link.js']), []);
    fs.symlinkSync(path.join(root, 'client/main'), path.join(root, 'client/linked-dir'));
    assert.deepEqual(collect(root, ['client/linked-dir/new.cjs']), []);
  }
});

test('baseline distinguishes new and growing modules without penalizing existing sizes', () => {
  const baseline = { version: 1, limit: 800, files: [
    { file: 'same.js', lines: 900 }, { file: 'grow.py', lines: 850 },
    { file: 'shrink.js', lines: 1200 }, { file: 'resolved.js', lines: 1000 }] };
  const rows = [{ file: 'same.js', lines: 900 }, { file: 'grow.py', lines: 851 },
    { file: 'shrink.js', lines: 1100 }, { file: 'new.js', lines: 801 }];
  const result = report(rows, baseline);
  assert.deepEqual(result.attention.map(row => row.file), ['grow.py', 'new.js']);
  assert.equal(result.advisory, true);
  assert.match(format(result), /2 new or grown/);
  assert.doesNotMatch(format(result), /same\.js/);
  assert.match(format(result, true), /same\.js/);
  assert.throws(() => report(rows, { ...baseline, limit: 1000 }), /Invalid/);
});

test('resources, skills, tests and styles are visible with their own review categories', () => {
  for (const [name, expected] of [['client/core/locales/ja.js', 'resource'],
    ['skills/example/a.py', 'skill'], ['skills/example/tests/test_a.py', 'test'],
    ['hub-backend/smoke/smoke_example.py', 'test'], ['client/main/a.test.js', 'test'],
    ['client/theme/a.css', 'style'], ['tools/a.cjs', 'tool'], ['hub-backend/app/a.py', 'runtime']]) {
    assert.equal(category(name), expected);
  }
});

test('CLI succeeds when an additional oversized module needs review', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-source-size-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'tools'));
  fs.mkdirSync(path.join(root, 'tools/distribution'));
  fs.mkdirSync(path.join(root, 'client'));
  // An independent source snapshot keeps this fixture out of the actual Git index.
  const manifest = { schema: 1, ok: true, scope: 'Current source snapshot only; fixture',
    files: [{ path: 'client/large.js', bytes: 1602, sha256: '0'.repeat(64) }] };
  fs.writeFileSync(path.join(root, 'tools/distribution/SOURCE-MANIFEST.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(root, 'client/large.js'), 'x\n'.repeat(801));
  fs.writeFileSync(path.join(root, 'tools/source-size-baseline.json'), JSON.stringify({ version: 1, limit: 800, files: [] }));
  for (const name of ['check-source-size.cjs', 'source-files.cjs']) {
    fs.copyFileSync(path.resolve(__dirname, '../../tools', name), path.join(root, 'tools', name));
  }
  const result = spawnSync(process.execPath, [path.join(root, 'tools/check-source-size.cjs'), '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).attention[0].file, 'client/large.js');
});
