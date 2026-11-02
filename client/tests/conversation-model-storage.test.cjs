'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { preference, create } = require('../main/conversation/model-selection');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-model-storage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = { getPath: () => root }, ref = 'conversation-storage-regression';
  return { app, ref, store: preference(app, ref), directory: path.join(root, 'conversation-models') };
}
const fail = code => Object.assign(Error('private profile path ' + code), { code });

test('restoring an unchanged choice performs no write while changed model or reasoning still requires persistence', t => {
  const f = fixture(t); f.store.write('original', 'medium');
  t.mock.method(fs, 'renameSync', () => { throw fail('EBUSY'); });
  assert.doesNotThrow(() => f.store.write('original', 'medium'));
  assert.doesNotThrow(() => f.store.write('original'));
  assert.throws(() => f.store.write('changed', 'medium'), {code:'EBUSY'});
  assert.throws(() => f.store.write('original', 'high'), {code:'EBUSY'});
  assert.deepEqual(f.store.readSelection(), {name:'original', reasoningEffort:'medium'});
  assert.equal(fs.readdirSync(f.directory).length, 1);
});

test('model preferences survive first save, replacement and reopening when same-directory rename returns EXDEV', t => {
  const f = fixture(t), staged = [];
  t.mock.method(fs, 'renameSync', (source, target) => {
    assert.equal(path.dirname(source), path.dirname(target));
    staged.push(source); throw fail('EXDEV');
  });
  f.store.write('first-model');
  assert.equal(preference(f.app, f.ref).read(), 'first-model');
  f.store.write('next-model');
  assert.equal(preference(f.app, f.ref).read(), 'next-model');
  assert.notEqual(staged[0], staged[1], 'each save owns its staging file');
  assert.equal(fs.readdirSync(f.directory).length, 1);
});

test('a failed EXDEV copy preserves saved and selected models and leaves no staging files', async t => {
  const f = fixture(t); f.store.write('original');
  const copy = fs.copyFileSync;
  t.mock.method(fs, 'renameSync', () => { throw fail('EXDEV'); });
  t.mock.method(fs, 'copyFileSync', (source, target, flags) => {
    if (source.endsWith('.tmp')) { fs.writeFileSync(target, 'partial'); throw fail('EIO'); }
    return copy(source, target, flags);
  });
  const selection = create({ name: 'original', model: { id:'original' },
    resolve: async name => ({ ok:true, model:{ id:name } }),
    persist: name => f.store.write(name), apply: () => assert.fail('must not change active runtime') });
  const result = await selection.select('changed');
  assert.equal(result.ok, false);
  assert.equal(selection.capture(), 'original');
  assert.equal(preference(f.app, f.ref).read(), 'original');
  assert.equal(fs.readdirSync(f.directory).length, 1);
  assert.doesNotMatch(result.reason, /private profile|EXDEV|EIO/);
});

test('permission errors remain failures, retain existing data and do not expose profile paths', t => {
  const f = fixture(t); f.store.write('original');
  t.mock.method(fs, 'renameSync', () => { throw fail('EACCES'); });
  t.mock.method(fs, 'copyFileSync', () => assert.fail('must not bypass permissions'));
  assert.throws(() => f.store.write('changed'), error => {
    assert.equal(error.code, 'EACCES');
    assert.equal(error.cause.code, 'EACCES');
    assert.doesNotMatch(error.message, /private profile|rename|EACCES/);
    return true;
  });
  assert.equal(f.store.read(), 'original');
  assert.equal(fs.readdirSync(f.directory).length, 1);
});
