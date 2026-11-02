'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { create } = require('../main/conversation/cloud-handoff');
const durable = require('../main/verified-file-replace.cjs');
const identity = (uid = 'alice', device = 'one', hub = 'https://hub.invalid') => ({ hub, clientId: device,
  session: Buffer.from(JSON.stringify({ typ: 'device', uid, cid: device, iat: 1, exp: 9999999999 })).toString('base64url') + '.' + 'a'.repeat(64) });
function remote(index = 1) {
  const id = String(index).padStart(36, '0'), request = crypto.randomUUID();
  return { id, title: 'Cloud ' + index, createdAt: '2026-10-30T00:00:00Z', receipt: {
    transferId: request, taskId: 'task-' + index, phase: 'committed', ref: 'ref-' + index,
    source: { sessionId: 'cloud-' + request, adapterId: 'pi', entryKind: 'cloud' }, target: { runnerId: 'cloud', agentId: 'pi' } },
    execution: { ref: 'ref-' + index, status: 'done', engine: 'pi', updatedAt: '2026-10-30T01:00:00Z' } };
}
async function fixture(t, rows = [remote()]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cloud-sync-'));
  const app = { getPath: () => root }, controllers = [], views = [], calls = [];
  let actor = identity(), intercept = null;
  const request = async (who, route) => {
    calls.push({ who, route });
    if (intercept) { const result = await intercept(who, route); if (result !== undefined) return result; }
    const url = new URL(route, 'https://fixture.invalid');
    if (url.pathname === '/cloud-execution-sync') {
      const after = url.searchParams.get('after') || '', limit = Number(url.searchParams.get('limit'));
      const all = rows.filter(row => row.id > after).sort((a, b) => a.id.localeCompare(b.id));
      const items = all.slice(0, limit), more = all.length > limit;
      return { mode: 'reconcile', items, hasMore: more, next: more ? items.at(-1).id : '' };
    }
    if (url.pathname.startsWith('/cloud-execution-sync/')) {
      const row = rows.find(row => row.id === url.pathname.split('/').at(-1)), since = Number(url.searchParams.get('since'));
      assert.ok(row);
      return { conversation: row, page: { ok: true, ref: row.execution.ref, status: 'done',
        last: 2, seq: 2, persistedThrough: 2, hasMore: false, items: [
          { seq: 1, kind: 'user', text: 'Work while closed' }, { seq: 2, kind: 'say', text: 'Finished remotely' },
        ].filter(item => item.seq > since) }, attachments: [],
        messages: row.messages || [],
        approvals: [{ id: 'approval', taskId: row.receipt.taskId, status: 'pending', action: 'review' }] };
    }
    if (route.includes('/ai-session')) return { ref: 'ref-1', status: 'done', last: 2, items: [] };
    if (route.endsWith('/ai-status')) return { status: 'done' };
    if (route.endsWith('/attachments')) return [];
    assert.fail('Unexpected mutation/request: ' + route);
  };
  function controller() { const value = create({ app, identityOf: () => actor, request }); controllers.push(value); return value; }
  t.after(async () => {
    views.forEach(view => view.close());
    await Promise.all(controllers.map(value => value.synchronization.close()));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 50 });
  });
  return { root, app, rows, calls, views, controller, actor: value => { actor = value; },
    intercept: value => { intercept = value; } };
}

test('cold start discovers, persists and reopens cloud work without opening a view or starting a local runtime', async t => {
  const f = await fixture(t), cloud = f.controller();
  assert.equal((await cloud.history()).chats.length, 0);
  assert.equal((await cloud.synchronization.tick()).ok, true);
  const history = await cloud.history();
  assert.equal(history.chats.length, 1); assert.equal(history.chats[0].needsAttention, true);
  const restarted = f.controller(), view = await restarted.reopen(history.chats[0].id, 'reopened'); f.views.push(view);
  assert.equal(view.snapshot().messages.filter(item => item.role === 'assistant').length, 1);
  assert.equal(view.snapshot().cloudApprovals[0].id, 'approval');
  assert.equal(view.passiveCloudView, true);
  view.close();
  assert.equal(f.calls.some(item => /ai-stop|ai-dispatch|ai-say/.test(item.route)), false);
});

test('another device discovers the same account cloud work with no local history', async t => {
  const f = await fixture(t); f.actor(identity('alice', 'new-device'));
  const cloud = f.controller(); await cloud.synchronization.tick();
  assert.equal((await cloud.history()).chats.length, 1);
  f.actor(identity('bob', 'new-device'));
  assert.equal((await cloud.history()).chats.length, 0);
  f.actor(identity('alice', 'new-device', 'https://other.invalid'));
  assert.equal((await cloud.history()).chats.length, 0);
});

test('reopened queued continuation retains a waiting status until Hub acknowledges it', async t => {
  const row = remote();
  row.messages = [{ id: 'receipt', messageId: 'original-send', phase: 'queued' }];
  const f = await fixture(t, [row]), cloud = f.controller();
  await cloud.synchronization.tick();
  const id = (await cloud.history()).chats[0].id;
  const view = await cloud.reopen(id, 'pending-view'); f.views.push(view);
  assert.match(view.snapshot().statusText, /消息已保存/);
  assert.equal(view.snapshot().cloudMessages[0].messageId, 'original-send');
  row.messages = [];
  await cloud.synchronization.tick();
  assert.equal(view.snapshot().statusText, '');
  assert.equal(f.calls.some(item => item.route.endsWith('/ai-say')), false);
});

test('a lost create response is reconciled into its original frozen session after restart without resubmission', async t => {
  const f = await fixture(t), original = f.controller(), row = f.rows[0];
  const input = { requestId: row.receipt.transferId, agentId: 'pi', text: 'Accept once, then lose the reply' };
  f.intercept(async (_actor, route) => { if (route.startsWith('/cloud-conversations/')) throw Error('reply lost after acceptance'); });
  await assert.rejects(original.start(input), /reply lost/);
  const id = 'cloud-' + input.requestId;
  assert.deepEqual((await original.history()).chats.map(item => item.id), [id]);
  await original.synchronization.close();
  const restarted = f.controller(), view = await restarted.reopen(id, 'pending-reply'); f.views.push(view);
  assert.equal(view.snapshot().cloudHandoff.phase, 'committing');
  f.intercept(null);
  assert.equal((await restarted.synchronization.tick()).ok, true);
  assert.deepEqual((await restarted.history()).chats.map(item => item.id), [id]);
  assert.equal(view.snapshot().cloudHandoff.phase, 'committed');
  assert.equal(view.snapshot().cloudHandoff.taskId, row.receipt.taskId);
  assert.equal(f.calls.filter(call => call.route.startsWith('/cloud-conversations/')).length, 1);
  const entries = await fs.readdir(path.join(f.root, 'conversation-handoffs'));
  assert.equal(entries.filter(name => /^[a-f0-9]{64}\.json$/.test(name)).length, 1);
  assert.equal(entries.filter(name => name.endsWith('.view.json')).length, 1);
});

test('an empty local taskId cannot claim a cloud row with a different request or an unbound frozen start', async t => {
  for (const mismatch of ['transferId', 'frozenStart']) await t.test(mismatch, async child => {
    const f = await fixture(child), original = f.controller(), row = f.rows[0];
    const input = { requestId: row.receipt.transferId, agentId: 'pi', text: 'Keep the pending request bound' };
    f.intercept(async (_actor, route) => { if (route.startsWith('/cloud-conversations/')) throw Error('reply lost'); });
    await assert.rejects(original.start(input), /reply lost/);
    const id = 'cloud-' + input.requestId;
    const file = path.join(f.root, 'conversation-handoffs', crypto.createHash('sha256').update(id).digest('hex') + '.json');
    if (mismatch === 'transferId') row.receipt.transferId = crypto.randomUUID();
    else {
      const record = JSON.parse(await fs.readFile(file, 'utf8'));
      record.cloudStart.options.sessionId = 'cloud-' + crypto.randomUUID();
      await fs.writeFile(file, JSON.stringify(record));
    }
    f.intercept(null);
    assert.equal((await f.controller().synchronization.tick()).ok, true);
    const pending = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(pending.phase, 'committing'); assert.equal(pending.taskId, undefined);
  });
});

test('directory scans paginate beyond 100, revisit late commits and never infer deletion from omission', async t => {
  const f = await fixture(t, Array.from({ length: 105 }, (_, index) => remote(index + 2))), cloud = f.controller();
  let result;
  do { result = await cloud.synchronization.tick(); assert.equal(result.ok, true); } while (result.hasMore);
  assert.equal((await cloud.history()).chats.length, 105);
  f.rows.unshift(remote(1));
  await cloud.synchronization.tick();
  assert.equal((await cloud.history()).chats.length, 106);
  f.rows.splice(0);
  await cloud.synchronization.tick();
  assert.equal((await cloud.history()).chats.length, 106);
});

test('late directory replies after account or Hub change cannot write or publish the previous account', async t => {
  const f = await fixture(t), cloud = f.controller();
  let entered, release;
  const ready = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  f.intercept(async (_actor, route) => { if (route.startsWith('/cloud-execution-sync?')) { entered(); await gate; } });
  let changes = 0; cloud.onSynchronized(() => changes++);
  const syncing = cloud.synchronization.tick(); await ready;
  f.actor(identity('bob', 'one')); release();
  assert.equal((await syncing).ok, false);
  assert.equal((await cloud.history()).chats.length, 0); assert.equal(changes, 0);
});

test('a failed local checkpoint retries the same events after restart without losing or duplicating output', async t => {
  const f = await fixture(t), cloud = f.controller();
  const original = durable.writeFile; let rejected = false;
  t.mock.method(durable, 'writeFile', async (file, bytes, options) => {
    const value = JSON.parse(bytes);
    if (!rejected && value.syncState?.cursor === 2) { rejected = true; throw Error('injected checkpoint failure'); }
    return original(file, bytes, options);
  });
  assert.equal((await cloud.synchronization.tick()).ok, false);
  const restarted = f.controller(); assert.equal((await restarted.synchronization.tick()).ok, true);
  const view = await restarted.reopen((await restarted.history()).chats[0].id, 'recovered'); f.views.push(view);
  assert.equal(view.snapshot().messages.filter(item => item.role === 'assistant').length, 1);
  assert.equal(f.calls.filter(item => /since=0/.test(item.route)).length, 2);
});

test('a server cursor above the contiguous persisted boundary is rejected', async t => {
  const f = await fixture(t), cloud = f.controller();
  f.intercept(async (_actor, route) => {
    if (route.startsWith('/cloud-execution-sync/')) return { conversation: f.rows[0],
      page: { ref: 'ref-1', last: 9, persistedThrough: 2, items: [], hasMore: false }, attachments: [], approvals: [] };
  });
  assert.equal((await cloud.synchronization.tick()).ok, false);
});

test('a history gap preserves cached output and cursor, remains actionable, and clears only when the missing history arrives', async t => {
  const f = await fixture(t), cloud = f.controller();
  await cloud.synchronization.tick();
  const id = (await cloud.history()).chats[0].id, gap = { expectedSeq: 3, nextAvailableSeq: 4, observedThrough: 4 };
  const readRecord = async () => JSON.parse(await fs.readFile(path.join(f.root, 'conversation-handoffs',
    crypto.createHash('sha256').update(id).digest('hex') + '.json'), 'utf8'));
  let missing = true;
  f.intercept(async (_actor, route) => {
    if (!route.startsWith('/cloud-execution-sync/')) return;
    const since = Number(new URL(route, 'https://fixture.invalid').searchParams.get('since'));
    return { conversation: f.rows[0], page: { ref: 'ref-1', status: 'done',
      last: missing ? 2 : 4, persistedThrough: missing ? 2 : 4, hasMore: false,
      historyGap: missing ? gap : null,
      items: missing ? [] : [{ seq: 3, kind: 'user', text: 'Continue' },
        { seq: 4, kind: 'say', text: 'Recovered history' }].filter(item => item.seq > since) },
      attachments: [], approvals: [] };
  });
  assert.equal((await cloud.synchronization.tick()).ok, false);
  assert.equal((await readRecord()).syncState.cursor, 2);
  const row = (await cloud.history()).chats[0];
  assert.equal(row.needsAttention, true); assert.equal(row.state, 'waiting'); assert.deepEqual(row.historyGap, gap);
  assert.equal(cloud.synchronization.status().error, require('../main/conversation/cloud-execution-sync').HISTORY_GAP_MESSAGE);
  const view = await cloud.reopen(id, 'gap'); f.views.push(view);
  assert.equal(view.snapshot().messages.filter(item => item.role === 'assistant').length, 1);
  assert.deepEqual(view.snapshot().cloudHandoff.historyGap, gap);
  assert.equal(view.snapshot().deliveryPending, true);
  view.close();
  missing = false;
  const restarted = f.controller();
  assert.equal((await restarted.synchronization.tick()).ok, true);
  assert.equal((await readRecord()).syncState.cursor, 4);
  assert.equal((await restarted.history()).chats[0].needsAttention, false);
  const recovered = await restarted.reopen(id, 'filled'); f.views.push(recovered);
  assert.equal(recovered.snapshot().messages.filter(item => item.role === 'assistant').length, 2);
  assert.equal(recovered.snapshot().cloudHandoff.historyGap, null);
});

test('closed-view reconciliation downloads authorized result bytes without opening the conversation', async t => {
  const http = require('node:http'), bytes = Buffer.from('Report completed while the desktop was closed');
  let downloads = 0;
  const server = http.createServer((request, response) => {
    assert.equal(request.url, '/api/v1/attachments/result?ticket=fixture');
    assert.match(request.headers.authorization, /^Device /); downloads++; response.end(bytes);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const f = await fixture(t), cloud = f.controller();
  f.actor(identity('alice', 'one', 'http://127.0.0.1:' + server.address().port));
  f.intercept(async (_actor, route) => {
    if (route.startsWith('/cloud-execution-sync/')) return { conversation: f.rows[0],
      page: { ref: 'ref-1', status: 'done', last: 0, persistedThrough: 0, items: [], hasMore: false },
      approvals: [], attachments: [{ id: 'result', taskId: 'task-1', filename: 'report.txt', role: 'output',
        size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        url: '/attachments/result?ticket=fixture' }] };
  });
  assert.equal((await cloud.synchronization.tick()).ok, true);
  const row = (await cloud.history()).chats[0];
  const receipt = JSON.parse(await fs.readFile(path.join(f.root, 'conversation-handoffs',
    crypto.createHash('sha256').update(row.id).digest('hex') + '.json'), 'utf8'));
  const files = require('../main/conversation/cloud-output-cache').index(f.app, receipt).files;
  assert.equal(files.length, 1); assert.deepEqual(await fs.readFile(files[0].path), bytes);
  assert.equal(f.views.length, 0); assert.equal(downloads, 1);
  await cloud.synchronization.tick(); assert.equal(downloads, 1);
});

test('an open accepted view receives persisted progress when result download fails and recovers without reopening', async t => {
  const http = require('node:http'), bytes = Buffer.from('Delayed cloud result');
  let unavailable = true, downloads = 0;
  const server = http.createServer((_request, response) => {
    downloads++;
    if (unavailable) { response.statusCode = 403; response.end('retry'); }
    else response.end(bytes);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const f = await fixture(t), original = f.controller(), row = f.rows[0];
  f.actor(identity('alice', 'one', 'http://127.0.0.1:' + server.address().port));
  f.intercept(async (_actor, route) => { if (route.startsWith('/cloud-conversations/')) throw Error('accepted reply lost'); });
  await assert.rejects(original.start({ requestId: row.receipt.transferId, agentId: 'pi', text: 'Continue while closed' }), /reply lost/);
  const id = row.receipt.source.sessionId, cloud = f.controller();
  const view = await cloud.reopen(id, 'download-pending'); f.views.push(view);
  let timer, unsubscribe;
  const progress = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(Error('the original view did not receive cloud progress')), 5000);
    unsubscribe = view.on((_event, snapshot) => {
      if (snapshot.messages.some(item => item.role === 'assistant')) { clearTimeout(timer); unsubscribe(); resolve(); }
    });
  });
  t.after(() => { clearTimeout(timer); unsubscribe(); });
  f.intercept(async (_actor, route) => {
    if (!route.startsWith('/cloud-execution-sync/')) return;
    const since = Number(new URL(route, 'https://fixture.invalid').searchParams.get('since'));
    return { conversation: row, page: { ref: 'ref-1', status: 'done', last: 2, persistedThrough: 2,
      items: [{ seq: 1, kind: 'user', text: 'Continue while closed' },
        { seq: 2, kind: 'say', text: 'Remote progress retained' }].filter(item => item.seq > since), hasMore: false },
      approvals: [], attachments: [{ id: 'result', taskId: 'task-1', filename: 'result.txt', role: 'output',
        size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        url: '/attachments/result?ticket=fixture' }] };
  });
  assert.equal((await cloud.synchronization.tick()).ok, false);
  await progress;
  const savedFile = path.join(f.root, 'conversation-handoffs', crypto.createHash('sha256').update(id).digest('hex') + '.json');
  const record = JSON.parse(await fs.readFile(savedFile, 'utf8'));
  assert.equal(record.syncState.cursor, 2); assert.equal(record.syncArtifactsPending, true);
  assert.match(record.syncArtifactError, /下载失败/);
  assert.equal(view.snapshot().cloudHandoff.phase, 'committed');
  assert.match(view.snapshot().cloudHandoff.outputError, /下载失败/);
  assert.equal(view.snapshot().deliveryPending, true);
  assert.equal((await cloud.history()).chats[0].needsAttention, true);
  assert.equal((await f.controller().history()).chats[0].outputPending, true);
  unavailable = false;
  assert.equal((await cloud.synchronization.tick()).ok, true);
  assert.equal((await cloud.history()).chats[0].needsAttention, false);
  assert.equal(view.snapshot().cloudHandoff.outputPending, false);
  assert.equal(view.snapshot().cloudHandoff.outputError, '');
  assert.equal(view.outputSnapshot().files.length, 1);
  assert.equal(view.snapshot().messages.filter(item => item.role === 'assistant').length, 1);
  assert.ok(downloads >= 2);
  assert.equal(f.calls.filter(call => call.route.startsWith('/cloud-conversations/')).length, 1);
});

test('large execution streams use bounded pages and resume from the last applied cursor on the next scan', async t => {
  const f = await fixture(t), cloud = f.controller(), cursors = [];
  f.intercept(async (_actor, route) => {
    if (!route.startsWith('/cloud-execution-sync/')) return;
    const since = Number(new URL(route, 'https://fixture.invalid').searchParams.get('since'));
    cursors.push(since); const last = Math.min(2001, since + 400);
    return { conversation: f.rows[0], page: { ref: 'ref-1', status: 'done', last, persistedThrough: 2001,
      hasMore: last < 2001, items: [{ seq: last, kind: 'say', text: 'Visible event ' + last }] }, attachments: [], approvals: [] };
  });
  assert.equal((await cloud.synchronization.tick()).ok, true);
  assert.deepEqual(cursors, [0, 400, 800, 1200]);
  const restarted = f.controller();
  assert.equal((await restarted.synchronization.tick()).ok, true);
  assert.deepEqual(cursors, [0, 400, 800, 1200, 1600, 2000]);
  const view = await restarted.reopen((await restarted.history()).chats[0].id, 'paged'); f.views.push(view);
  assert.equal(view.snapshot().messages.filter(row => row.role === 'assistant').length, 6);
});

test('a late execution page after Hub switch cannot publish its progress or checkpoint into the new scope', async t => {
  const f = await fixture(t), cloud = f.controller();
  let entered, release;
  const ready = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  f.intercept(async (_actor, route) => { if (route.startsWith('/cloud-execution-sync/')) { entered(); await gate; } });
  let published = 0; cloud.onSynchronized(() => published++);
  const pending = cloud.synchronization.tick(); await ready;
  f.actor(identity('alice', 'one', 'https://other.invalid')); release();
  assert.equal((await pending).ok, false); assert.equal(published, 0);
  assert.deepEqual((await cloud.history()).chats, []);
  f.actor(identity()); f.intercept(null);
  assert.equal((await cloud.synchronization.tick()).ok, true);
  assert.equal(f.calls.filter(call => /since=0/.test(call.route)).length, 2);
});

test('an already-open accepted pending view follows the cloud commit without creating a local runtime', async t => {
  const f = await fixture(t), cloud = f.controller();
  f.rows[0].receipt.phase = 'prepared'; f.rows[0].receipt.accepted = true; f.rows[0].receipt.ref = ''; f.rows[0].execution = null;
  f.intercept(async (_actor, route) => {
    if (route.startsWith('/cloud-execution-sync/')) return { conversation: f.rows[0], page: null, approvals: [], attachments: [] };
  });
  await cloud.synchronization.tick();
  const view = await cloud.reopen((await cloud.history()).chats[0].id, 'pending'); f.views.push(view);
  assert.equal(view.snapshot().cloudHandoff.phase, 'prepared');
  assert.equal(view.snapshot().cloudHandoff.canAbort, false);
  f.rows[0].receipt.phase = 'committed'; f.rows[0].receipt.ref = 'ref-1'; f.rows[0].execution = { ref: 'ref-1', status: 'done' };
  f.intercept(null);
  assert.equal((await cloud.synchronization.tick()).ok, true);
  assert.equal(view.snapshot().cloudHandoff.phase, 'committed');
  assert.equal(view.passiveCloudView, true);
});
