const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function context(api) {
  const ctx = vm.createContext({ SoduWorkAPI: api, window: { addEventListener() {} },
    esc: value => String(value), Intl, Event, document: { getElementById: () => null } });
  for (const file of ['panels-schedules-methods.js', 'panels-schedules.js', 'panels-schedules-editor.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../components/panels', file), 'utf8'), ctx);
  }
  return ctx;
}
const run = (ctx, code) => vm.runInContext(code, ctx);
const modern = { substrates: [
  { key: 'local:pi', name: 'Pi', available: true, onlineSeats: 2 },
  { key: 'local:codex', name: 'Codex', available: true },
] };

test('all automation openings share stable substrate choices and coalesce pending requests', async () => {
  let resolve, requests = 0, legacy = 0;
  const ctx = context({
    taskExecutionOptions: () => { requests++; return new Promise(r => { resolve = r; }); },
    listAIAgents: async () => { legacy++; return { agents: [] }; },
  });
  const first = run(ctx, '_schLoadExecutionAgents({title:"日报"})');
  const second = run(ctx, '_schLoadExecutionAgents({})');
  resolve(modern);
  assert.deepEqual(Array.from(await first, item => item.id), ['local:pi', 'local:codex']);
  await second;
  assert.equal(requests, 1);
  assert.equal(legacy, 0);
  assert.equal(run(ctx, '_schDefaultAgentId()'), 'local:pi');
  assert.match(run(ctx, '_schAgentOptionsHtml("local:codex")'), /value="local:codex" selected/);
});

test('empty unified result is authoritative and explains offline status', async () => {
  let legacy = 0;
  const ctx = context({ taskExecutionOptions: async () => ({
    substrates: [], availability: { agentReason: '执行机正在重连' },
  }), listAIAgents: async () => { legacy++; return { agents: [{ id: 'stale' }] }; } });
  assert.equal((await run(ctx, '_schLoadExecutionAgents({})')).length, 0);
  assert.equal(legacy, 0);
  assert.match(run(ctx, '_schAgentFieldHtml("")'), /disabled/);
  assert.match(run(ctx, '_schAgentFieldHtml("")'), /执行机正在重连/);
  assert.match(run(ctx, '_schAgentOptionsHtml("local:codex")'), /value="local:codex" selected/);
});

test('old Hub failure falls back to usable legacy agents and later recovers', async () => {
  const api = { taskExecutionOptions: async () => { throw Error('404'); },
    listAIAgents: async () => ({ agents: [{ id: 'off', off: true }, { id: 'legacy', name: 'Pi' }] }) };
  const ctx = context(api);
  assert.equal((await run(ctx, '_schLoadExecutionAgents({})'))[0].id, 'legacy');
  api.taskExecutionOptions = async () => modern;
  assert.equal((await run(ctx, '_schLoadExecutionAgents({})'))[0].id, 'local:pi');
});

test('refreshing executor options preserves an existing choice and updates only the select', async () => {
  const ctx = context({ taskExecutionOptions: async () => modern });
  await run(ctx, '_schLoadExecutionAgents({})');
  let changes = 0;
  const select = { value: 'old-seat', dispatchEvent() { changes++; } };
  const hint = {};
  ctx.document.getElementById = id => ({ schWho: select, schWhoHint: hint })[id] || null;
  run(ctx, '_schRefreshAgentField()');
  assert.match(select.innerHTML, /value="old-seat" selected/);
  assert.match(select.innerHTML, /local:pi/);
  assert.equal(select.disabled, false);
  assert.equal(changes, 1);
});

test('legacy conversation automation path uses the same execution contract', async () => {
  let body;
  const ctx = context({ taskExecutionOptions: async () => modern,
    createSchedule: async value => { body = value; } });
  ctx.petSay = () => {};
  await run(ctx, '_schmCreateAutomation("每天整理日报", {schedule:{every:"daily",atHour:9,atMinute:0,weekday:1},acceptance:"保留来源"})');
  assert.equal(body.assigneeId, 'local:pi');
  assert.match(body.note, /保留来源/);
});
