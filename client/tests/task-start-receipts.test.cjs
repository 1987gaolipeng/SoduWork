'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {create} = require('../main/pi-session/start-receipts.cjs');
function identity(uid = 'owner', hub = 'https://hub.example/base') {
  const now = Math.floor(Date.now() / 1000);
  const body = Buffer.from(JSON.stringify({typ: 'device', uid, cid: 'device', iat: now, exp: now + 3600})).toString('base64url');
  return {hub, clientId: 'device', session: body + '.' + 'a'.repeat(64), secret: 'must-not-be-persisted'};
}
function fixture(t, send) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-start-receipt-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  let current = identity();
  const options = {app: {getPath: () => root}, identityOf: async () => current, request: send, intervalMs: 0};
  const service = create(options); t.after(() => service.dispose());
  return {service, options, root, switch: value => {current = value;},
    files: () => fs.readdirSync(path.join(root, 'task-start-receipts')).filter(x => x.endsWith('.json'))};
}
const scope = {conversationId: 'chat', turnId: 'turn'};
test('an offline actual-start receipt survives recreation and retries without storing credentials', async t => {
  let online = false, calls = 0;
  const f = fixture(t, async (id, route, body) => {
    assert.equal(route, '/tasks/issue/conversation-turn');
    assert.equal(body.action, 'started'); assert.equal(body.turnId, 'turn');
    calls++; if (!online) throw Error('offline');
  });
  assert.equal((await f.service.record(identity(), 'issue', scope)).pending, true);
  assert.equal(f.files().length, 1);
  const raw = fs.readFileSync(path.join(f.root, 'task-start-receipts', f.files()[0]), 'utf8');
  assert.doesNotMatch(raw, /must-not-be-persisted|session|secret/);
  // The destination includes the non-secret Hub base path for isolation.
  assert.match(raw, /hub.example/);
  online = true;
  const restarted = create(f.options); t.after(() => restarted.dispose());
  await restarted.flush();
  assert.equal(f.files().length, 0); assert.ok(calls >= 2);
});
test('account, Hub base path and device scope cannot replay another destination receipt', async t => {
  let calls = 0, online = false;
  const f = fixture(t, async () => {calls++; if (!online) throw Error('offline');});
  assert.equal((await f.service.record(identity(), 'issue', scope)).pending, true);
  const before = calls; online = true;
  f.switch(identity('other')); await f.service.flush();
  f.switch(identity('owner', 'https://hub.example/other')); await f.service.flush();
  f.switch({...identity(), clientId: 'other-device'}); await f.service.flush();
  assert.equal(calls, before); assert.equal(f.files().length, 1);
  f.switch(identity()); await f.service.flush(); assert.equal(f.files().length, 0);
});
test('cancelled or replaced turns discard stale receipts', async t => {
  const f = fixture(t, async () => {throw Object.assign(Error('turn closed'), {status: 409});});
  await f.service.record(identity(), 'issue', scope);
  assert.equal(f.files().length, 0);
});
test('ownership is frozen before queue wait even when the token later expires', async t => {
  let calls = 0;
  const f = fixture(t, async () => {calls++;});
  const enqueue = f.service.forTask(identity(), 'issue');
  f.switch(identity('another-account'));
  assert.equal((await enqueue(scope)).pending, true);
  assert.equal(calls, 0);
  f.switch(identity()); await f.service.flush(); assert.equal(calls, 1);
});

test('offline start and each terminal outcome replay in order after app recreation', async t => {
  for (const action of ['complete', 'fail', 'wait', 'cancel']) {
    let online = false; const received = [];
    const f = fixture(t, async (id, route, body) => {
      if (!online) throw Error('offline');
      received.push(body.action);
      assert.equal(body.executor, 'native');
      if (body.action === action) assert.equal(body.submissionMode, 'manual');
    });
    const receipt = f.service.forTask(identity(), 'issue');
    await receipt(scope);
    assert.equal((await receipt.finish(scope, {action, submissionMode: 'manual', output: 'DO NOT SAVE'},
      {started: true})).pending, true);
    const raw = fs.readFileSync(path.join(f.root, 'task-start-receipts', f.files()[0]), 'utf8');
    assert.doesNotMatch(raw, /DO NOT SAVE|must-not-be-persisted|session|secret/);
    f.service.dispose(); online = true;
    const restarted = create(f.options); t.after(() => restarted.dispose());
    await restarted.flush();
    assert.deepEqual(received, ['started', action]); assert.equal(f.files().length, 0);
  }
});

test('a terminal appended during the start request is retained and sent by the same flush', async t => {
  let release, sent;
  const arrived = new Promise(resolve => {sent = resolve;});
  const seen = [];
  const f = fixture(t, async (id, route, body) => {
    seen.push(body.action);
    if (body.action === 'started') {sent(); await new Promise(resolve => {release = resolve;});}
  });
  const receipt = f.service.forTask(identity(), 'issue');
  const first = receipt(scope); await arrived;
  const terminal = receipt.finish(scope, {action: 'complete'}, {started: true});
  release(); await Promise.all([first, terminal]);
  assert.deepEqual(seen, ['started', 'complete']); assert.equal(f.files().length, 0);
});

test('a lost terminal response retries only that terminal after its start was acknowledged', async t => {
  let loseReply = true; const received = [];
  const f = fixture(t, async (id, route, body) => {
    received.push(body.action);
    if (body.action === 'complete' && loseReply) throw Error('response lost after commit');
  });
  const receipt = f.service.forTask(identity(), 'issue');
  assert.equal((await receipt.finish(scope, {action: 'complete'}, {started: true})).pending, true);
  const row = JSON.parse(fs.readFileSync(path.join(f.root, 'task-start-receipts', f.files()[0]), 'utf8'));
  assert.deepEqual(row.steps, [{action: 'complete'}]);
  f.service.dispose(); loseReply = false;
  const restarted = create(f.options); t.after(() => restarted.dispose()); await restarted.flush();
  assert.deepEqual(received, ['started', 'complete', 'complete']); assert.equal(f.files().length, 0);
});
