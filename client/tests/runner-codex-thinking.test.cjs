'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const native = require('../main/agent-runtime/native-model-catalog');
const catalog = require('../main/agent-runtime/runtime-catalog');
const { createRunnerRuntimeAdapter, getRunnerSessionDetails, _uuidV5 } = require('../main/agent-runtime/runner-adapter');
const { preference } = require('../main/conversation/model-selection');
const wait = async check => { for (let n = 0; n < 300; n++) { if (check()) return; await new Promise(r => setTimeout(r, 10)); } throw Error('Fixture did not settle'); };

async function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-codex-thinking-'));
  const app = { getPath: () => root }, alias = 'codex-reasoning-fixture';
  const ref = _uuidV5('9af442c8-cd1d-4b91-a668-22da2b2635bf', 'chat:' + alias + ':codex');
  const rows = [
    { id: 'balanced', reasoningLevels: ['low', 'medium', 'high', 'xhigh'], defaultReasoning: 'high' },
    { id: 'limited', reasoningLevels: ['low', 'high'], defaultReasoning: 'high' },
    { id: 'single', reasoningLevels: ['low'], defaultReasoning: 'low' },
    { id: 'plain', reasoningLevels: [], defaultReasoning: '' },
  ];
  t.mock.method(native, 'list', () => ({ ok: true, models: rows }));
  const calls = [], sessions = [];
  let turn = 0, hold = false, accepted = {};
  const adapter = createRunnerRuntimeAdapter({ app, runtimeSpec: catalog.runtime(options.adapterId || 'codex'),
    runnerRuntime: { async rpc(op, input) {
      calls.push({ op, input });
      if (op === 'runtime.detect') return { ok: true, data: {} };
      if (op === 'job.stop') return { ok: true, data: { ok: true } };
      if (op === 'job.dispatch') {
        turn++; accepted = { agentId: 'codex', modelName: input.cfg.codex_model, reasoningEffort: input.cfg.codex_reasoning_effort || '' };
        return { ok: true, data: { ref } };
      }
      if (op === 'job.comment') {
        turn++; accepted = input.executionSelection || accepted;
        return { ok: true, data: { ok: true, acceptedSelection: accepted } };
      }
      if (op === 'job.session') return { ok: true, data: { status: hold ? 'running' : 'done', round: turn,
        activeExecutionSelection: accepted, items: turn ? [{ seq: turn, kind: 'say', text: 'Reply ' + turn }] : [] } };
      throw Error('Unexpected fixture operation: ' + op);
    } }, modelConfig: { fetchModel: async (_identity, name) => ({ ok: true, model: { id: name } }) } });
  const open = async (resume = false, extra = {}) => {
    const session = await adapter[resume ? 'resumeSession' : 'createSession']({ native: { runner: { openOptions: {
      app, cwd: root, ref: alias, ...(resume ? { resumePath: ref } : { modelName: 'balanced' }), ...extra,
    } } } });
    sessions.push(session); return { session, handle: getRunnerSessionDetails(session).handle };
  };
  t.after(async () => { for (const session of sessions) await session.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  return { ...(await open()), app, ref, root, rows, calls, open,
    hold(value) { hold = value; },
    requests: () => calls.filter(row => ['job.dispatch', 'job.comment'].includes(row.op)) };
}

test('Codex exposes the selected native model levels, resets to the shared default and rejects unsupported efforts', async t => {
  const f = await fixture(t);
  assert.deepEqual(f.session.snapshot().thinking, { supported: true, enabled: true, level: 'medium',
    levels: ['low', 'medium', 'high', 'xhigh'], defaultLevel: 'medium' });
  assert.equal((await f.handle.setThinkingLevel('xhigh')).ok, true);
  for (const level of ['off', 'ultra', true, 'high\n']) assert.equal((await f.handle.setThinkingLevel(level)).ok, false);
  assert.equal(f.session.snapshot().thinking.level, 'xhigh');
  assert.equal((await f.handle.setThinkingLevel('')).thinking.level, 'medium');
  assert.equal((await f.handle.selectModel('limited')).thinking.level, 'high');
  assert.equal((await f.handle.selectModel('single')).thinking.level, 'low');
  assert.equal((await f.handle.selectModel('plain')).thinking.supported, false);
  assert.equal((await f.handle.setThinkingLevel('high')).ok, false);
});

test('Codex reasoning preferences survive model selection and reopening without changing legacy model records', async t => {
  const f = await fixture(t);
  assert.equal((await f.handle.setThinkingLevel('high')).ok, true);
  assert.equal((await f.handle.selectModel('limited')).thinking.level, 'high');
  await f.session.dispose();
  const restored = await f.open(true, { reasoningEffort: 'medium' });
  assert.equal(restored.session.snapshot().modelSelection.name, 'limited');
  assert.equal(restored.session.snapshot().thinking.level, 'high');
  const legacy = preference(f.app, 'legacy-only-name'); legacy.write('balanced');
  assert.equal(legacy.read(), 'balanced');
  assert.equal((await f.open(false, { ref: 'legacy', reasoningEffort: 'ultra' })).session.snapshot().thinking.level, 'medium');
});

test('each Codex queue item captures its effort and a same-model change sends executionSelection', async t => {
  const f = await fixture(t);
  f.hold(true);
  const first = f.session.send({ text: 'first' });
  await wait(() => f.requests().length === 1);
  assert.equal(f.requests()[0].input.cfg.codex_reasoning_effort, 'medium');
  assert.equal((await f.handle.setThinkingLevel('high')).ok, true);
  const second = f.session.send({ text: 'second' });
  assert.equal((await f.handle.selectModel('limited')).ok, true);
  assert.equal((await f.handle.setThinkingLevel('low')).ok, true);
  const third = f.session.send({ text: 'third' });
  assert.equal(f.requests()[0].input.ctx.agentExecution.reasoningEffort, 'medium', 'active turn keeps its admitted reasoning effort');
  f.hold(false);
  assert.equal((await first.completion).ok, true);
  assert.equal((await second.completion).ok, true);
  assert.equal((await third.completion).ok, true);
  assert.deepEqual(f.requests().map(row => row.input.cfg.codex_reasoning_effort), ['medium', 'high', 'low']);
  assert.deepEqual(f.requests().map(row => row.input.cfg.codex_model), ['balanced', 'balanced', 'limited']);
  assert.deepEqual(f.requests().slice(1).map(row => row.input.executionSelection.reasoningEffort), ['high', 'low']);
  assert.equal(f.session.snapshot().thinking.level, 'low');
  assert.equal((await f.session.send({ text: 'same choice' }).completion).ok, true);
  assert.equal(f.requests().at(-1).input.executionSelection, undefined);
});

test('failed effort persistence keeps both the saved choice and current selection intact', async t => {
  const f = await fixture(t);
  assert.equal((await f.handle.setThinkingLevel('high')).ok, true);
  t.mock.method(fs, 'renameSync', () => { throw Object.assign(Error('private profile path'), { code: 'EACCES' }); });
  const result = await f.handle.setThinkingLevel('low');
  assert.equal(result.ok, false);
  assert.doesNotMatch(result.reason, /private profile|EACCES/);
  assert.equal(f.session.snapshot().thinking.level, 'high');
  assert.equal(preference(f.app, f.ref).readSelection().reasoningEffort, 'high');
});

test('effort updates cannot race a pending model choice or revive a disposed runtime', async t => {
  const f = await fixture(t);
  let release;
  const pendingCatalog = new Promise(resolve => { release = resolve; });
  t.mock.method(native, 'list', () => pendingCatalog);
  const changing = f.handle.selectModel('limited');
  assert.equal((await f.handle.setThinkingLevel('high')).ok, false);
  await f.session.dispose();
  release({ ok: true, models: f.rows });
  assert.equal((await changing).ok, false);
  assert.equal((await f.handle.setThinkingLevel('high')).ok, false);
  assert.equal(preference(f.app, f.ref).read(), 'balanced');
});

test('non-Codex Runner sessions do not gain a Codex effort contract', async t => {
  const f = await fixture(t, { adapterId: 'qwen' });
  assert.equal(f.session.snapshot().thinking, undefined);
  assert.equal((await f.handle.setThinkingLevel('high')).ok, false);
});
