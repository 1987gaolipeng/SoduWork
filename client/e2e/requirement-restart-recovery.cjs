'use strict';

// Production requirement admission, Runner handles, queue hooks and durable
// bindings run in isolated clients. Hub and Runner are loopback protocol
// fixtures; no installed client, account, paid model or business process opens.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(check, label, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await delay(20);
  }
  throw Error('Timed out: ' + label);
}

function identity(hub, uid = 'restart-fixture-account') {
  const clientId = 'restart-fixture-device';
  const now = Math.floor(Date.now() / 1000);
  return { hub, clientId, session: Buffer.from(JSON.stringify({ typ: 'device',
    uid, cid: clientId, iat: now - 10, exp: now + 3600 })).toString('base64url') + '.' + 'a'.repeat(64) };
}

async function clientMain() {
  const config = JSON.parse(process.env.SODUWORK_RESTART_FIXTURE);
  const app = { getPath: () => config.profile };
  const { createRunnerRuntimeAdapter, getRunnerSessionDetails } = require('../main/agent-runtime/runner-adapter');
  const taskInput = require('../main/pi-session/task-input');
  let current = identity(config.hub);
  const adapter = createRunnerRuntimeAdapter({ app,
    runtimeSpec: require('../main/agent-runtime/runtime-catalog').runtime('qwen'),
    runnerRuntime: { async rpc(op, payload) {
      const response = await fetch(config.hub + '/fixture/runner', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op, payload }) });
      return response.json();
    } },
    modelConfig: { fetchModel: async () => ({ ok: true, model: {
      id: 'fixture-model', baseUrl: config.hub + '/unused-model', key: 'loopback-only-model-ticket' } }) },
  });
  const request = { identity: current, native: { runner: { openOptions: {
    app, ref: config.alias, cwd: config.workspace, identity: current,
    modelName: 'fixture-model', ...(config.resume ? { resumePath: config.resume } : {}),
  } } } };
  const session = await adapter[config.resume ? 'resumeSession' : 'createSession'](request);
  const handle = getRunnerSessionDetails(session).handle;
  if (config.resume) await until(() => session.snapshot().messages.length > 0,
    'restored Runner transcript');
  const runtime = { app, handle, identityOf: async () => current };
  process.on('message', async message => {
    const reply = value => process.send?.({ id: message.id, ...value });
    try {
      if (message.op === 'inspect') return reply({ ok: true, sessionId: handle.sessionId,
        taskIds: handle.taskIds, snapshot: session.snapshot(), pid: process.pid });
      if (message.op === 'account') { current = identity(config.hub, message.uid); return reply({ ok: true }); }
      if (message.op === 'close') { await session.dispose(); reply({ ok: true }); process.exit(0); }
      if (message.op !== 'send') throw Error('Unknown fixture client operation');
      const options = message.options || {};
      if (message.bind) assert.equal(handle.bindTask(config.taskId, 'Restart recovery fixture').ok, true);
      const input = await taskInput.prepare(current, config.taskId, handle.sessionId,
        message.turnId, message.text, options, runtime);
      const queued = session.send({ text: input.text, attachments: input.attachments,
        options: { taskId: config.taskId, taskTitle: input.task.title,
          executor: input.executor, beforeTurn: input.beforeTurn, onStarted: input.onStarted,
          afterTurn: input.afterTurn, beforeRetry: input.beforeRetry } });
      assert.equal(queued.accepted, true);
      const result = await queued.completion;
      reply({ ok: true, result, snapshot: session.snapshot() });
    } catch (error) { reply({ ok: false, error: String(error.stack || error), code: error.code || '' }); }
  });
  process.send?.({ ready: true, pid: process.pid, sessionId: handle.sessionId,
    taskIds: handle.taskIds, snapshot: session.snapshot() });
}

async function driverMain() {
  const output = path.resolve(process.argv[2] || path.join(__dirname, '../../outputs/requirement-restart-recovery'));
  fs.mkdirSync(output, { recursive: true });
  const root = fs.mkdtempSync(path.join(output, 'run-'));
  const report = { ok: false, root, cases: [], processes: [],
    boundary: 'Fresh isolated Node client processes run production Qwen Runner adapter, task-input, queue and disk bindings. Loopback Hub/Runner protocol fixtures persist receipts/history on disk. No real backend, installed client, business data or paid model.' };
  const clients = new Set(), serverErrors = [];
  let server;
  try {
    let active;
    const save = () => fs.writeFileSync(active.file, JSON.stringify(active.state, null, 2));
    function event(kind, text) {
      const run = active.state.run;
      run.items.push({ seq: run.items.length + 1, kind, text, at: new Date().toISOString() });
    }
    function json(response, status, value) {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(value));
    }
    server = http.createServer((request, response) => {
      let raw = '';
      request.on('data', chunk => { raw += chunk; });
      request.on('end', () => {
        try {
          const url = new URL(request.url, 'http://127.0.0.1');
          const state = active.state, task = state.task;
          if (url.pathname === '/fixture/runner') {
            const { op, payload } = JSON.parse(raw);
            state.calls.push({ op, payload });
            if (op === 'runtime.detect') {
              save(); return json(response, 200, { ok: true, data: { installed: true, state: 'ready' } });
            }
            if (op === 'job.stop') {
              state.run.status = 'stopped'; save(); return json(response, 200, { ok: true, data: { ok: true } });
            }
            if (op === 'job.dispatch' || op === 'job.comment') {
              const dispatch = op === 'job.dispatch';
              const ref = dispatch ? active.predictedRef : payload.ref;
              assert.equal(ref, active.predictedRef);
              if (dispatch) assert.equal(state.run.items.length, 0, 'recovery must not create another Runner job');
              state.run.ref = ref;
              state.run.status = active.completeNewTurns ? 'done' : 'running';
              state.run.started = Date.now() / 1000;
              state.run.ended = active.completeNewTurns ? Date.now() / 1000 : 0;
              state.run.round++;
              event('user', dispatch ? payload.ctx.conversationUserText : payload.text);
              event('say', active.completeNewTurns ? 'Fixture result completed.' : 'Partial result before unexpected restart.');
              state.executions++;
              save(); return json(response, 200, { ok: true, data: { ok: true, ref } });
            }
            if (op === 'job.session') {
              assert.equal(payload.ref, active.predictedRef);
              save(); return json(response, 200, { ok: true, data: {
                ok: true, ...state.run, seq: state.run.items.length,
                executionStartedAt: state.run.started * 1000,
                items: state.run.items.filter(row => row.seq > payload.since),
              } });
            }
            throw Error('Unexpected fixture Runner method: ' + op);
          }
          assert.ok(request.headers.authorization?.startsWith('Device '));
          const token = request.headers.authorization.slice('Device '.length);
          const claims = JSON.parse(Buffer.from(token.split('.')[0], 'base64url'));
          assert.equal(claims.cid, identity(active.hub).clientId);
          assert.equal(claims.uid, 'restart-fixture-account');
          if (url.pathname === '/api/v1/tasks/' + task.id && request.method === 'GET')
            return json(response, 200, task);
          if (url.pathname === '/api/v1/tasks/' + task.id + '/attachments') return json(response, 200, []);
          if (url.pathname === '/api/v1/tasks/' + task.id + '/conversation-turn') {
            const body = JSON.parse(raw), prior = task.workRouting.conversationTurn;
            state.receipts.push(body);
            if (body.action === 'prepare') {
              if (prior && ['queued', 'running', 'waiting'].includes(prior.state)) {
                save(); return json(response, 409, { detail: '这项需求已在会话中执行或排队，请勿重复安排执行' });
              }
              task.workRouting.conversationTurn = { ...body, state: 'queued' };
            } else {
              assert.equal(body.conversationId, prior.conversationId);
              assert.equal(body.turnId, prior.turnId, 'continuation must retain the interrupted authoritative receipt');
              prior.state = { start: 'running', complete: 'completed', fail: 'failed', wait: 'waiting', cancel: 'cancelled' }[body.action];
              assert.ok(prior.state, 'unknown receipt transition');
              if (body.action === 'start') task.status = 'doing';
            }
            save(); return json(response, 200, { task, turn: task.workRouting.conversationTurn });
          }
          throw Error('Unexpected fixture Hub route: ' + request.method + ' ' + url.pathname);
        } catch (error) {
          serverErrors.push(String(error.stack || error));
          json(response, 500, { detail: String(error.message || error) });
        }
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const hub = 'http://127.0.0.1:' + server.address().port;

    async function spawnClient(config) {
      const env = { ...process.env, SODUWORK_RESTART_FIXTURE: JSON.stringify(config) };
      for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']) delete env[key];
      const child = fork(__filename, ['--client'], { env, windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      clients.add(child);
      const pending = new Map(); let nextId = 0, ready;
      const logs = [];
      child.stdout.on('data', chunk => logs.push(String(chunk)));
      child.stderr.on('data', chunk => logs.push(String(chunk)));
      const opened = new Promise((resolve, reject) => {
        ready = resolve;
        child.once('error', reject);
        child.once('exit', (code, signal) => {
          clients.delete(child);
          const error = Error('Fixture client exited: ' + code + '/' + signal + '\n' + logs.join(''));
          reject(error);
          for (const value of pending.values()) value.reject(error);
          pending.clear();
        });
      });
      child.on('message', value => {
        if (value.ready) return ready(value);
        const request = pending.get(value.id);
        if (request) { pending.delete(value.id); request.resolve(value); }
      });
      let timer;
      const meta = await Promise.race([opened, new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('Client open timed out')), 20000);
      })]).finally(() => clearTimeout(timer));
      report.processes.push({ pid: child.pid, sessionId: meta.sessionId, restored: Boolean(config.resume) });
      return { child, meta, command(op, value = {}) {
        const id = ++nextId;
        let timer;
        return new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(Error('Fixture command timed out: ' + op)), 20000);
          pending.set(id, { resolve, reject });
          child.send({ id, op, ...value });
        }).finally(() => { clearTimeout(timer); pending.delete(id); });
      }, logs };
    }

    for (const rework of [false, true]) {
      const name = rework ? 'rework' : 'original';
      const directory = path.join(root, name), profile = path.join(directory, 'profile'), workspace = path.join(directory, 'workspace');
      fs.mkdirSync(profile, { recursive: true }); fs.mkdirSync(workspace);
      const alias = 'chat-restart-' + name, taskId = 'requirement-' + name;
      const ref = require('../main/agent-runtime/runner-adapter')._uuidV5(
        '9af442c8-cd1d-4b91-a668-22da2b2635bf', 'chat:' + alias + ':qwen');
      active = { hub, predictedRef: ref, completeNewTurns: rework, file: path.join(directory, 'hub-runner-state.json'),
        state: { task: { id: taskId, title: 'Unexpected restart fixture', note: 'Keep the existing result.',
          status: 'todo', ownerClientId: identity(hub).clientId, workRouting: {
            selectedStrategy: 'direct', executionContext: { agent: { id: 'local:qwen' }, model: 'fixture-model', runner: { mode: 'local' } },
          } }, run: { ref, status: 'done', items: [], round: 0 }, calls: [], receipts: [], executions: 0 } };
      save();
      const config = { hub, profile, workspace, alias, taskId };
      const recoveryOptions = rework
        ? { reuseConversation: true, reworkSession: true, followUp: false }
        : { reuseConversation: true, followUp: true };
      const first = await spawnClient(config);
      assert.equal(first.meta.sessionId, ref);
      if (rework) {
        const baseline = await first.command('send', { bind: true, text: 'Create the original result.', turnId: 'original-round' });
        assert.equal(baseline.ok, true, baseline.error);
        assert.equal(baseline.result.ok, true, baseline.result.reason);
        assert.equal(active.state.task.workRouting.conversationTurn.state, 'completed');
        active.state.task.workRouting.reworkPending = { feedback: 'Produce a playable result, not a plan.', actor: 'Fixture reviewer' };
        active.completeNewTurns = false; save();
      }
      const interruptedTurn = rework ? 'rework-round' : 'original-round';
      const pending = first.command('send', { bind: !rework, text: rework ? 'Apply the review correction.' : 'Execute the requirement.',
        turnId: interruptedTurn, options: rework ? recoveryOptions : {} });
      const pendingOutcome = pending.then(value => ({ value }), error => ({ error: error.message }));
      await until(() => active.state.run.status === 'running' &&
        active.state.task.workRouting.conversationTurn?.state === 'running', name + ' is executing');
      const before = await first.command('inspect');
      assert.deepEqual(before.taskIds, [taskId]);
      assert.ok(fs.readdirSync(path.join(profile, 'conversation-tasks')).some(file => file.endsWith('.json')));
      const executionsBefore = active.state.executions;
      const stopped = new Promise(resolve => first.child.once('exit', resolve));
      // Kill only the exact child this fixture spawned, without disposal hooks.
      assert.equal(first.child.kill('SIGKILL'), true);
      await stopped;
      assert.ok((await pendingOutcome).error, 'unexpected process death must interrupt its pending caller');
      active.state = JSON.parse(fs.readFileSync(active.file, 'utf8'));
      assert.equal(active.state.task.workRouting.conversationTurn.state, 'running');
      assert.equal(active.state.calls.filter(call => call.op === 'job.stop').length, 0);
      report.cases.push(name + ': unexpected client process death preserves the bound task, original receipt and partial transcript without a stop/completion receipt');

      // Runner may survive a client crash. Never treat a fresh UI as permission
      // to replay its still-active execution or queue a duplicate task.
      const restored = await spawnClient({ ...config, resume: ref });
      assert.notEqual(restored.meta.pid, first.meta.pid);
      assert.equal(restored.meta.sessionId, ref);
      assert.deepEqual(restored.meta.taskIds, [taskId]);
      assert.equal(active.state.executions, executionsBefore);
      const activeDenied = await restored.command('send', { text: 'Continue while Runner is active.', turnId: 'must-not-prepare',
        options: recoveryOptions });
      assert.equal(activeDenied.ok, false, 'still-running execution must not be reclaimed');
      assert.match(activeDenied.error, /执行或排队/);
      assert.equal(active.state.executions, executionsBefore);
      report.cases.push(name + ': fresh client restores disk task bindings and existing Runner history, never auto replays, and refuses duplicate continuation while Runner remains active');

      active.state.run.status = 'interrupted'; active.state.run.ended = Date.now() / 1000; save();
      await until(async () => !(await restored.command('inspect')).snapshot.running,
        name + ' observes interrupted Runner terminal');
      const prepareCount = active.state.receipts.filter(row => row.action === 'prepare').length;
      const dispatchCount = active.state.calls.filter(row => row.op === 'job.dispatch').length;
      const commentCount = active.state.calls.filter(row => row.op === 'job.comment').length;
      active.completeNewTurns = true;
      const continued = await restored.command('send', { text: 'Continue from the existing result.', turnId: 'new-ui-submission',
        options: recoveryOptions });
      assert.equal(continued.ok, true, continued.error);
      assert.equal(continued.result.ok, true, continued.result.reason);
      assert.equal(active.state.executions, executionsBefore + 1);
      assert.equal(active.state.receipts.filter(row => row.action === 'prepare').length, prepareCount,
        'continuing the interrupted receipt must not prepare a duplicate');
      assert.equal(active.state.calls.filter(row => row.op === 'job.dispatch').length, dispatchCount);
      assert.equal(active.state.calls.filter(row => row.op === 'job.comment').length, commentCount + 1);
      const last = active.state.receipts.at(-1);
      assert.equal(last.action, 'complete'); assert.equal(last.turnId, interruptedTurn);
      assert.equal(last.conversationId, ref);
      const transcript = continued.snapshot.messages.filter(row => row.role === 'user').map(row => row.text);
      assert.equal(transcript.filter(text => text.startsWith('Continue from the existing result.')).length, 1);
      if (rework) {
        const latest = active.state.calls.filter(row => row.op === 'job.comment').at(-1).payload;
        assert.match(latest.promptText, /Produce a playable result, not a plan\./);
      }
      report.cases.push(name + ': explicit continuation after confirmed Runner interruption reuses the authoritative old turn, completes one Runner comment, preserves original/rework history and performs no new dispatch or prepare');
      await restored.command('close');
      await until(() => !clients.has(restored.child), 'fixture client shutdown');
    }
    assert.deepEqual(serverErrors, []);
    report.ok = true;
  } catch (error) { report.error = String(error.stack || error); }
  finally {
    for (const child of clients) child.kill('SIGKILL');
    await Promise.all([...clients].map(child => new Promise(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once('exit', resolve);
    })));
    if (server) await new Promise(resolve => server.close(resolve));
    report.serverErrors = serverErrors;
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.ok ? 0 : 1;
  }
}

if (process.argv.includes('--client')) clientMain().catch(error => {
  console.error(error.stack || error); process.exit(1);
});
else driverMain().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
