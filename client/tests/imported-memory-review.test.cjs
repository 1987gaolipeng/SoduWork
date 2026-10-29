'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const memory = require('../main/conversation/session-memory');
const local = require('../main/conversation/local-memory');
const imported = require('../main/conversation/imported-memory');
const { scope } = require('../main/platform-connections/runtime.cjs');
const { identity } = require('./helpers/platform-session-fixture.cjs');

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const edits = { title: 'Reviewed import', fields: { summary: 'Reviewed summary',
  goal: 'PRIVATE IMPORT GOAL', outcomes: 'PRIVATE IMPORT OUTCOME' }, confirmed: true };

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-import-review-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = { getPath: () => root }, handlers = new Map(), requests = [];
  let auth = identity('one');
  const file = path.join(root, 'import.json');
  fs.writeFileSync(file, JSON.stringify({ sessionId: 'import-source', messages: [
    { role: 'user', content: 'Original request' },
    { role: 'assistant', content: 'Original evidence api_key=do-not-store-this' },
  ] }));
  t.mock.method(global, 'fetch', async (url, options) => {
    requests.push({ url: String(url), body: options?.body });
    if (String(url).endsWith('/organization-context')) return { ok: true,
      json: async () => ({ ok: true, prompt: '', items: [] }) };
    return { ok: false, status: 503, json: async () => ({ detail: 'offline fixture' }) };
  });
  function install() {
    return memory.install({ app, ipcMain: { handle: (name, action) => handlers.set(name, action) },
      dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [file] }) },
      BrowserWindow: { fromWebContents: () => null }, identityOf: async () => auth });
  }
  let service = install();
  const call = (name, ...args) => handlers.get('session-memory-' + name)({ sender: { id: 1 } }, ...args);
  return { root, app, file, call, requests, get service() { return service; },
    get auth() { return auth; }, setAuth(value) { auth = value; },
    restart() { handlers.clear(); service = install(); },
    async save(changes = {}) {
      const preview = await call('preview');
      assert.equal(preview.ok, true, preview.reason);
      const saved = await call('confirm', preview.previewId, { ...edits, ...changes });
      assert.equal(saved.ok, true, saved.reason);
      return saved;
    },
  };
}
function storeFile(f, id) {
  return path.join(local.userMemoryRoot(f.app, scope(f.auth)), 'imports', id + '.json');
}
function legacy(f, { key = hash('legacy-source').slice(0, 32), fields = edits.fields, title = 'Reviewed legacy title' } = {}) {
  const owner = scope(f.auth);
  local.saveDigest({ app: f.app, owner, digest: { title, fields }, scopes: [{ scope: 'session', key }] });
  return { id: key, owner, file: path.join(local.userMemoryRoot(f.app, owner), 'sessions', hash(key) + '.md') };
}

test('default IPC keeps imports local, immutable and reopenable across service restart', async t => {
  const f = fixture(t);
  const saved = await f.save({ events: [{ role: 'assistant', text: 'FORGED EVIDENCE' }] });
  assert.equal(saved.duplicate, false);
  const bytes = fs.readFileSync(storeFile(f, saved.item.id), 'utf8');
  assert.match(bytes, /Original evidence/);
  assert.doesNotMatch(bytes, /FORGED|do-not-store-this/);
  assert.deepEqual(f.requests, [], 'confirm and get must never upload local evidence');
  f.restart();
  assert.deepEqual((await f.call('get', saved.item.id)).item, saved.item);
  const options = await f.call('options');
  assert.equal(options.ok, true);
  assert.deepEqual(options.projects, []);
  assert.ok(f.requests.every(row => row.url.includes('/options?') && !row.body));
});

test('same source import preserves reviewed edits and archived state instead of overwriting', async t => {
  const f = fixture(t), saved = await f.save();
  const updated = await f.call('update', saved.item.id, { ...edits, title: 'Keep my edit', revision: 1 });
  assert.equal(updated.ok, true, updated.reason);
  const archived = await f.call('archive', saved.item.id);
  assert.equal(archived.item.revision, 3);
  fs.writeFileSync(f.file, JSON.stringify({ sessionId: 'import-source', messages: [{ role: 'user', content: 'Changed source' }] }));
  const duplicate = await f.save({ title: 'Do not replace' });
  assert.equal(duplicate.duplicate, true);
  assert.deepEqual(duplicate.item, archived.item);
  assert.equal(duplicate.item.title, 'Keep my edit');
  assert.equal(duplicate.item.archived, true);
});

test('default IPC rejects stale concurrent revisions without losing the accepted update', async t => {
  const f = fixture(t), { item } = await f.save();
  const results = await Promise.all(['first', 'second'].map(title =>
    f.call('update', item.id, { ...edits, title, revision: 1 })));
  assert.equal(results.filter(result => result.ok).length, 1);
  assert.match(results.find(result => !result.ok).reason, /重新打开/);
  const current = await f.call('get', item.id);
  assert.equal(current.item.revision, 2);
  assert.equal(current.item.title, results.find(result => result.ok).item.title);
});

test('account changes reject previews and cannot read, update or select the previous account import', async t => {
  const f = fixture(t), { item } = await f.save(), bytes = fs.readFileSync(storeFile(f, item.id));
  const preview = await f.call('preview');
  f.setAuth(identity('two'));
  assert.equal((await f.call('confirm', preview.previewId, edits)).ok, false);
  assert.equal((await f.call('get', item.id)).ok, false);
  assert.equal((await f.call('update', item.id, { ...edits, revision: 1 })).ok, false);
  assert.doesNotMatch((await f.service.context(f.auth, { memoryIds: [item.id] })).prompt, /PRIVATE IMPORT/);
  f.setAuth(identity('renewed'));
  assert.deepEqual(fs.readFileSync(storeFile(f, item.id)), bytes);
  assert.equal((await f.call('get', item.id)).item.title, edits.title);
});

test('archive and deletion exclude local imports from selected and unselected conversation context', async t => {
  const f = fixture(t), { item } = await f.save();
  assert.match((await f.service.context(f.auth, { memoryIds: [item.id] })).prompt, /PRIVATE IMPORT GOAL/);
  assert.doesNotMatch((await f.service.context(f.auth, {})).prompt, /PRIVATE IMPORT/);
  assert.equal((await f.call('archive', item.id)).ok, true);
  assert.doesNotMatch((await f.service.context(f.auth, { memoryIds: [item.id] })).prompt, /PRIVATE IMPORT/);
  assert.equal((await f.call('restore', item.id)).ok, true);
  assert.match((await f.service.context(f.auth, { memoryIds: [item.id] })).prompt, /PRIVATE IMPORT OUTCOME/);
  assert.equal((await f.call('delete', item.id)).ok, true);
  f.restart();
  assert.equal((await f.call('get', item.id)).ok, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(storeFile(f, item.id))), { id: item.id, deleted: true });
  assert.doesNotMatch((await f.service.context(f.auth, { memoryIds: [item.id] })).prompt, /PRIVATE IMPORT/);
});

test('legacy migration preserves the reviewed title and redacts edited legacy credentials', async t => {
  const f = fixture(t);
  const old = legacy(f, { fields: { summary: 'Legacy api_key=private-legacy-secret',
    goal: 'Edited goal', outcomes: 'Retained outcome' } });
  const source = fs.readFileSync(old.file, 'utf8');
  const migrated = await f.call('get', old.id);
  assert.equal(migrated.ok, true, migrated.reason);
  assert.equal(migrated.item.title, 'Reviewed legacy title');
  assert.match(migrated.item.fields.summary, /Legacy/);
  assert.doesNotMatch(JSON.stringify(migrated), /private-legacy-secret/);
  assert.equal(fs.readFileSync(old.file, 'utf8'), source);
  f.restart();
  assert.deepEqual((await f.call('get', old.id)).item, migrated.item);
});

test('legacy import does not become unselected personal memory and a tombstone blocks remigration', async t => {
  const f = fixture(t), old = legacy(f);
  assert.equal((await f.call('get', old.id)).ok, true);
  assert.doesNotMatch((await f.service.context(f.auth, {})).prompt, /PRIVATE IMPORT/);
  assert.equal((await f.call('archive', old.id)).ok, true);
  assert.doesNotMatch((await f.service.context(f.auth, { memoryIds: [old.id] })).prompt, /PRIVATE IMPORT/);
  assert.equal((await f.call('delete', old.id)).ok, true);
  f.restart();
  assert.equal((await f.call('get', old.id)).ok, false);
  assert.doesNotMatch((await f.service.context(f.auth, {})).prompt, /PRIVATE IMPORT/);
  assert.ok(fs.existsSync(old.file), 'migration never deletes the old source');
});

test('recognizing an old import retracts only untouched learned content and keeps ordinary session learning', async t => {
  const f = fixture(t), old = legacy(f);
  const ordinary = legacy(f, { key: 'ordinary-chat', title: 'Regular completed work',
    fields: { summary: 'Work done', goal: 'ORDINARY GOAL', outcomes: 'ORDINARY RESULT' } });
  assert.match(local.context({ app: f.app, owner: old.owner }).prompt, /PRIVATE IMPORT/);
  assert.equal((await f.call('get', old.id)).ok, true);
  assert.equal((await f.call('archive', old.id)).ok, true);
  const result = await f.service.context(f.auth, {});
  assert.doesNotMatch(result.prompt, /PRIVATE IMPORT/);
  assert.match(result.prompt, /ORDINARY RESULT/);
  assert.ok(fs.existsSync(ordinary.file));
});

test('recognizing an old import preserves a user correction to previously learned content', async t => {
  const f = fixture(t), old = legacy(f);
  const current = local.list({ app: f.app, owner: old.owner, scope: 'personal' }).items[0];
  const file = path.join(local.userMemoryRoot(f.app, old.owner), 'personal.md');
  const text = fs.readFileSync(file, 'utf8').replace('PRIVATE IMPORT OUTCOME', 'USER CORRECTION');
  local.update({ app: f.app, owner: old.owner, id: current.id, content: text, revision: current.revision });
  assert.equal((await f.call('get', old.id)).ok, true);
  assert.equal((await f.call('delete', old.id)).ok, true);
  assert.match((await f.service.context(f.auth, {})).prompt, /USER CORRECTION/);
});

test('import reads and writes reject linked account directories and records', async t => {
  const f = fixture(t), { item } = await f.save();
  const file = storeFile(f, item.id), original = fs.readFileSync(file);
  const outside = path.join(f.root, 'outside'); fs.mkdirSync(outside);
  const target = path.join(outside, 'source.json'); fs.writeFileSync(target, original);
  fs.unlinkSync(file); fs.symlinkSync(target, file, 'file');
  assert.equal((await f.call('get', item.id)).ok, false);
  assert.equal((await f.call('update', item.id, { ...edits, revision: 1 })).ok, false);
  assert.equal((await f.call('delete', item.id)).ok, false);
  assert.deepEqual(fs.readFileSync(target), original);
  fs.unlinkSync(file); fs.rmdirSync(path.dirname(file));
  fs.symlinkSync(outside, path.dirname(file), 'junction');
  assert.equal((await f.call('get', item.id)).ok, false);
  const preview = await f.call('preview');
  assert.equal((await f.call('confirm', preview.previewId, edits)).ok, false);
  assert.deepEqual(fs.readdirSync(outside), ['source.json']);
});

test('failed atomic replacement leaves the reviewed record and no temporary evidence behind', async t => {
  const f = fixture(t), { item } = await f.save();
  const file = storeFile(f, item.id), original = fs.readFileSync(file);
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === file) throw Object.assign(Error('write denied'), { code: 'EACCES' });
    return rename(from, to);
  });
  assert.equal((await f.call('update', item.id, { ...edits, title: 'New title', revision: 1 })).ok, false);
  assert.deepEqual(fs.readFileSync(file), original);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), [item.id + '.json']);
});
