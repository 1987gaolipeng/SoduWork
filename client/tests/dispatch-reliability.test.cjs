'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs');
const path = require('node:path');
const vm = require('node:vm');
const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');

function fixture(receipt, method = 'dispatchToAI', options = {}) {
  const calls = [], diagnostics = [], scope = {}, values = new Map(), ctx = {
    document: {readyState: 'loading', addEventListener() {},
      getElementById: id => ({value: id === 'fwdNote' ? '  context  ' : 'model'})},
    addEventListener() {}, console: {log() {}, error: (...args) => diagnostics.push(args)},
    localStorage: {getItem: key => values.get(key) || null,
      setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key)},
    User: {id: 'dispatch-fixture'}, navigator: {platform: 'test'},
    URL, URLSearchParams, AbortController, FormData,
    setTimeout: () => 0, clearTimeout() {},
    fetch: async (...args) => {
      calls.push(['http', ...args]);
      if (options.failure) throw options.failure;
      return {ok: true, status: 200, text: async () => JSON.stringify(receipt)};
    },
    tasks: [{id: 'task', title: 'Report'}], detailId: 'task',
    _fwdModel: '', _fwdOptions: {}, _pickedRepo: () => null,
    _fwdSubstrateOf: () => ({modelPick: true}),
    _fwdSetBusy: (...args) => calls.push(['busy', ...args]),
    _fwdSetStatus: (...args) => calls.push(['status', ...args]),
    _closeFwd: () => calls.push(['close']), petSay: text => calls.push(['notice', text]),
    render: () => calls.push(['render']), Store: {dropTask: id => calls.push(['drop', id])},
    SoduWorkAPI: {[method]: async (...args) => { calls.push(['request', ...args]); return receipt; }},
    RequirementAssignment: {scope: () => scope, inScope: value => value === scope,
      completed: async (...args) => calls.push(['completed', ...args])},
    RequirementsDetail: {close: () => calls.push(['detail-close'])},
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(read('components', 'pet', 'pet-ui.js'), ctx);
  ctx.petSay = text => calls.push(['notice', text]);
  if (options.transport) {
    if (options.transport === 'queue') ctx.NativeChat = {enqueueTask: async (...args) => {
      calls.push(['enqueue', ...args]);
      if (options.failure) throw options.failure;
      return receipt;
    }};
    for (const file of ['core/api-work-plugins.js', 'api.js']) {
      vm.runInContext(require('node:fs').readFileSync(path.join(__dirname, '..', file), 'utf8'), ctx, {filename: file});
    }
  }
  vm.runInContext(read('components', 'panels', 'panels-forward.js'), ctx);
  return {ctx, calls, scope, diagnostics};
}

for (const [receipt, expected] of [
  [{ok: true, pending: true}, /正在确认接单.*勿重复/],
  [{ok: true, already: true}, /已经在处理/],
  [{ok: true}, /已交给/],
]) test('dispatch follows the authoritative receipt: ' + JSON.stringify(receipt), async () => {
  const {ctx, calls, scope} = fixture(receipt);
  await ctx._dispatchAITo('task', {id: 'pi'}, 'Pi');
  assert.match(calls.find(row => row[0] === 'notice')[1], expected);
  assert.deepEqual(calls.filter(row => row[0] === 'completed'), [['completed', 'task', scope, '']]);
  assert.equal(calls.filter(row => row[0] === 'request').length, 1);
  assert.equal(calls.find(row => row[0] === 'request')[3], 'context');
  assert.equal(calls.filter(row => row[0] === 'close').length, 1);
});

test('accepted dispatch opens its returned conversation and navigation failure cannot be reported as failed dispatch', async () => {
  const {ctx, calls, scope} = fixture({ok:true, conversationId:'accepted-session'});
  ctx.RequirementAssignment.completed = async (...args) => {calls.push(['completed', ...args]); throw Error('navigation failed');};
  await ctx._dispatchAITo('task', {id:'local:pi'}, 'Pi');
  assert.deepEqual(calls.find(row => row[0] === 'completed'), ['completed', 'task', scope, 'accepted-session']);
  assert.equal(calls.some(row => row[0] === 'status' && row[2] === true), false);
  assert.match(calls.at(-1)[1], /需求已派发.*暂未打开/);
});

for (const method of ['dispatchToAI', 'handoffTask']) test(method + ' keeps the arrangement open on business failure', async () => {
  const {ctx, calls} = fixture({ok: false, reason: 'Runner unavailable'}, method);
  if (method === 'dispatchToAI') await ctx._dispatchAITo('task', {id: 'pi'}, 'Pi');
  else await ctx._handoffTo('task', 'colleague', 'Colleague');
  assert.equal(calls.some(row => ['close', 'completed', 'drop', 'detail-close'].includes(row[0])), false);
  assert.deepEqual(calls.at(-2), ['busy', false]);
  assert.deepEqual(calls.at(-1), ['status', 'Runner unavailable', true]);
});

for (const transport of ['queue', 'http']) for (const field of ['reason', 'error', 'message']) {
  test(transport + ' dispatch preserves an explicit ' + field + ' through the API and real error presenter', async () => {
    const reason = '需求会话未能打开，请检查本机模型配置后重试';
    const {ctx, calls, diagnostics} = fixture({ok: false, [field]: reason}, 'dispatchToAI', {transport});
    await ctx._dispatchAITo('task', {id: 'local:pi', type: 'agent'}, 'Pi');
    assert.deepEqual(calls.at(-2), ['busy', false]);
    assert.deepEqual(calls.at(-1), ['status', reason, true]);
    assert.equal(calls.some(row => ['close', 'completed', 'notice'].includes(row[0])), false);
    assert.equal(calls.filter(row => row[0] === (transport === 'queue' ? 'enqueue' : 'http')).length, 1);
    if (transport === 'queue') assert.equal(calls.some(row => row[0] === 'http'), false);
    assert.equal(diagnostics.at(-1)[1].detail, reason);
  });
}

for (const failure of [new TypeError('Cannot read properties of undefined (reading secret)'),
  new Error('内部处理失败：private runtime details'), new TypeError('Failed to fetch')]) {
  test('unexpected dispatch error stays private and diagnostic: ' + failure.name + ' ' + failure.message, async () => {
    const {ctx, calls, diagnostics} = fixture(null, 'dispatchToAI', {transport: 'queue', failure});
    await ctx._dispatchAITo('task', {id: 'local:pi'}, 'Pi');
    assert.deepEqual(calls.at(-2), ['busy', false]);
    assert.deepEqual(calls.at(-1), ['status', '没有派出去', true]);
    assert.equal(calls.some(row => ['close', 'completed', 'notice'].includes(row[0])), false);
    assert.equal(diagnostics.at(-1)[1], failure);
  });
}

test('a late receipt after the arrangement scope changes cannot navigate or mutate the next account', async () => {
  const {ctx, calls} = fixture({ok: true});
  ctx.RequirementAssignment.inScope = () => false;
  await ctx._dispatchAITo('task', {id: 'pi'}, 'Pi');
  assert.equal(calls.some(row => ['close', 'completed', 'notice'].includes(row[0])), false);
});

test('confirmed coworker handoff drops only the handed-off task and closes the drawer', async () => {
  const {ctx, calls} = fixture({ok: true}, 'handoffTask');
  await ctx._handoffTo('task', 'colleague', 'Colleague');
  assert.deepEqual(calls.filter(row => row[0] === 'drop'), [['drop', 'task']]);
  assert.equal(calls.filter(row => row[0] === 'detail-close').length, 1);
  assert.equal(ctx.detailId, null);
});

test('AI work area distinguishes ACK confirmation from a running session', () => {
  assert.match(read('components', 'panels', 'panels-desk-agent.js'), /dispatching: \{ name: '正在确认', short: '确认中'/);
  assert.match(read('components', 'panels', 'panels-aidesk-office.js'), /\['dispatching', 'running'\]\.includes\(_dkOfficePhase\(t\)\)/);
  assert.match(read('components', 'panels', 'task-trace-view.js'), /'ai\.dispatch_uncertain'/);
});
