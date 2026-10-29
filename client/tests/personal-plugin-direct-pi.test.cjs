'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const direct = require('../main/personal-plugin-direct-pi.cjs');
const rules = require('../main/access-control/policy');
const broker = require('../main/access-control/broker');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(check) { for (let n = 0; n < 100; n++) { if (check()) return; await tick(); } assert.fail('checkpoint not reached'); }
function setup(t, options = {}) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-direct-pi-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const node = { key: 'plan', dispatchId: 'fixture:' + path.basename(dir), status: 'running', config: { timeoutSeconds: 30 } };
  const record = { pluginId: 'local:fixture', nodes: [node], status: 'running' };
  const saved = [], emitted = [], calls = [];
  let listener = () => {}, pending = null, closed = false, running = false, stopped = false;
  let snap = { accessControl: { supported: true, schema: rules.SCHEMA, modes: [...rules.MODES] }, messages: [], tools: [] };
  const child = {
    snapshot: () => ({ ...snap, accessPolicy: pendingPolicy, status: running ? 'streaming' : 'idle', pendingPermissions: pending?.pending() || [] }),
    on: cb => { listener = cb; return () => { listener = () => {}; }; },
    submit(prompt, files, selected) {
      calls.push({ prompt, files, selected }); running = true;
      const completion = Promise.resolve().then(async () => {
        if (options.waitPermission) {
          const operation = rules.operation(pendingPolicy, 'bash', { command: 'echo fixture' });
          const allowed = await pending.authorize(operation);
          if (!allowed) return { ok: false, cancelled: stopped, reason: 'operation denied' };
        }
        if (stopped) return { ok: true, cancelled: true };
        const target = path.join(dir, 'plan.md');
        assert.equal(rules.operation(pendingPolicy, 'write', { path: target }).verdict, 'allow');
        fs.writeFileSync(target, '# plan');
        snap = { ...snap, tools: [{ id: 'write', name: 'write', args: { path: 'plan.md' }, state: 'done', result: 'written' }],
          messages: [{ role: 'assistant', done: true, blocks: [{ kind: 'text', text: 'Plan ready private-ticket' }] }] };
        listener({}, child.snapshot());
        return { ok: true };
      }).finally(() => { running = false; });
      return { accepted: true, completion };
    },
    async setAccessPolicy(policy, revision) {
      calls.push({ access: policy, revision });
      if (options.rejectChange) return { ok: false, reason: 'private rejection' };
      assert.equal(revision, pendingPolicy.revision);
      assert.equal(policy.revision, pendingPolicy.revision + 1);
      pending.upgradeToFull(policy); pendingPolicy = policy;
      return { ok: true, effective: 'current-turn' };
    },
    answerUi: value => pending.answer(value),
    cancel() { stopped = true; pending?.cancel(); },
    inFlight: () => running,
    close() { closed = true; pending?.close(); },
  };
  let pendingPolicy;
  const session = { probe: async () => ({ ok: true, accessControl: snap.accessControl }),
    open: async opts => {
      calls.push({ open: opts });
      if (options.beforeOpen) await options.beforeOpen();
      pendingPolicy = opts.accessPolicy;
      pending = broker.create({ policy: pendingPolicy, onChange: () => listener({}, child.snapshot()) });
      return { ok: true, session: child };
    } };
  const executor = direct.create({ app: {}, session, timeoutMs: 20 });
  let cancelled = false, owner = 'alice';
  const args = { node, record, persist: () => saved.push(structuredClone(record)), dir, prompt: 'do current node',
    localFiles: [], accessPolicy: rules.create('standard', dir), identity: { user: 'alice' }, modelId: 'selected-pi',
    skillDirs: [], requested: [], grants: { grant: null },
    ensureActive: () => { if (cancelled) throw Error('cancelled'); },
    checkOwner: async () => { if (owner !== 'alice') throw Error('owner changed'); },
    output: { consume: (ref, rows) => emitted.push(...rows.map(row => ({ ref, ...row }))) },
    redact: value => String(value || '').replaceAll('private-ticket', '[redacted]') };
  return { executor, args, node, record, saved, emitted, calls, dir, child,
    isClosed: () => closed, cancel: () => { cancelled = true; }, changeOwner: () => { owner = 'bob'; } };
}
test('direct Pi preserves real permission policy and files, emits events, and never duplicates a settled attempt', async t => {
  const f = setup(t);
  const result = await f.executor.execute(f.args);
  assert.equal(result, 'Plan ready [redacted]');
  assert.equal(f.calls[0].open.ephemeral, true, 'internal node must not appear as an unrelated recent chat');
  assert.equal(f.calls[0].open.accessPolicy.workspaceRoot, f.dir);
  assert.equal(f.calls[0].open.modelName, 'selected-pi');
  assert.equal(f.calls[0].open.noExtensions, true);
  assert.equal(fs.readFileSync(path.join(f.dir, 'plan.md'), 'utf8'), '# plan');
  assert.deepEqual(f.emitted.map(row => row.kind), ['do', 'out', 'say']);
  assert.doesNotMatch(JSON.stringify(f.saved), /private-ticket/);
  assert.equal(f.isClosed(), true);
  await f.executor.execute(f.args);
  assert.equal(f.calls.filter(row => row.prompt).length, 1);
  const dispatched = f.saved.find(value => value.nodes[0].dispatched);
  assert.ok(dispatched.nodes[0].ref.startsWith('workflow-pi:'));
});
test('direct Pi forwards actual broker permission with bounded operation details and grants only once', async t => {
  const f = setup(t, { waitPermission: true });
  const done = f.executor.execute(f.args);
  await until(() => f.node.pendingPermissions?.length);
  const request = f.node.pendingPermissions[0];
  assert.match(request.detail, /echo fixture/);
  assert.equal(f.node.directFinished, false);
  await f.executor.answer(f.node, { requestId: request.requestId, policyRevision: request.policyRevision, decision: 'once' });
  await assert.rejects(f.executor.answer(f.node, { requestId: request.requestId, policyRevision: request.policyRevision, decision: 'once' }), /已失效/);
  assert.equal(await done, 'Plan ready [redacted]');
});
test('cancel during direct Pi opening waits for construction and prevents submit', async t => {
  let release, entered = false;
  const f = setup(t, { beforeOpen: () => { entered = true; return new Promise(resolve => { release = resolve; }); } });
  const done = f.executor.execute(f.args), rejected = assert.rejects(done, /cancelled|已停止/);
  await until(() => entered);
  f.cancel(); const stopping = f.executor.stop(f.node); release();
  await stopping; await rejected;
  assert.equal(f.calls.filter(row => row.prompt).length, 0);
  assert.equal(f.isClosed(), true);
});
test('ownership is rechecked after direct Pi initialization and before any prompt is sent', async t => {
  let release, entered = false;
  const f = setup(t, { beforeOpen: () => { entered = true; return new Promise(resolve => { release = resolve; }); } });
  const done = f.executor.execute(f.args), rejected = assert.rejects(done, /owner changed/);
  await until(() => entered); f.changeOwner(); release(); await rejected;
  assert.equal(f.calls.filter(row => row.prompt).length, 0);
});
test('cancel at a real Pi broker permission wait confirms stop before releasing the caller', async t => {
  const f = setup(t, { waitPermission: true });
  const done = f.executor.execute(f.args), rejected = assert.rejects(done, /cancelled|operation denied/);
  await until(() => f.node.pendingPermissions?.length);
  f.cancel(); await f.executor.stop(f.node); await rejected;
  assert.equal(f.child.inFlight(), false);
  assert.equal(fs.existsSync(path.join(f.dir, 'plan.md')), false);
});
test('a new explicit attempt cannot reuse an old direct Pi completion', async t => {
  const f = setup(t);
  await f.executor.execute(f.args);
  f.node.dispatchId += ':retry'; delete f.node.dispatched; delete f.node.ref;
  await f.executor.execute(f.args);
  assert.equal(f.calls.filter(row => row.prompt).length, 2);
});
test('an interrupted direct Pi attempt never silently replays tools after restore', async t => {
  const f = setup(t);
  f.node.directDispatchId = f.node.dispatchId; f.node.dispatched = true;
  await assert.rejects(f.executor.execute(f.args), /核对成果后重试/);
  assert.equal(f.calls.length, 0);
});

function parentAccess(f) {
  let value = f.args.accessPolicy, listener = () => {};
  f.args.parentHandle = { on(cb) { listener = cb; return () => { listener = () => {}; }; } };
  f.args.readAccessPolicy = () => value;
  return mode => { value = rules.next(mode, f.dir, value, value.revision); listener({ kind: 'permission' }); };
}
test('a parent full-access selection releases the same real Pi permission wait without another submit', async t => {
  const f = setup(t, { waitPermission: true }), change = parentAccess(f);
  const done = f.executor.execute(f.args);
  await until(() => f.node.pendingPermissions?.length);
  change('full');
  assert.equal(await done, 'Plan ready [redacted]');
  assert.equal(f.calls.filter(row => row.prompt).length, 1);
  assert.equal(f.calls.filter(row => row.access).length, 1);
  assert.equal(f.node.accessPolicy.mode, 'full');
  assert.equal(f.node.accessPolicy.workspaceRoot, f.dir);
  assert.equal(f.node.parentAccessRevision, 2);
  assert.equal(f.node.pendingPermissions.length, 0);
  assert.equal(fs.existsSync(path.join(f.dir, 'plan.md')), true);
});
test('Pi rejects an unacknowledged permission change and stops the pending tool without writing', async t => {
  const f = setup(t, { waitPermission: true, rejectChange: true }), change = parentAccess(f);
  const done = f.executor.execute(f.args), rejected = assert.rejects(done, /未能同步会话访问权限/);
  await until(() => f.node.pendingPermissions?.length); change('full'); await rejected;
  assert.equal(f.child.inFlight(), false);
  assert.equal(f.isClosed(), true);
  assert.equal(fs.existsSync(path.join(f.dir, 'plan.md')), false);
  assert.equal(f.calls.filter(row => row.prompt).length, 1);
});

test('cancelling while asynchronous admission is pending waits for its actual receipt', async t => {
  const f = setup(t, { waitPermission: true }); let admit, stopped = false;
  const original = f.child.submit;
  f.child.submit = (...args) => {
    const receipt = original(...args);
    return new Promise(resolve => { admit = () => resolve(receipt); });
  };
  const done = f.executor.execute(f.args), rejected = assert.rejects(done, /cancelled|operation denied/);
  await until(() => f.calls.some(row => row.prompt));
  f.cancel(); const stopping = f.executor.stop(f.node).then(() => { stopped = true; });
  await tick(); assert.equal(stopped, false); admit();
  await stopping; await rejected;
  assert.equal(f.calls.filter(row => row.prompt).length, 1);
  assert.equal(fs.existsSync(path.join(f.dir, 'plan.md')), false);
});

test('Pi completion waits for asynchronous parent output acknowledgement and child close', async t => {
  const f = setup(t); let acknowledge, close, published = false, finished = false;
  const saved = new Promise(resolve => { acknowledge = resolve; });
  f.args.output.consume = async () => { published = true; await saved; };
  f.child.close = () => new Promise(resolve => { close = resolve; });
  const done = f.executor.execute(f.args).then(value => { finished = true; return value; });
  await until(() => published); assert.equal(finished, false);
  acknowledge(); await until(() => Boolean(close)); assert.equal(finished, false);
  close(); assert.equal(await done, 'Plan ready [redacted]');
});

test('a dead worker stays unresolved until the exact host confirms resource reclamation', async t => {
  const f = setup(t); let reclaimed = false;
  const snapshot = f.child.snapshot;
  f.child.snapshot = () => ({ ...snapshot(), runtimeUnavailable: true });
  f.child.executionStopped = () => reclaimed;
  f.child.submit = () => ({ accepted: true, completion: Promise.reject(Error('worker lost')) });
  await assert.rejects(f.executor.execute(f.args), /worker lost/);
  assert.equal(f.isClosed(), false);
  await assert.rejects(f.executor.stop(f.node), /尚未确认回收/);
  reclaimed = true; await f.executor.stop(f.node); assert.equal(f.isClosed(), true);
});
