'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const rules = require('../main/access-control/policy');
const catalog = require('../main/agent-runtime/runtime-catalog');
const { createRunnerRuntimeAdapter, getRunnerSessionDetails } = require('../main/agent-runtime/runner-adapter');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { for (let n = 0; n < 300; n++) { if (check()) return; await delay(10); } throw Error('Timed out'); }
for (const [adapterId, connectors] of [
  ['opencode', false], ['harness2', false], ['harness2', true], ['codex-harness', false], ['qwen', false],
]) test(adapterId + (connectors ? ' with connectors' : '') + ' switches only at a real next turn; preserves actual Agent and revision across legacy upgrade', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-runner-change-'));
  const capability = { schema: rules.SCHEMA, supported: true, modes: [...rules.MODES], canChangeDuringSession: true };
  let policy = null, pending = null, status = 'done', permission = [], approvalRevision, release;
  const calls = [];
  const adapter = createRunnerRuntimeAdapter({ runtimeSpec: catalog.runtime(adapterId),
    modelConfig: { fetchModel: async () => ({ ok: true, model: { id: 'fixture', key: 'fixture' } }) },
    runnerRuntime: { async rpc(op, payload) {
      calls.push({ op, payload });
      if (op === 'runtime.detect') return { ok: true, data: { accessControl: capability } };
      if (op === 'job.session') return { ok: true, data: { status, accessPolicy: policy, nextAccessPolicy: pending, accessControl: capability, items: [], pendingPermissions: permission } };
      if (op === 'job.access') {
        assert.equal(payload.expectedRevision, (pending || policy)?.revision || 0);
        pending = payload.accessPolicy;
        if (release) await release;
        return { ok: true, data: { ok: true, nextAccessPolicy: pending } };
      }
      if (op === 'job.comment') {
        policy = payload.cfg.accessPolicy; pending = null; status = 'waiting-permission';
        approvalRevision = policy.revision;
        permission = policy.mode === 'standard' ? [{ requestId: 'request-' + policy.revision, policyRevision: policy.revision, action: 'command.execute' }] : [];
        if (!permission.length) status = 'done';
        return { ok: true, data: { ok: true } };
      }
      if (op === 'job.permission') { assert.equal(payload.policyRevision, approvalRevision); permission = []; status = 'done'; return { ok: true, data: { ok: true } }; }
      if (op === 'job.stop') return { ok: true, data: { ok: true } };
      throw Error(op);
    } } });
  const session = await adapter.resumeSession({ native: { runner: { openOptions: {
    ref: 'change-test', resumePath: 'same-run', cwd: root,
    ...(connectors ? { resolveConnectors: async () => ({ guide: 'CONNECTOR-CONTEXT', servers: [] }) } : {}),
  } } } });
  const handle = getRunnerSessionDetails(session).handle;
  t.after(async () => { await session.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  await until(() => handle.snapshot().accessControl.canChangeDuringSession);
  assert.equal(handle.snapshot().adapterId, adapterId); assert.equal(handle.snapshot().displayName, catalog.runtime(adapterId).displayName);
  assert.equal((await handle.setAccessPolicy(rules.next('standard', root, null, 0), 0)).ok, true);
  assert.equal(handle.snapshot().accessPolicy, null); assert.equal(handle.snapshot().nextAccessPolicy.mode, 'standard');
  const turn = session.send({ text: 'legacy history follow-up' });
  await until(() => handle.snapshot().pendingPermissions.length);
  const request = handle.snapshot().pendingPermissions[0];
  const readonly = rules.next('readonly', root, handle.snapshot().accessPolicy, 1);
  assert.equal((await handle.setAccessPolicy(readonly, 1)).ok, true);
  assert.equal(handle.snapshot().accessPolicy.mode, 'standard'); assert.equal(handle.snapshot().nextAccessPolicy.mode, 'readonly');
  assert.equal((await handle.answerUi({ ...request, policyRevision: 2, decision: 'once' })).ok, false);
  assert.equal((await handle.answerUi({ ...request, decision: 'deny' })).ok, true); await turn.completion;
  assert.equal(handle.snapshot().accessPolicy.mode, 'standard');
  await session.send({ text: 'readonly turn' }).completion;
  assert.ok(calls.filter(row => row.op === 'job.comment').at(-1).payload.promptText.includes(
    require('../main/conversation/agent-contract').READ_ONLY), 'conversation rules follow the effective next-turn permission');
  if (connectors) assert.match(calls.filter(row => row.op === 'job.comment').at(-1).payload.promptText, /CONNECTOR-CONTEXT/);
  assert.equal(handle.snapshot().accessPolicy.mode, 'readonly'); assert.equal(handle.snapshot().accessPolicy.revision, 2);
  assert.equal(handle.snapshot().nextAccessPolicy, null);
  assert.equal((await handle.answerUi({ ...request, decision: 'once' })).ok, false);
  let acknowledge; release = new Promise(resolve => { acknowledge = resolve; });
  const changing = handle.setAccessPolicy(rules.next('full', root, readonly, 2), 2);
  const queued = session.send({ text: 'wait for persisted selection' });
  await delay(30); assert.equal(calls.filter(row => row.op === 'job.comment').length, 2);
  acknowledge(); await changing; await queued.completion;
  assert.equal(calls.filter(row => row.op === 'job.comment').at(-1).payload.cfg.accessPolicy.mode, 'full');
  assert.equal(calls.filter(row => row.op === 'job.comment').at(-1).payload.promptText.includes(
    require('../main/conversation/agent-contract').READ_ONLY), false, 'upgrading permission removes the old read-only instruction');
  assert.equal(calls.filter(row => row.op === 'job.comment').every(row => row.payload.ref === 'same-run'), true);
});

test('old Runner sessions still execute but cannot advertise mid-session permission changes', async t => {
  const adapter = createRunnerRuntimeAdapter({
    modelConfig: { fetchModel: async () => ({ ok: true, model: { id: 'fixture', key: 'fixture' } }) },
    runnerRuntime: { async rpc(op) {
      if (op === 'runtime.detect') return { ok: true, data: { accessControl: { schema: rules.SCHEMA, supported: true, modes: [...rules.MODES] } } };
      if (op === 'job.session') return { ok: true, data: { status: 'done', items: [] } };
      return { ok: true, data: { ok: true } };
    } } });
  const session = await adapter.resumeSession({ native: { runner: { openOptions: { cwd: os.tmpdir(), resumePath: 'legacy-old-runner' } } } });
  t.after(() => session.dispose()); const handle = getRunnerSessionDetails(session).handle;
  await until(() => handle.snapshot().status === 'idle');
  assert.equal(handle.snapshot().accessControl.canChangeDuringSession, false);
  assert.equal((await handle.setAccessPolicy(rules.create('full', os.tmpdir()), 0)).ok, false);
  assert.equal((await session.send({ text: 'compatibility followup' }).completion).ok, true);
});
