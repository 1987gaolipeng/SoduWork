'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture(inspectFailedModel) {
  let scope = 'alice:1';
  const listeners = new EventTarget();
  const box = { AbortController, SoduWorkAPI: { inspectFailedModel, failedModelScope: () => scope },
    addEventListener: listeners.addEventListener.bind(listeners), removeEventListener: listeners.removeEventListener.bind(listeners) };
  for (const name of ['model-capabilities', 'chat-model-failure']) {
    vm.runInNewContext(readFileSync(path.join(__dirname, '../components/panels/' + name + '.js'), 'utf8'), box);
  }
  const ctx = { _ref: 'chat-fixture', esc: text => String(text).replace(/</g, '&lt;') };
  let paints = 0;
  return { card: box.ChatModelFailure.create(ctx, () => paints++), paints: () => paints,
    notify(next, type = 'soduwork-data-scope-changed') { scope = next; listeners.dispatchEvent(new Event(type)); } };
}

const tick = () => new Promise(setImmediate);
const target = { provider: 'service', model: 'failed-model', phase: 'tool-result', status: 403, trace: 'a'.repeat(32) };

test('the failed-call card probes once and shows bounded per-check results', async () => {
  let checks = 0, finish;
  const f = fixture(async (_target, options) => {
    const view = { state: 'ready', service: 'Saved service', model: 'failed-model' };
    if (!options.check) return view;
    checks++;
    return new Promise(resolve => { finish = () => resolve({ ...view, report: { error: 'private-provider-body', checks: {
      toolCalling: { status: 'inconclusive', stage: 'tool_result', code: 'request_rejected', message: 'private-provider-body' },
      'private-provider-field': { status: 'private-provider-body' }
    } } }); });
  });
  assert.match(f.card.html(target), /工具结果后的模型请求.*HTTP 403/s);
  await tick();
  assert.match(f.card.html(target), /Saved service.*检测此模型的能力/s);
  const button = {};
  f.card.bind({ querySelector: () => button });
  button.onclick(); button.onclick();
  assert.equal(checks, 1);
  assert.match(f.card.html(target), /data-check-failed-model disabled/);
  finish(); await tick();
  const report = f.card.html(target);
  assert.match(report, /检测阶段：读取工具结果/);
  assert.match(report, /服务拒绝了检测请求/);
  assert.doesNotMatch(report, /private-provider/);
});

test('leaving a failed turn discards a pending catalog result', async () => {
  let finish, signal;
  const f = fixture((_target, options) => new Promise(resolve => {
    signal = options.signal;
    finish = () => resolve({ state: 'ready', service: 'obsolete' });
  }));
  f.card.html(target);
  assert.equal(f.card.html(null), '');
  assert.equal(signal.aborted, true);
  finish(); await tick();
  assert.equal(f.paints(), 0);
});

test('a mounted card clears identity and reports synchronously across account and registration changes', async () => {
  let calls = 0, finishOld, oldSignal;
  const f = fixture(async (_target, options) => {
    calls++;
    if (calls === 1) return { state: 'ready', service: 'Alice service', model: 'Alice model' };
    if (calls === 2) return { state: 'ready', service: 'Alice service', model: 'Alice model',
      report: { checks: { toolCalling: { status: 'failed', code: 'request_rejected' } } } };
    if (calls === 3) {
      oldSignal = options.signal;
      return new Promise(resolve => { finishOld = () => resolve({ state: 'ready', service: 'old private result' }); });
    }
    return { state: calls === 4 ? 'account' : 'unavailable' };
  });
  const privateData = /Alice service|Alice model|[> ]failed-model<|>service[ <]|soduwork-trace|检测结果|old private result/u;
  assert.doesNotMatch(f.card.html(target), privateData);
  await tick();
  const button = {};
  f.card.bind({ querySelector: () => button });
  button.onclick(); await tick();
  assert.match(f.card.html(target), /检测结果/);
  f.notify('alice:1', 'soduwork-device-auth');
  assert.match(f.card.html(target), /Alice service/);
  assert.equal(calls, 2, 'same-scope auth refresh retains the report');
  button.onclick();
  const paints = f.paints();
  f.notify('bob:2');
  assert.equal(oldSignal.aborted, true);
  assert.equal(f.paints(), paints + 1);
  assert.doesNotMatch(f.card.html(target), privateData);
  await tick();
  assert.match(f.card.html(target), /请使用发起该请求的账号/);
  const beforeLate = f.paints();
  finishOld(); await tick();
  assert.equal(f.paints(), beforeLate);
  assert.doesNotMatch(f.card.html(target), privateData);
  f.notify('bob:3', 'soduwork-client-auth-required');
  f.card.html(target); await tick();
  const unavailable = f.card.html(target);
  assert.match(unavailable, /当前模型目录暂不可用/);
  assert.doesNotMatch(unavailable, privateData);
});

test('company services show administrator guidance without a probe action', async () => {
  const f = fixture(async () => ({ state: 'managed', service: 'Company' }));
  f.card.html(target); await tick();
  const html = f.card.html(target);
  assert.match(html, /请联系管理员检测此企业模型/);
  assert.doesNotMatch(html, /data-check-failed-model/);
});
