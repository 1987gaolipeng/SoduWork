'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const modulePath = require.resolve('../main/conversation/titles');
const titles = require(modulePath);
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-title-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, app: { getPath: () => root } };
}
test('renames persist across process cache reload without changing task or transcript metadata', t => {
  const { app } = fixture(t);
  const row = { id: 'pi-1', title: 'original', taskTitle: 'Keep task', taskId: 't1', at: 50 };
  const saved = titles.save(app, row.id, '  周报  复核 📝  ');
  assert.equal(saved.title, '周报 复核 📝');
  const originalModule = require.cache[modulePath];
  t.after(() => { require.cache[modulePath] = originalModule; });
  delete require.cache[modulePath];
  const decorated = require(modulePath).decorate(app, row);
  assert.equal(decorated.title, saved.title);
  assert.equal(decorated.customTitle, saved.title);
  assert.equal(decorated.at, 50);
  assert.equal(decorated.taskTitle, 'Keep task');
  assert.equal(row.title, 'original');
});
test('labels are independent of adapter and cannot escape their metadata directory', t => {
  const { app, root } = fixture(t);
  for (const id of ['pi/1', 'codex:1', 'opencode/2', '../../escape']) titles.save(app, id, id);
  const files = fs.readdirSync(path.join(root, 'conversation-titles'));
  assert.equal(files.length, 4);
  assert.ok(files.every(file => /^[a-f0-9]{64}\.json$/.test(file)));
  assert.deepEqual(fs.readdirSync(root), ['conversation-titles']);
});
test('title validation rejects blank, invalid types and overlong values, but accepts 120 Unicode characters', () => {
  for (const value of ['', ' \n ', null, {}, 'a'.repeat(121)]) assert.throws(() => titles.normalize(value));
  assert.equal(titles.normalize('📝'.repeat(120)), '📝'.repeat(120));
});
test('renaming twice creates a newer revision and leaves no temporary files', t => {
  const { app, root } = fixture(t);
  const a = titles.save(app, 'same', 'A'), b = titles.save(app, 'same', 'B');
  assert.ok(b.titleUpdatedAt > a.titleUpdatedAt);
  assert.equal(titles.decorate(app, { id: 'same', title: 'automatic' }).title, 'B');
  assert.equal(fs.readdirSync(path.join(root, 'conversation-titles')).length, 1);
});
test('profiles are isolated and automatic titles remain unchanged when there is no override', t => {
  const a = fixture(t), b = fixture(t), row = { id: 'same', title: 'Original' };
  titles.save(a.app, row.id, 'Mine');
  assert.equal(titles.decorate(b.app, row), row);
  assert.equal(titles.decorate(a.app, row).title, 'Mine');
});
test('failed persistence cannot return success or poison the in-memory title', t => {
  const { app, root } = fixture(t);
  const original = titles.save(app, 'test', 'Original');
  const rename = fs.renameSync;
  fs.renameSync = () => { throw Error('simulated disk failure'); };
  try { assert.throws(() => titles.save(app, 'test', 'Not saved'), /disk failure/); }
  finally { fs.renameSync = rename; }
  assert.equal(titles.decorate(app, { id: 'test' }).title, original.title);
  assert.equal(fs.readdirSync(path.join(root, 'conversation-titles')).length, 1);
});

function firstTurnFixture(t, options = {}) {
  const { app } = fixture(t), calls = [], applied = [];
  const now = Math.floor(Date.now() / 1000);
  const identity = { hub: 'http://127.0.0.1:9', clientId: 'synthetic',
    session: Buffer.from(JSON.stringify({ typ: 'device', uid: 'owner', cid: 'synthetic',
      iat: now, exp: now + 600 })).toString('base64url') + '.' + 'a'.repeat(64) };
  const handle = { sessionId: 'fixture', adapterId: 'pi',
    snapshot: () => ({ modelSelection: { model: { id: 'selected-model' } } }),
    applyGeneratedTitle: title => applied.push(title) };
  const service = require('../main/conversation/first-turn-title').create({ app,
    identityOf: async () => identity, authorizeAI: async () => {}, isCurrent: () => true,
    resolveModel: async (_identity, name) => ({ ok: true, model: { id: name, baseUrl: identity.hub } }),
    fetchImpl: async (_url, request) => {
      calls.push(JSON.parse(request.body));
      await options.beforeReply?.();
      return Response.json(options.completion?.(calls.at(-1)) ?? {
        choices: [{ message: {content: '整理用量记录'}, finish_reason: 'stop' }],
      });
    }, ...options });
  service.enroll(handle);
  return { app, handle, calls, applied, send: text => service.accepted(handle, service.prepare(handle, text)) };
}

test('one bounded title request uses the selected model and only visible first-turn text', async t => {
  const f = firstTurnFixture(t);
  const text = '😀'.repeat(520);
  await f.send(require('../main/pi-session/connector-context.cjs').augment(text, 'private connector guide'));
  await f.send(text);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].model, 'selected-model');
  assert.equal(f.calls[0].messages[1].content, '😀'.repeat(512));
  assert.equal(f.calls[0].max_tokens, 512);
  assert.deepEqual(f.applied, ['整理用量记录']);
  assert.equal(titles.decorate(f.app, { id: 'fixture' }).title, '整理用量记录');
  titles.save(f.app, 'fixture', '个人名称');
  assert.equal(titles.decorate(f.app, { id: 'fixture' }).title, '个人名称');
});

test('short first messages and account-owned agents never start a title request on follow-up', async t => {
  for (const [agent, text] of [['pi', '修复登录'], ['codex', 'x'.repeat(80)]]) {
    const f = firstTurnFixture(t);
    f.handle.adapterId = agent;
    await f.send(text);
    await f.send('long follow-up '.repeat(20));
    assert.equal(f.calls.length, 0);
  }
});

test('a provider can use the first 64 completion tokens for reasoning and still return a visible title', async t => {
  const f = firstTurnFixture(t, { completion: body => {
    const fits = body.max_tokens >= 72;
    return { choices: [{ message: { content: fits ? '苏州周末慢游' : '' }, finish_reason: fits ? 'stop' : 'length' }],
      usage: { completion_tokens: fits ? 72 : 64, completion_tokens_details: { reasoning_tokens: 64 } } };
  } });
  await f.send('规划一次适合长辈的苏州双日游。'.repeat(4));
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.applied, ['苏州周末慢游']);
});

test('exhausting the entire reasoning budget keeps the preview without a second charge', async t => {
  const f = firstTurnFixture(t, { completion: () => ({
    choices: [{ message: { content: '', reasoning_content: 'internal' }, finish_reason: 'length' }],
  }) });
  await f.send('规划一个周末的博物馆参观路线。'.repeat(4));
  await f.send('换成室内活动。'.repeat(10));
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.applied, []);
});

test('an unavailable selection cannot use another model to generate a title', async t => {
  const f = firstTurnFixture(t, { resolveModel: async () => ({ ok: true,
    model: { id: 'account-default', baseUrl: 'http://127.0.0.1:9' } }) });
  await f.send('请求'.repeat(50));
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.applied, []);
});

test('an unreadable or already populated snapshot does not start a title request', async t => {
  for (const snapshot of [() => { throw Error('closed'); }, () => ({
    modelSelection: { model: { id: 'selected-model' } }, messages: [{ role: 'user' }],
  })]) {
    const f = firstTurnFixture(t);
    f.handle.snapshot = snapshot;
    await f.send('请求'.repeat(50));
    assert.equal(f.calls.length, 0);
  }
});

test('a late generation cannot replace a manual name or recreate a closed session', async t => {
  for (const action of ['rename', 'close']) {
    let current = true, release, started;
    const ready = new Promise(resolve => { started = resolve; });
    const f = firstTurnFixture(t, { isCurrent: () => current, beforeReply: () =>
      new Promise(resolve => { release = resolve; started(); }) });
    const pending = f.send('请求'.repeat(50));
    await ready;
    if (action === 'rename') titles.save(f.app, 'fixture', '手动名称');
    else current = false;
    release();
    await pending;
    assert.deepEqual(f.applied, []);
    assert.equal(titles.decorate(f.app, { id: 'fixture' }).title, action === 'rename' ? '手动名称' : undefined);
  }
});
