'use strict';

// Exercise production task admission, controlled execution and queue hooks in
// fresh client processes. Only Hub/Runner transport and the model are fixtures.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { fork } = require('node:child_process');

async function client(config) {
  const now = Math.floor(Date.now() / 1000), messages = [];
  const identity = { hub: config.hub, clientId: 'executor', session:
    Buffer.from(JSON.stringify({ typ: 'device', uid: 'owner', cid: 'executor', iat: now, exp: now + 3600 }))
      .toString('base64url') + '.' + 'a'.repeat(64) };
  const handle = { sessionId: 'original-chat', adapterId: 'pi', cwd: config.local,
    taskIds: ['task'], appendTaskMessage: (role, text) => messages.push({ role, text }), taskExecutionChanged() {} };
  const input = await require('../main/pi-session/task-input').prepare(identity, 'task', handle.sessionId,
    config.turnId, 'Apply the review feedback.', { reuseConversation: true, reworkSession: true, followUp: true },
    { handle, app: { getPath: () => config.profile }, identityOf: async () => identity });
  assert.equal(input.executor, 'dispatch');
  const queue = require('../main/pi-session/turn-queue').createTurnQueue();
  const queued = queue.add({ text: input.text, attachments: [], options: { ...input, taskId: 'task' } });
  const result = await queue.run(queue.take(), () => input.controlled.execute(handle, input.text, []));
  assert.equal(result.ok, true, result.reason);
  assert.equal((await queued.completion).ok, true);
  assert.deepEqual(fs.readdirSync(config.local), [], 'native cwd must not become a second delivery source');
  assert.equal(messages.filter(row => row.role === 'assistant').length, 1);
  assert.equal(messages.at(-1).text, config.turnId + ' revised result');
  process.send({ ok: true, messages });
}

async function main() {
  const root = path.resolve(process.argv[2] || 'outputs/requirement-runner-rework');
  fs.mkdirSync(root, { recursive: true });
  const run = fs.mkdtempSync(path.join(root, 'run-'));
  const local = path.join(run, 'native'), original = path.join(run, 'runner'), profile = path.join(run, 'profile');
  for (const directory of [local, original, profile]) fs.mkdirSync(directory);
  fs.writeFileSync(path.join(original, 'result.md'), 'Original rejected output');
  const task = { id: 'task', title: 'Revision fixture', status: 'doing', ownerClientId: 'executor',
    workRouting: { executionSubmissionMode: 'auto',
      executionContext: { agent: { id: 'runner:device:pi' }, runner: { mode: 'local' } },
      conversationTurn: { conversationId: 'original-chat', turnId: 'first', executor: 'dispatch', state: 'completed' },
      reworkPending: { state: 'awaiting_executor', feedback: 'Shorten to 100 characters' } } };
  const calls = [], reviews = [], errors = [], children = [];
  let key = 'dispatch:first', latest = 'first', count = 1, reads = 0;
  const events = [{ seq: 1, kind: 'say', text: 'Original rejected output', admissionKey: key }];
  const server = http.createServer(async (request, response) => {
    const json = (status, body) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)); };
    try {
      let raw = ''; for await (const chunk of request) raw += chunk;
      const url = new URL(request.url, 'http://localhost'), body = raw ? JSON.parse(raw) : null;
      assert.ok(request.headers.authorization.startsWith('Device '));
      calls.push({ route: url.pathname, body });
      if (url.pathname === '/api/v1/tasks/task') return json(200, task);
      if (url.pathname.endsWith('/conversation-turn')) {
        const prior = task.workRouting.conversationTurn;
        assert.equal(body.continuationRef, 'original-run');
        assert.equal(body.conversationId, 'original-chat');
        assert.equal(body.executor, 'dispatch');
        if (body.action === 'prepare') task.workRouting.conversationTurn = { ...body, state: 'queued' };
        else { assert.equal(body.turnId, prior.turnId); prior.state = { start: 'running', complete: 'completed', fail: 'failed' }[body.action]; }
        return json(200, { task, turn: task.workRouting.conversationTurn });
      }
      if (url.pathname.endsWith('/ai-say')) {
        assert.equal(body.expectedRef, 'original-run');
        assert.equal(task.workRouting.conversationTurn.state, 'running');
        assert.equal(body.conversationTurn.turnId, task.workRouting.conversationTurn.turnId);
        assert.match(body.text, /Shorten/);
        latest = body.conversationTurn.turnId; key = 'comment:' + body.messageId; count++; reads = 0;
        fs.writeFileSync(path.join(original, 'result.md'), latest + ' revised result');
        events.push({ seq: events.length + 1, kind: 'say', text: latest + ' revised result', admissionKey: key });
        events.push({ seq: events.length + 1, kind: 'turn-end', turnState: 'done', admissionKey: key });
        delete task.workRouting.reworkPending;
        return json(200, { ok: true, delivery: 'accepted', admissionKey: key });
      }
      if (url.pathname.endsWith('/ai-session')) {
        // The first poll after a send still sees the prior cached completion.
        const stale = ++reads === 1 && latest !== 'first' && Number(url.searchParams.get('since')) !== 1000000000;
        const rows = stale ? events.slice(0, -2) : events;
        return json(200, { ok: true, ref: 'original-run', canSend: true, status: 'done',
          admissionKey: stale ? rows.at(-1).admissionKey : key, seq: rows.length, last: rows.length,
          items: rows.filter(row => row.seq > Number(url.searchParams.get('since'))) });
      }
      if (url.pathname.endsWith('/ai-status')) {
        assert.equal(url.searchParams.get('ref'), 'original-run');
        reviews.push({ round: count, bytes: fs.readFileSync(path.join(original, 'result.md'), 'utf8') });
        return json(200, { done: true });
      }
      throw Error('Unexpected route: ' + url.pathname);
    } catch (error) { errors.push(String(error.stack)); json(500, { detail: error.message }); }
  });
  const report = { ok: false, boundary: 'Isolated production client processes with loopback Hub/Runner protocol fixtures; no business data or model calls.', run };
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    for (const turnId of ['second', 'third']) {
      task.workRouting.reworkPending = { state: 'awaiting_executor', feedback: 'Shorten to 100 characters' };
      if (turnId === 'third') task.workRouting.conversationTurn.executor = 'native';
      const config = { hub: 'http://127.0.0.1:' + server.address().port, local, original, profile, turnId };
      const child = fork(__filename, ['--client'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env: { ...process.env, SODUWORK_REWORK_FIXTURE: JSON.stringify(config) } });
      children.push(child);
      let logs = '', message;
      child.stdout.on('data', data => { logs += data; }); child.stderr.on('data', data => { logs += data; });
      child.on('message', value => { message = value; });
      const timer = setTimeout(() => child.kill(), 20000);
      const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
      clearTimeout(timer);
      assert.equal(code, 0, logs); assert.equal(message?.ok, true, logs);
      assert.equal(task.workRouting.conversationTurn.state, 'completed');
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(reviews, [{ round: 2, bytes: 'second revised result' }, { round: 3, bytes: 'third revised result' }]);
    assert.equal(calls.filter(row => row.route.endsWith('/ai-say')).length, 2);
    assert.equal(calls.filter(row => row.route.endsWith('/ai-dispatch')).length, 0);
    report.ok = true; report.reviews = reviews; report.calls = calls.length;
  } catch (error) { report.error = String(error.stack); }
  finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill();
    await new Promise(resolve => server.close(resolve));
    fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2)); process.exitCode = report.ok ? 0 : 1;
  }
}

(process.argv[2] === '--client' ? client(JSON.parse(process.env.SODUWORK_REWORK_FIXTURE)) : main())
  .catch(error => { console.error(error); process.exitCode = 1; });
