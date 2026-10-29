'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const crypto = require('node:crypto');
const { createBindings } = require('../main/conversation/task-bindings');
const failure = code => Object.assign(Error('injected ' + code), { code });

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-task-bindings-'));
  const app = { getPath: () => root }, id = 'switched-agent-session';
  const directory = path.join(root, 'conversation-tasks');
  const file = path.join(directory, crypto.createHash('sha256').update(id).digest('hex') + '.json');
  t.after(() => { t.mock.restoreAll(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); });
  return { app, id, directory, file, bindings: createBindings(app, id),
    reload: () => createBindings(app, id).view(),
    contents: () => JSON.parse(fs.readFileSync(file, 'utf8')),
    files: () => fs.readdirSync(directory).sort() };
}

test('task bindings survive EXDEV on first save and update without overwriting unrelated temporary files', t => {
  const f = fixture(t);
  fs.mkdirSync(f.directory, { recursive: true });
  fs.writeFileSync(f.file + '.tmp', 'unrelated recovery data');
  t.mock.method(fs, 'renameSync', () => { throw failure('EXDEV'); });
  assert.equal(f.bindings.bind('requirement-1', 'Original title').ok, true);
  assert.equal(f.bindings.bind('requirement-2', 'Second requirement').ok, true);
  assert.equal(f.bindings.bind('requirement-1', 'Updated title').ok, true);
  const expected = [{ taskId: 'requirement-2', title: 'Second requirement' }, { taskId: 'requirement-1', title: 'Updated title' }];
  assert.deepEqual(f.contents(), expected);
  assert.deepEqual(f.reload().taskBindings, expected);
  assert.equal(f.reload().activeTaskId, 'requirement-1');
  assert.equal(fs.readFileSync(f.file + '.tmp', 'utf8'), 'unrelated recovery data');
  assert.deepEqual(f.files(), [path.basename(f.file), path.basename(f.file) + '.tmp'].sort());
});

for (const stage of ['backup', 'target']) test('failed ' + stage + ' copy keeps persisted and in-memory task bindings unchanged', t => {
  const f = fixture(t);
  assert.equal(f.bindings.bind('requirement-original', 'Keep this requirement').ok, true);
  const before = f.bindings.view(), originalBytes = fs.readFileSync(f.file);
  const copy = fs.copyFileSync.bind(fs);
  t.mock.method(fs, 'renameSync', () => { throw failure('EXDEV'); });
  t.mock.method(fs, 'copyFileSync', (source, target, flags) => {
    const fail = stage === 'backup' ? source === f.file : target === f.file && source.endsWith('.tmp');
    if (!fail) return copy(source, target, flags);
    fs.writeFileSync(target, 'incomplete'); throw failure('EIO');
  });
  assert.equal(f.bindings.bind('requirement-new', 'Must not replace the old binding').ok, false);
  assert.deepEqual(f.bindings.view(), before);
  assert.deepEqual(fs.readFileSync(f.file), originalBytes);
  assert.deepEqual(f.reload(), before);
  assert.deepEqual(f.files(), [path.basename(f.file)]);
});

test('a failed initial EXDEV copy does not publish a partial task binding', t => {
  const f = fixture(t), copy = fs.copyFileSync.bind(fs);
  t.mock.method(fs, 'renameSync', () => { throw failure('EXDEV'); });
  t.mock.method(fs, 'copyFileSync', (source, target, flags) => {
    if (target !== f.file) return copy(source, target, flags);
    fs.writeFileSync(target, 'partial'); throw failure('EIO');
  });
  assert.equal(f.bindings.bind('requirement-1', 'Never accepted').ok, false);
  assert.deepEqual(f.bindings.view().taskBindings, []);
  assert.deepEqual(f.reload().taskBindings, []);
  assert.deepEqual(f.files(), []);
});

test('task binding permission failures do not fall back to copying or alter the old association', t => {
  const f = fixture(t);
  assert.equal(f.bindings.bind('requirement-original', 'Keep').ok, true);
  const before = f.bindings.view();
  t.mock.method(fs, 'renameSync', () => { throw failure('EACCES'); });
  t.mock.method(fs, 'copyFileSync', () => assert.fail('access errors must not trigger copy fallback'));
  assert.equal(f.bindings.bind('requirement-new', 'Denied').ok, false);
  assert.deepEqual(f.bindings.view(), before);
  assert.deepEqual(f.reload(), before);
  assert.deepEqual(f.files(), [path.basename(f.file)]);
});

test('task binding temporary write failures preserve the old association and clean partial temporary data', t => {
  const f = fixture(t);
  assert.equal(f.bindings.bind('requirement-original', 'Keep').ok, true);
  const before = f.bindings.view(), write = fs.writeFileSync.bind(fs);
  t.mock.method(fs, 'writeFileSync', (file, data, options) => {
    if (!String(file).endsWith('.tmp')) return write(file, data, options);
    write(file, 'partial', options); throw failure('ENOSPC');
  });
  assert.equal(f.bindings.bind('requirement-new', 'Not saved').ok, false);
  assert.deepEqual(f.bindings.view(), before);
  assert.deepEqual(f.reload(), before);
  assert.deepEqual(f.files(), [path.basename(f.file)]);
});

for (const fail of [false, true]) test('Agent switch with existing requirements ' + (fail ? 'rolls back after a binding storage failure' : 'migrates bindings despite EXDEV'), async t => {
  const f = fixture(t), switchable = require('../main/agent-runtime/switchable-conversation');
  const segments = require('../main/conversation/runtime-segments');
  assert.equal(f.bindings.bind('requirement-1', 'Keep linked requirement').ok, true);
  const candidateId = 'new-agent-segment', candidateBindings = createBindings(f.app, candidateId);
  const candidateFile = path.join(f.directory, crypto.createHash('sha256').update(candidateId).digest('hex') + '.json');
  const disposed = [], changed = [], messages = [{ role: 'user', text: 'Existing conversation' }];
  const initial = {
    sessionId: f.id, ref: 'chat-existing', adapterId: 'qwen', cwd: f.directory,
    taskBindings: f.bindings.view().taskBindings,
    snapshot: () => ({ status: 'idle', messages, tools: [], modelSelection: { name: 'model-a' } }),
    historyRow: () => ({ title: 'Existing conversation', count: 1 }),
    on: () => () => {}, submit: () => ({ accepted: true }),
  };
  const candidate = {
    sessionId: candidateId, ref: 'chat-candidate', adapterId: 'opencode', cwd: f.directory,
    bindTask: (id, title) => candidateBindings.bind(id, title),
    snapshot: () => ({ status: 'idle', messages: [], tools: [] }),
    on: () => () => {},
  };
  const now = Math.floor(Date.now() / 1000);
  const identity = { hub: 'http://127.0.0.1:9', clientId: 'fixture-device', session: Buffer.from(JSON.stringify({
    typ: 'device', uid: 'fixture-user', cid: 'fixture-device', iat: now - 10, exp: now + 3600,
  })).toString('base64url') + '.' + 'a'.repeat(64) };
  const handle = switchable.create({ raw: initial, options: { app: f.app, identity, ref: initial.ref },
    openNative: async () => ({ raw: candidate }), disposeNative: async part => { disposed.push(part); },
    changed: part => changed.push(part), probe: async () => ({ ok: true }),
    catalog: { runtime: () => ({ modelMode: 'provider' }) },
  });
  t.mock.method(fs, 'renameSync', () => { throw failure('EXDEV'); });
  if (fail) {
    const copy = fs.copyFileSync.bind(fs);
    t.mock.method(fs, 'copyFileSync', (source, target, flags) => {
      if (target !== candidateFile) return copy(source, target, flags);
      fs.writeFileSync(target, 'partial'); throw failure('EIO');
    });
  }
  const result = await handle.selectAgent('opencode');
  assert.equal(result.ok, !fail, result.reason);
  assert.equal(handle.adapterId, fail ? 'qwen' : 'opencode');
  assert.equal(handle.sessionId, f.id);
  assert.deepEqual(handle.snapshot().messages, messages);
  assert.deepEqual(f.reload().taskBindings, initial.taskBindings);
  assert.equal(changed.length, fail ? 0 : 1);
  assert.equal(disposed.length, 1);
  assert.equal(disposed[0].sessionId, fail ? candidateId : f.id);
  if (fail) {
    assert.equal(segments.read(f.app, f.id), null);
    assert.equal(handle.submit('Continue with original Agent').accepted, true);
    assert.deepEqual(candidateBindings.view().taskBindings, []);
  } else {
    assert.equal(segments.read(f.app, f.id).active.sessionId, candidateId);
    assert.deepEqual(createBindings(f.app, candidateId).view().taskBindings, initial.taskBindings);
  }
  await handle.close();
});
