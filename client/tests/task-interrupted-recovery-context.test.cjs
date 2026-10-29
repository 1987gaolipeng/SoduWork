'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { prepare } = require('../main/pi-session/task-input');
const context = require('../main/conversation/requirement-context');
const { executionSpec } = require('../main/pi-session/controlled-task-turn');

async function fixture(t, state = 'running', rework = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-recovery-context-'));
  const workRoot = path.join(root, 'work'), cwd = path.join(workRoot, 'repo-one');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(path.join(workRoot, 'repo-two'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = { getPath: () => root };
  const identity = user => ({ hub: 'http://recovery.invalid', clientId: 'device', session:
    Buffer.from(JSON.stringify({ typ: 'device', uid: user, cid: 'device', iat: 1, exp: 9e9 })).toString('base64url') + '.' + 'a'.repeat(64) });
  let currentIdentity = identity('owner'), claims = 0, releases = 0, blocked = false;
  const turn = { executor: 'native', conversationId: 'chat', turnId: 'before-restart', state };
  const task = { id: 'task', ownerClientId: 'device', status: 'doing', projectId: 'project', repoId: 'repo',
    executionContext: { strategy: 'direct', agent: { id: 'local:qwen' }, runner: { mode: 'local' }, model: 'fixture-model' },
    workRouting: { conversationTurn: turn } };
  const repos = [{ id: 'repo', projectId: 'project', localDir: 'repo-one' }], calls = [];
  const handle = { sessionId: 'chat', adapterId: 'qwen', cwd, model: 'fixture-model', taskIds: ['task'],
    usageIdentity: { hub: currentIdentity.hub, clientId: currentIdentity.clientId },
    claimInterruptedTask: async () => { claims++; return 'exclusive-proof'; },
    releaseInterruptedTask: async (id, token) => {
      assert.equal(id, 'task'); assert.equal(token, 'exclusive-proof'); releases++; return true;
    } };
  const runtime = { app, handle, workRoot, identityOf: async () => currentIdentity };
  const requested = { reuseConversation: true, followUp: !rework, ...(rework ? { reworkSession: true } : {}) };
  t.mock.method(global, 'fetch', async (url, options) => {
    const route = new URL(url).pathname;
    const body = options?.body && JSON.parse(options.body);
    calls.push({ route, body });
    if (blocked && route.endsWith('/tasks/task')) return Response.json({ detail: 'Execution access revoked' }, { status: 403 });
    if (route.endsWith('/tasks/task')) return Response.json(task);
    if (route.endsWith('/repos')) return Response.json({ repos });
    if (route.endsWith('/attachments')) return Response.json([]);
    if (route.endsWith('/conversation-turn')) {
      assert.equal(body.turnId, turn.turnId);
      turn.state = body.action === 'start' ? 'running' : body.action === 'complete' ? 'completed' : turn.state;
      return Response.json({ turn, task });
    }
    throw Error('Unexpected fixture route: ' + route);
  });
  // Restore the real persisted conversation boundary before simulating a restart continuation.
  await context.validate({ ...runtime, identity: currentIdentity }, task, requested,
    executionSpec(task, requested), async () => ({ repos }));
  const input = await prepare(currentIdentity, 'task', 'chat', 'new-submission', 'Continue existing work', requested, runtime);
  return { input, task, repos, calls, claims: () => claims, releases: () => releases,
    account: () => { currentIdentity = identity('another-owner'); }, revoke: () => { blocked = true; } };
}

for (const state of ['queued', 'running', 'waiting']) {
  for (const rework of [false, true]) test(`fresh authorized ${state} ${rework ? 'rework' : 'original'} recovery retains the old receipt`, async t => {
    const f = await fixture(t, state, rework);
    const before = f.calls.filter(row => row.route.endsWith('/repos')).length;
    await f.input.beforeTurn();
    assert.ok(f.calls.filter(row => row.route.endsWith('/repos')).length > before,
      'recovery must refresh repository authorization before executing');
    assert.equal(f.claims(), 1); assert.equal(f.releases(), 0);
    assert.deepEqual(f.calls.filter(row => row.body).map(row => [row.body.action, row.body.turnId]),
      state === 'queued' ? [['start', 'before-restart']] : []);
  });
}

for (const change of ['read-only', 'transferred', 'hidden', 'repository', 'project', 'agent', 'remote', 'account', 'revoked', 'done', 'cancel']) {
  test(`a ${change} change after interruption proof prevents recovery and releases the claim`, async t => {
    const f = await fixture(t);
    if (change === 'read-only') f.task.readOnly = true;
    if (change === 'transferred') f.task.ownerClientId = 'another-device';
    if (change === 'hidden') f.task.canViewExecution = false;
    if (change === 'repository') f.repos[0].localDir = 'repo-two';
    if (change === 'project') f.task.projectId = 'another-project';
    if (change === 'agent') f.task.executionContext.agent.id = 'local:pi';
    if (change === 'remote') f.task.executionContext.runner.mode = 'remote';
    if (change === 'account') f.account();
    if (change === 'revoked') f.revoke();
    if (change === 'done' || change === 'cancel') f.task.status = change;
    await assert.rejects(f.input.beforeTurn());
    assert.equal(f.claims(), 1); assert.equal(f.releases(), 1);
    assert.equal(f.calls.filter(row => row.body).length, 0, 'no start or duplicate prepare may escape a failed fresh validation');
  });
}
