'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const local = require('../main/conversation/local-memory');
const sessions = require('../main/conversation/session-memory');
const organization = require('../main/conversation/organization-context');
const { scope } = require('../main/platform-connections/runtime.cjs');
const { identity } = require('./helpers/platform-session-fixture.cjs');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-learning-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = { getPath: () => root }, owner = scope(identity('one'));
  const options = { app, owner };
  const save = (key, result, extra = {}) => local.saveDigest({ ...options,
    digest: { title: 'Delivery ' + key, completed: true, fields: { goal: 'Build ' + key, outcomes: result }, ...extra },
    scopes: [{ scope: 'session', key }] });
  const read = () => { const rows = local.list({ ...options, scope: 'personal' }).items; return rows[0] && local.get({ ...options, id: rows[0].id }).item; };
  return { root, app, owner, options, save, read };
}
test('completed work automatically forms one personal document, updates idempotently, and is default context', t => {
  const f = fixture(t);
  f.save('alpha', 'First verified result');
  const first = f.read();
  assert.match(first.content, /First verified result/);
  f.save('alpha', 'First verified result');
  assert.equal(f.read().revision, first.revision);
  f.save('alpha', 'Corrected verified result');
  f.save('beta', 'Second completed result');
  const current = f.read();
  assert.equal(current.id, first.id);
  assert.doesNotMatch(current.content, /First verified result/);
  assert.match(current.content, /Corrected verified result/);
  assert.match(current.content, /Second completed result/);
  assert.equal(local.list({ ...f.options, scope: 'personal' }).items.length, 1);
  assert.match(local.context(f.options).prompt, /Second completed result/);
  assert.equal(local.context({ ...f.options, owner: scope(identity('two')) }).prompt, '');
});
test('signed historical summaries backfill without revisiting sessions; incomplete and unsigned data are excluded', t => {
  const f = fixture(t);
  // Historical versions had no completed flag and never wrote personal.md.
  f.save('historical', 'Historical completed work', { completed: undefined });
  f.save('failed', 'Unfinished attempted work', { completed: false });
  f.save('pending', 'Still running', { completed: undefined, fields: { outcomes: 'Still running', pending: 'running' } });
  const dir = path.join(local.userMemoryRoot(f.app, f.owner), 'sessions');
  fs.writeFileSync(path.join(dir, 'f'.repeat(64) + '.md'), '# Injected unsigned summary\n## Outcomes\nDO NOT LEARN');
  fs.writeFileSync(path.join(dir, 'e'.repeat(64) + '.md'), Buffer.alloc(256 * 1024 + 1, 97));
  const current = f.read();
  assert.match(current.content, /Historical completed work/);
  assert.doesNotMatch(current.content, /Unfinished attempted|Still running|DO NOT LEARN/);
  assert.equal(f.read().revision, current.revision);
});
test('user corrections and forgetting survive automatic updates and reload; future unrelated work still accumulates', t => {
  const f = fixture(t);
  f.save('one', 'Original outcome');
  let item = f.read();
  local.update({ ...f.options, id: item.id, revision: item.revision, content: item.content.replace('Original outcome', 'User corrected outcome') });
  f.save('one', 'New automatic version must not overwrite correction');
  f.save('two', 'Another completed delivery');
  item = f.read();
  assert.match(item.content, /User corrected outcome/);
  assert.match(item.content, /Another completed delivery/);
  assert.doesNotMatch(item.content, /must not overwrite/);
  local.remove({ ...f.options, id: item.id });
  assert.equal(f.read(), undefined);
  f.save('one', 'Old source cannot resurrect');
  assert.equal(f.read(), undefined);
  f.save('new', 'New work after forgetting');
  assert.match(f.read().content, /New work after forgetting/);
  assert.doesNotMatch(f.read().content, /Old source|Original|Another/);
});
test('auto summaries have bounded recent history without removing manually written notes', t => {
  const f = fixture(t);
  local.createPersonal({ ...f.options, content: '# My notes\nPermanent manually written agreement.' });
  for (let i = 0; i < 55; i++) f.save('job-' + i, 'Outcome for ' + i);
  const item = f.read();
  assert.equal((item.content.match(/<!-- soduwork-work-memory:/g) || []).length, 50);
  assert.match(item.content, /Permanent manually written agreement/);
  assert.match(item.content, /Outcome for 54/);
  f.save('job-0', 'Outcome for 0');
  assert.equal(f.read().revision, item.revision, 'reopening a pruned old result must not displace newer memory');
});
test('a manual correction that ages out stays protected from later automatic changes', t => {
  const f = fixture(t);
  f.save('old-corrected', 'Original old result');
  const original = f.read();
  local.update({ ...f.options, id: original.id, revision: original.revision, content: original.editableContent.replace('Original old result', 'Permanent user correction') });
  for (let i = 0; i < 52; i++) f.save('recent-' + i, 'Recent outcome ' + i);
  f.save('old-corrected', 'Automatic correction overwrite attempt');
  assert.match(f.read().content, /Permanent user correction/);
  assert.doesNotMatch(f.read().content, /overwrite attempt/);
});
test('Windows memory writes retry a transient rename lock without losing the document', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t), rename = fs.renameSync;
  let rejected = 0;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (path.basename(to) === 'personal.md' && rejected < 2) {
      rejected++;
      throw Object.assign(Error('fixture scanner lock'), { code: 'EPERM' });
    }
    return rename(from, to);
  });
  f.save('locked', 'Verified result survives the transient lock');
  assert.equal(rejected, 2);
  assert.match(f.read().content, /Verified result survives/);
});
test('Windows memory writes preserve the old document and clean staging after a lasting lock', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t);
  f.save('existing', 'Original verified result');
  const item = f.read(), directory = local.userMemoryRoot(f.app, f.owner), file = path.join(directory, 'personal.md');
  const before = fs.readFileSync(file), rename = fs.renameSync;
  let rejected = 0;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === file) {
      rejected++;
      throw Object.assign(Error('fixture persistent lock'), { code: 'EPERM' });
    }
    return rename(from, to);
  });
  assert.throws(() => local.update({ ...f.options, id: item.id, revision: item.revision, content: 'Replacement' }), { code: 'EPERM' });
  assert.equal(rejected, 8);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(fs.readdirSync(directory).some(name => name.endsWith('.tmp')), false);
});
test('source identifiers stay out of the editor; untouched work keeps updating after a manual addition', t => {
  const f = fixture(t);
  f.save('one', 'First result'); f.save('two', 'Second result');
  let item = f.read();
  assert.doesNotMatch(item.editableContent, /<!--/);
  local.update({ ...f.options, id: item.id, revision: item.revision, content: 'My persistent note.\n\n' + item.editableContent.replace('First result', 'My correction') });
  f.save('one', 'Must not overwrite correction'); f.save('two', 'Updated second result');
  item = f.read();
  assert.match(item.content, /My persistent note/); assert.match(item.content, /My correction/);
  assert.match(item.content, /Updated second result/); assert.doesNotMatch(item.content, /Must not overwrite/);
});
test('only visible output after latest user contributes: thoughts, old answers and secrets cannot become outcomes', () => {
  const messages = [{ role: 'user', content: 'A task' }, { role: 'assistant', content: 'Previous result' }, { role: 'user', content: 'Continue' },
    { role: 'assistant', content: [{ type: 'thinking', text: 'HIDDEN THOUGHT' }, { type: 'tool_use', text: 'HIDDEN COMMAND' }] }];
  const empty = sessions.digestSnapshot({ status: 'idle', messages }, 'chat');
  assert.equal(empty.completed, false); assert.equal(empty.fields.outcomes, '');
  messages.push({ role: 'assistant', content: [{ type: 'text', text: 'Report done\napi_key="private-key-value"' }] });
  const valid = sessions.digestSnapshot({ status: 'idle', messages }, 'chat');
  assert.equal(valid.completed, true);
  assert.doesNotMatch(JSON.stringify(valid), /HIDDEN|Previous result|private-key-value/);
});
for (const adapter of ['pi', 'codex-harness', 'opencode', 'claude', 'codex', 'qwen', 'dsh']) {
  test(adapter + ': completed snapshot survives immediate close/new turn, is owner-scoped and reused without explicit selection', async t => {
    const f = fixture(t), handlers = new Map();
    const service = sessions.install({ app: f.app, ipcMain: { handle: (key, fn) => handlers.set(key, fn) }, identityOf: async () => identity('one') });
    let snapshot = { status: 'idle', messages: [] }, receive;
    const session = { sessionId: adapter + '-chat', ui: {}, snapshot: () => snapshot,
      [adapter === 'pi' ? 'on' : 'subscribe']: fn => { receive = fn; return () => {}; } };
    await service.attach(session, identity('one'), { ids: [], items: [], scopes: [] }, [], { workspaceExplicit: false });
    snapshot = { status: 'idle', messages: [{ role: 'user', content: 'Create a report' }, { role: 'assistant', content: 'Verified ' + adapter + ' result' }] };
    receive(adapter === 'pi' ? { kind: 'turn-finished' } : { type: 'turn.completed' });
    snapshot = { status: 'running', messages: [{ role: 'user', content: 'New queued work' }] };
    await session.ui.memorySubscription();
    assert.match(f.read().content, new RegExp('Verified ' + adapter + ' result'));
    assert.doesNotMatch(f.read().content, /New queued work/);
    // Stub only the unrelated Hub transport; real production local/context path.
    const prior = global.fetch; global.fetch = async () => ({ ok: false, status: 503 });
    try { assert.match((await service.context(identity('one'), { workspaceExplicit: false })).prompt, new RegExp('Verified ' + adapter)); }
    finally { global.fetch = prior; }
  });
}
test('failed/cancelled turns do not form personal memory and an account switch cannot redirect a captured digest', async t => {
  const f = fixture(t); let auth = identity('one'), receive;
  const service = sessions.install({ app: f.app, ipcMain: { handle() {} }, identityOf: async () => auth });
  let snapshot = { status: 'running', messages: [{ role: 'user', content: 'Task' }, { role: 'assistant', content: 'Only attempted' }] };
  const session = { sessionId: 'failure', ui: {}, snapshot: () => snapshot, subscribe: fn => { receive = fn; } };
  await service.attach(session, auth, { ids: [], items: [], scopes: [] }, [], {});
  receive({ type: 'turn.failed' });
  await session.ui.memorySubscription();
  assert.equal(f.read(), undefined);
  await service.attach(session, auth, { ids: [], items: [], scopes: [] }, [], {});
  snapshot = { ...snapshot, status: 'idle' };
  receive({ type: 'turn.completed' }); auth = identity('two');
  await session.ui.memorySubscription();
  assert.equal(f.read(), undefined);
  assert.equal(local.list({ app: f.app, owner: scope(auth), scope: 'personal' }).items.length, 0);
});
test('organization reference uses fresh authorization; withdrawal, forbidden access, failures and stalled fetch never reuse stale data', async () => {
  let valid = true;
  const auth = identity('one');
  const fetchImpl = async () => valid ? { ok: true, json: async () => ({ ok: true, prompt: 'Shared verified work', revision: 1, item: { id: 'org', title: 'Team' } }) } : { ok: false, status: 403 };
  assert.match((await organization.context(auth, { fetchImpl })).prompt, /Shared verified/);
  valid = false;
  assert.equal((await organization.context(auth, { fetchImpl })).prompt, '');
  const start = Date.now();
  const result = await organization.context(auth, { fetchImpl: () => new Promise(() => {}), timeoutMs: 30 });
  assert.equal(result.prompt, ''); assert.ok(Date.now() - start < 200);
});
